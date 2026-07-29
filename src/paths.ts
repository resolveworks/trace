import * as path from "node:path";

function stateDirectory(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME;
  if (!home) throw new Error("HOME is required");
  return path.join(home, ".pi", "agent", "extensions", "trace");
}

export function getTraceSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.TRACE_SOCKET) return path.resolve(environment.TRACE_SOCKET);
  return path.join(stateDirectory(environment), "trace.sock");
}

export function getTraceDbPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.TRACE_DB) return path.resolve(environment.TRACE_DB);
  return path.join(stateDirectory(environment), "index.sqlite");
}
