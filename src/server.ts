import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Value } from "typebox/value";
import { getTraceDbPath, getTraceRoots, getTraceSocketPath, contains } from "./config.ts";
import { isPathMissing } from "./fs-errors.ts";
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
import {
  closeIndexer,
  indexRoot,
  initializeIndexer,
  reconcileFile,
  reindexFile,
} from "./indexer.ts";
import { closeLanguages } from "./languages.ts";
import { ProjectFilter } from "./project-filter.ts";
import { DirectoryWatcher } from "./watcher.ts";
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
  watcher: DirectoryWatcher;
}

class RequestError extends Error {}

/**
 * First-party directory topology and .gitignore events are debounced per
 * root so event storms collapse into one watch rebuild plus reconciliation.
 */
const STRUCTURAL_DELAY_MS = 250;

export class TraceServer {
  private readonly socketPath: string;
  private readonly databasePath: string;
  private readonly rootPaths: string[];
  private roots: IndexedRoot[] = [];
  private readonly rebuildTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;
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
    this.roots = this.rootPaths.map((root) => this.createRoot(root, rootIds.get(root)!));

    // Watches go up before the initial scan: entries created during indexing
    // are reported by their parent watchers and reconciled by event handling.
    for (const root of this.roots) {
      root.watcher.refresh();
      this.log(`trace: ${root.path}: watching ${root.watcher.watchedDirectories()} directories`);
    }
    for (const root of this.roots) {
      const result = indexRoot(root.id, root.filter);
      this.log(
        `trace: ${root.path}: ${result.files} files, ${result.changed} changed, ${result.removed} removed`,
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
    this.closed = true;
    for (const timer of this.rebuildTimers.values()) clearTimeout(timer);
    this.rebuildTimers.clear();
    for (const root of this.roots) root.watcher.close();
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

  private log(message: string): void {
    if (!this.closed) process.stdout.write(`${message}\n`);
  }

  private createRoot(rootPath: string, id: number): IndexedRoot {
    const filter = new ProjectFilter(rootPath);
    let root: IndexedRoot;
    const watcher = new DirectoryWatcher(filter, {
      onFileChanged: (file) => reindexFile(id, file),
      onFileRemoved: (file) => deleteFiles([file]),
      onStructural: (reason) => this.scheduleRebuild(root, reason),
    });
    root = { id, path: rootPath, filter, watcher };
    return root;
  }

  private scheduleRebuild(root: IndexedRoot, reason: string): void {
    if (this.closed) return;
    const pending = this.rebuildTimers.get(root.path);
    if (pending) clearTimeout(pending);
    this.rebuildTimers.set(
      root.path,
      setTimeout(() => {
        this.rebuildTimers.delete(root.path);
        this.rebuildRoot(root, reason);
      }, STRUCTURAL_DELAY_MS),
    );
  }

  /**
   * First-party root reconciliation: rebuild directory watches and rescan live
   * source without sweeping dependency snapshots. Replacement watches are
   * established before their children are scanned, so no final state is missed.
   */
  private rebuildRoot(root: IndexedRoot, reason: string): void {
    if (this.closed) return;
    root.watcher.refresh();
    const result = indexRoot(root.id, root.filter, root.path, "watch");
    this.log(
      `trace: ${root.path}: reconciled after ${reason}: ` +
        `${result.files} files, ${result.changed} changed, ${result.removed} removed, ` +
        `${root.watcher.watchedDirectories()} directories watched`,
    );
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
    const { scope, includeEnvironments } = this.resolveScope(request.scope);
    switch (request.op) {
      case "def":
        return {
          definitions: findDefinition(request.name, scope, includeEnvironments),
        };
      case "callers":
        return { callers: findCallers(request.name, scope, includeEnvironments) };
      case "outline":
        return { symbols: getOutline(scope, includeEnvironments) };
    }
  }

  private resolveScope(requested: string): {
    scope: string;
    includeEnvironments: boolean;
  } {
    const scope = path.resolve(requested);
    let stat: ReturnType<typeof fs.statSync>;
    try {
      stat = fs.statSync(scope);
    } catch (error) {
      if (!isPathMissing(error)) throw error;
      throw new RequestError(`scope does not exist: ${requested}`);
    }
    const isFile = stat.isFile();
    const isDirectory = stat.isDirectory();
    if (!isFile && !isDirectory) {
      throw new RequestError(`scope is not a file or directory: ${scope}`);
    }

    const root = this.roots.find((candidate) => contains(candidate.path, scope));
    if (!root) {
      throw new RequestError(
        `scope is outside indexed roots: ${scope} (roots: ${this.rootPaths.join(", ")})`,
      );
    }

    const includeEnvironments = root.filter.isEnvironmentPath(scope);
    if (isFile) {
      if (includeEnvironments) reconcileFile(root.id, root.filter, scope);
      if (!isIndexedFile(scope)) throw new RequestError(`file is not indexed: ${scope}`);
    } else {
      if (includeEnvironments) indexRoot(root.id, root.filter, scope);
      if (scope !== root.path && !hasIndexedFileUnder(scope, includeEnvironments)) {
        throw new RequestError(`directory is not indexed: ${scope}`);
      }
    }
    return { scope, includeEnvironments };
  }
}
