import * as fs from "node:fs";
import * as path from "node:path";

export function getTraceRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configured = environment.TRACE_PATH;
  if (!configured) throw new Error("TRACE_PATH is required");

  const roots = configured.split(path.delimiter).map((entry) => {
    if (!entry) throw new Error("TRACE_PATH contains an empty entry");
    if (!path.isAbsolute(entry)) throw new Error(`TRACE_PATH entries must be absolute: ${entry}`);
    const root = fs.realpathSync(entry);
    if (!fs.statSync(root).isDirectory())
      throw new Error(`TRACE_PATH entry is not a directory: ${entry}`);
    return root;
  });

  if (new Set(roots).size !== roots.length) throw new Error("TRACE_PATH contains duplicate roots");
  for (let index = 0; index < roots.length; index++) {
    for (let other = index + 1; other < roots.length; other++) {
      if (contains(roots[index], roots[other]) || contains(roots[other], roots[index])) {
        throw new Error(`TRACE_PATH roots overlap: ${roots[index]} and ${roots[other]}`);
      }
    }
  }
  return roots;
}

export function getTraceSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.TRACE_SOCKET) return path.resolve(environment.TRACE_SOCKET);
  const runtime = environment.XDG_RUNTIME_DIR;
  if (!runtime) throw new Error("XDG_RUNTIME_DIR is required when TRACE_SOCKET is not set");
  return path.join(runtime, "trace", "trace.sock");
}

export function getTraceDbPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.TRACE_DB) return path.resolve(environment.TRACE_DB);
  const home = environment.HOME;
  if (!home) throw new Error("HOME is required when TRACE_DB is not set");
  const state = environment.XDG_STATE_HOME ?? path.join(home, ".local", "state");
  return path.join(state, "trace", "index.sqlite");
}

export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
