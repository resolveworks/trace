import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Value } from "typebox/value";
import { getTraceDbPath, getTraceRoots, getTraceSocketPath, contains } from "./config.ts";
import { isPathMissing } from "./fs-errors.ts";
import { closeDb, findCallers, findDefinition, getOutline, openDb, syncRoots } from "./db.ts";
import { closeIndexer, initializeIndexer, reconcileDirectory, reconcileFile } from "./indexer.ts";
import { closeLanguages } from "./languages.ts";
import { ProjectFilter } from "./project-filter.ts";
import {
  TraceRequestSchema,
  type TraceRequest,
  type TraceResponse,
  type TraceResult,
} from "./protocol.ts";

interface RootContext {
  id: number;
  path: string;
  filter: ProjectFilter;
}

class RequestError extends Error {}

export class TraceServer {
  private readonly socketPath: string;
  private readonly databasePath: string;
  private readonly rootPaths: string[];
  private roots: RootContext[] = [];
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

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
    if (this.server) {
      const closing = new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of this.sockets) socket.destroy();
      await closing;
      this.server = null;
    }
    closeDb();
    closeIndexer();
    closeLanguages();
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
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
    const { scope, includeEnvironments } = this.reconcileScope(request.scope);
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

  private reconcileScope(requested: string): {
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
        `scope is outside configured roots: ${scope} (roots: ${this.rootPaths.join(", ")})`,
      );
    }

    root.filter.invalidate();
    const includeEnvironments = root.filter.isEnvironmentPath(scope);
    if (isFile) {
      if (!reconcileFile(root.id, root.filter, scope)) {
        throw new RequestError(`file is not accepted source: ${scope}`);
      }
    } else if (reconcileDirectory(root.id, root.filter, scope) === 0 && scope !== root.path) {
      throw new RequestError(`directory contains no accepted source files: ${scope}`);
    }
    return { scope, includeEnvironments };
  }
}
