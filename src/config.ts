import * as fs from "node:fs";
import * as path from "node:path";

interface TraceConfig {
  roots?: string[];
}

function readTraceConfig(environment: NodeJS.ProcessEnv): TraceConfig {
  const home = environment.HOME;
  if (!home) return {};
  const file = path.join(home, ".pi", "agent", "trace.json");
  if (!fs.existsSync(file)) return {};
  const config: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const { roots } = config as Record<string, unknown>;
  if (
    roots !== undefined &&
    (!Array.isArray(roots) || roots.some((root) => typeof root !== "string"))
  ) {
    throw new Error(`${file}: roots must be an array of strings`);
  }
  return { roots } as TraceConfig;
}

function stateDirectory(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME;
  if (!home) throw new Error("HOME is required");
  return path.join(home, ".pi", "agent", "extensions", "trace");
}

export function getTraceRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configured = environment.TRACE_PATH
    ? environment.TRACE_PATH.split(path.delimiter)
    : readTraceConfig(environment).roots;
  if (!configured || configured.length === 0) {
    throw new Error("trace roots are required: set TRACE_PATH or roots in ~/.pi/agent/trace.json");
  }

  const roots = configured.map((entry) => {
    if (!entry) throw new Error("trace roots contain an empty entry");
    if (!path.isAbsolute(entry)) throw new Error(`trace roots must be absolute: ${entry}`);
    const root = fs.realpathSync(entry);
    if (!fs.statSync(root).isDirectory())
      throw new Error(`trace root is not a directory: ${entry}`);
    return root;
  });

  if (new Set(roots).size !== roots.length) throw new Error("trace roots contain duplicates");
  for (let index = 0; index < roots.length; index++) {
    for (let other = index + 1; other < roots.length; other++) {
      if (contains(roots[index], roots[other]) || contains(roots[other], roots[index])) {
        throw new Error(`trace roots overlap: ${roots[index]} and ${roots[other]}`);
      }
    }
  }
  return roots;
}

export function getTraceSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.TRACE_SOCKET) return path.resolve(environment.TRACE_SOCKET);
  return path.join(stateDirectory(environment), "trace.sock");
}

export function getTraceDbPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.TRACE_DB) return path.resolve(environment.TRACE_DB);
  return path.join(stateDirectory(environment), "index.sqlite");
}

export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
