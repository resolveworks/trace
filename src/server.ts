import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { Value } from "typebox/value";
import { getTraceDbPath, getTraceRoots, getTraceSocketPath, contains } from "./config.ts";
import {
  closeDb,
  findCallers,
  findDefinition,
  getOutline,
  hasIndexedFileUnder,
  isIndexedFile,
  openDb,
  syncRoots,
} from "./db.ts";
import { indexRoot, reindexFile, removeFile } from "./indexer.ts";
import { ProjectFilter } from "./project-filter.ts";
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

const MAX_REQUEST_BYTES = 64 * 1024;

export class TraceServer {
  private readonly socketPath: string;
  private readonly databasePath: string;
  private readonly rootPaths: string[];
  private roots: IndexedRoot[] = [];
  private watchers: FSWatcher[] = [];
  private server: net.Server | null = null;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.socketPath = getTraceSocketPath(environment);
    this.databasePath = getTraceDbPath(environment);
    this.rootPaths = getTraceRoots(environment);
  }

  async start(): Promise<void> {
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
    if (this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
      this.server = null;
    }
    closeDb();
  }

  private async watch(root: IndexedRoot): Promise<FSWatcher> {
    const watcher = chokidar.watch(root.path, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: root.filter.watcherIgnored,
    });
    watcher.on("add", (file) => reindexFile(root.id, path.resolve(file)));
    watcher.on("change", (file) => reindexFile(root.id, path.resolve(file)));
    watcher.on("unlink", (file) => removeFile(path.resolve(file)));
    await new Promise<void>((resolve) => watcher.once("ready", resolve));
    return watcher;
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf-8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      const frame = input.slice(0, newline);

      let request: TraceRequest;
      try {
        if (input.slice(newline + 1).length > 0) {
          throw new RequestError("multiple requests on one connection");
        }
        request = this.parseRequest(frame);
        const response: TraceResponse = {
          ok: true,
          result: this.execute(request),
        };
        socket.end(JSON.stringify(response) + "\n");
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        const response: TraceResponse = { ok: false, error: error.message };
        socket.end(JSON.stringify(response) + "\n");
      }
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
    let scope: string;
    try {
      scope = fs.realpathSync(requested);
    } catch {
      throw new RequestError(`scope does not exist: ${requested}`);
    }
    const stat = fs.statSync(scope);
    const root = this.roots.find((candidate) => contains(candidate.path, scope));
    if (!root) throw new RequestError(`scope is outside TRACE_PATH: ${scope}`);

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
