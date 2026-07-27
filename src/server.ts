import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { Value } from "typebox/value";
import { getTraceDbPath, getTraceRoots, getTraceSocketPath, contains } from "./config.ts";
import {
  closeDb,
  deleteFiles,
  findCallers,
  findDefinition,
  getOutline,
  hasIndexedFileUnder,
  isIndexedFile,
  openDb,
  syncRoots,
} from "./db.ts";
import { closeIndexer, indexRoot, initializeIndexer, reindexFile } from "./indexer.ts";
import { closeLanguages } from "./languages.ts";
import { ENV_DIRS, ProjectFilter } from "./project-filter.ts";
import {
  TraceRequestSchema,
  type TraceRequest,
  type TraceResponse,
  type TraceResult,
} from "./protocol.ts";

interface IndexedRoot {
  id: number;
  path: string;
  filter: ProjectFilter;
}

class RequestError extends Error {}

function environmentDirectory(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  const parts = relative.split(path.sep);
  const envIndex = parts.findIndex((part) => ENV_DIRS.has(part));
  return envIndex === -1 ? null : path.join(root, ...parts.slice(0, envIndex + 1));
}

export class TraceServer {
  private readonly socketPath: string;
  private readonly databasePath: string;
  private readonly rootPaths: string[];
  private roots: IndexedRoot[] = [];
  private watchers: FSWatcher[] = [];
  private readonly envRescans = new Map<string, ReturnType<typeof setTimeout>>();
  private server: net.Server | null = null;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.socketPath = getTraceSocketPath(environment);
    this.databasePath = getTraceDbPath(environment);
    this.rootPaths = getTraceRoots(environment);
  }

  async start(): Promise<void> {
    await initializeIndexer();
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    openDb(this.databasePath);

    const rootIds = syncRoots(this.rootPaths);
    this.roots = this.rootPaths.map((root) => ({
      id: rootIds.get(root)!,
      path: root,
      filter: new ProjectFilter(root),
    }));

    for (const root of this.roots) this.watchers.push(await this.watch(root));
    for (const root of this.roots) {
      const result = indexRoot(root.id, root.filter);
      process.stdout.write(
        `trace: ${root.path}: ${result.files} files, ${result.changed} changed, ${result.removed} removed\n`,
      );
    }

    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    process.stdout.write(`trace: listening on ${this.socketPath}\n`);
  }

  async close(): Promise<void> {
    for (const watcher of this.watchers) await watcher.close();
    this.watchers = [];
    for (const timeout of this.envRescans.values()) clearTimeout(timeout);
    this.envRescans.clear();
    if (this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
      this.server = null;
    }
    closeDb();
    closeIndexer();
    closeLanguages();
  }

  private async watch(root: IndexedRoot): Promise<FSWatcher> {
    const watcher = chokidar.watch(root.path, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: root.filter.watcherIgnored,
    });
    watcher.on("add", (file) => this.handleWatchEvent(root, file, false));
    watcher.on("change", (file) => this.handleWatchEvent(root, file, false));
    watcher.on("unlink", (file) => this.handleWatchEvent(root, file, true));
    await new Promise<void>((resolve) => watcher.once("ready", resolve));
    return watcher;
  }

  private handleWatchEvent(root: IndexedRoot, file: string, removed: boolean): void {
    const resolved = path.resolve(file);
    const envDir = environmentDirectory(root.path, resolved);
    if (envDir) {
      const pending = this.envRescans.get(envDir);
      if (pending) clearTimeout(pending);
      this.envRescans.set(
        envDir,
        setTimeout(() => {
          this.envRescans.delete(envDir);
          indexRoot(root.id, root.filter, envDir);
        }, 200),
      );
      return;
    }

    if (removed) deleteFiles([resolved]);
    else reindexFile(root.id, resolved);
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf-8");
    // Clients routinely vanish mid-request (timeouts, interrupts); never let a
    // connection error take down the daemon.
    socket.on("error", () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;

      let response: TraceResponse;
      try {
        response = { ok: true, result: this.execute(this.parseRequest(input.slice(0, newline))) };
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        response = { ok: false, error: error.message };
      }
      socket.end(JSON.stringify(response) + "\n");
    });
  }

  private parseRequest(frame: string): TraceRequest {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      throw new RequestError("invalid JSON request");
    }
    if (!Value.Check(TraceRequestSchema, value)) {
      const error = Value.Errors(TraceRequestSchema, value)[0];
      throw new RequestError(`invalid request: ${error?.message ?? "schema validation failed"}`);
    }
    return value;
  }

  private execute(request: TraceRequest): TraceResult {
    const scope = this.resolveScope(request.scope);
    switch (request.op) {
      case "def":
        return { definitions: findDefinition(request.name, scope) };
      case "callers":
        return { callers: findCallers(request.name, scope) };
      case "outline":
        return { symbols: getOutline(scope) };
    }
  }

  private resolveScope(requested: string): string {
    const scope = path.resolve(requested);
    let stat: ReturnType<typeof fs.statSync>;
    try {
      stat = fs.statSync(scope);
    } catch {
      throw new RequestError(`scope does not exist: ${requested}`);
    }
    const root = this.roots.find((candidate) => contains(candidate.path, scope));
    if (!root) {
      throw new RequestError(
        `scope is outside indexed roots: ${scope} (roots: ${this.rootPaths.join(", ")})`,
      );
    }

    if (stat.isFile()) {
      if (!isIndexedFile(scope)) throw new RequestError(`file is not indexed: ${scope}`);
    } else if (stat.isDirectory()) {
      if (scope !== root.path && !hasIndexedFileUnder(scope)) {
        throw new RequestError(`directory is not indexed: ${scope}`);
      }
    } else {
      throw new RequestError(`scope is not a file or directory: ${scope}`);
    }
    return scope;
  }
}
