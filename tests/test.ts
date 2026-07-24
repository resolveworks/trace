import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import traceExtension from "../extensions/index.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

async function rejects(action: () => Promise<unknown>, pattern: RegExp, message: string) {
  try {
    await action();
    assert(false, message);
  } catch (error) {
    assert(pattern.test(String(error)), message);
  }
}

async function eventually(action: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      if (await action()) {
        assert(true, message);
        return;
      }
    } catch {
      // Queries can fail while a filesystem event is still in flight.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(false, message);
}

function write(root: string, file: string, content: string): string {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const tools = new Map<string, ToolDefinition>();
traceExtension({
  registerTool(tool: ToolDefinition) {
    tools.set(tool.name, tool);
  },
} as unknown as ExtensionAPI);

async function executeTool(
  name: string,
  params: Record<string, unknown>,
  cwd: string,
): Promise<AgentToolResult<unknown>> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool was not registered: ${name}`);
  return tool.execute("test-call", params, undefined, undefined, {
    cwd,
  } as unknown as ExtensionContext);
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

let daemonLog = "";

async function startDaemon(socket: string): Promise<ChildProcessWithoutNullStreams> {
  const daemon = spawn(process.execPath, [path.resolve("src/daemon.ts")], {
    env: process.env,
    stdio: "pipe",
  });
  daemon.stdout.setEncoding("utf-8");
  daemon.stderr.setEncoding("utf-8");
  daemon.stdout.on("data", (chunk: string) => (daemonLog += chunk));
  daemon.stderr.on("data", (chunk: string) => (daemonLog += chunk));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socket)) return daemon;
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`daemon exited during startup:\n${daemonLog}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  daemon.kill("SIGKILL");
  throw new Error(`daemon did not start:\n${daemonLog}`);
}

async function stopDaemon(daemon: ChildProcessWithoutNullStreams): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = once(daemon, "exit");
  daemon.kill("SIGTERM");
  const force = setTimeout(() => daemon.kill("SIGKILL"), 3_000);
  await exited;
  clearTimeout(force);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
const home = path.join(temporary, "home");
const rootA = path.join(home, "workspace", "root-a");
const rootB = path.join(home, "workspace", "root-b");
const configDirectory = path.join(home, ".pi", "agent");
const socket = path.join(configDirectory, "extensions", "trace", "trace.sock");
const originalEnvironment = {
  HOME: process.env.HOME,
  TRACE_PATH: process.env.TRACE_PATH,
  TRACE_DB: process.env.TRACE_DB,
  TRACE_SOCKET: process.env.TRACE_SOCKET,
};

fs.mkdirSync(rootA, { recursive: true });
fs.mkdirSync(rootB, { recursive: true });
const source = write(
  rootA,
  "src/a.ts",
  [
    "export function target(value: number): number {",
    "  return value + 1;",
    "}",
    "",
    "export class Counter {",
    "  increment(value: number): number {",
    "    return target(value);",
    "  }",
    "}",
    "",
  ].join("\n"),
);
const empty = write(rootA, "empty.ts", "// indexed, with no symbols\n");
write(rootA, ".gitignore", "ignored.ts\n");
const ignored = write(rootA, "ignored.ts", "export function ignoredSymbol() {}\n");
write(rootB, "b.ts", "export function target(): number { return 2; }\n");
fs.mkdirSync(configDirectory, { recursive: true });
fs.writeFileSync(
  path.join(configDirectory, "trace.json"),
  JSON.stringify({ roots: [rootA, rootB] }),
);

process.env.HOME = home;
delete process.env.TRACE_PATH;
delete process.env.TRACE_DB;
delete process.env.TRACE_SOCKET;

let daemon: ChildProcessWithoutNullStreams | null = null;
try {
  daemon = await startDaemon(socket);

  console.log("Core tool contract...");
  const definition = await executeTool("def", { name: "target" }, rootA);
  const expectedDefinition = [
    '1 definition of "target":',
    "",
    `function_declaration target in ${source}:1-3`,
    "   1 | export function target(value: number): number {",
    "   2 |   return value + 1;",
    "   3 | }",
  ].join("\n");
  assert(
    resultText(definition) === expectedDefinition &&
      (definition.details as { definitions: unknown[] }).definitions.length === 1,
    "def uses cwd scope and returns the complete body",
  );

  const callers = await executeTool("callers", { name: "target", path: "src/a.ts" }, rootA);
  assert(
    resultText(callers) ===
      `${source}:7 — called in increment (method_definition)\n   7 |     return target(value);`,
    "callers resolves a relative path and reports source context",
  );

  const outline = await executeTool("outline", { path: path.dirname(source) }, rootB);
  assert(
    resultText(outline) ===
      [
        `${source}:`,
        "  target (function) — 1-3",
        "  Counter (class) — 5-9",
        "    increment (method) — 6-8",
      ].join("\n"),
    "outline accepts an absolute directory and renders nested symbols",
  );

  console.log("\nFilesystem lifecycle...");
  const changing = path.join(rootA, "changing.ts");
  fs.writeFileSync(changing, "export function addedSymbol() {}\n");
  await eventually(async () => {
    const result = await executeTool("def", { name: "addedSymbol" }, rootA);
    return resultText(result).includes("function_declaration addedSymbol");
  }, "watcher exposes an added symbol");

  fs.writeFileSync(changing, "export function changedSymbol() {}\n");
  await eventually(async () => {
    const oldResult = await executeTool("def", { name: "addedSymbol" }, rootA);
    const newResult = await executeTool("def", { name: "changedSymbol" }, rootA);
    return (
      resultText(oldResult) === 'No definition found for "addedSymbol"' &&
      resultText(newResult).includes("function_declaration changedSymbol")
    );
  }, "watcher replaces changed symbols");

  fs.unlinkSync(changing);
  await eventually(async () => {
    const result = await executeTool("def", { name: "changedSymbol" }, rootA);
    return resultText(result) === 'No definition found for "changedSymbol"';
  }, "watcher removes deleted symbols");

  console.log("\nScope and failure contract...");
  const emptyOutline = await executeTool("outline", { path: empty }, rootA);
  assert(
    resultText(emptyOutline) === `No symbols found in "${empty}"`,
    "an indexed file may have no symbols",
  );
  await rejects(
    () => executeTool("outline", { path: ignored }, rootA),
    /file is not indexed/,
    "a gitignored file is unindexed",
  );
  await rejects(
    () => executeTool("outline", { path: home }, rootA),
    /outside TRACE_PATH/,
    "a scope outside configured roots fails",
  );

  await stopDaemon(daemon);
  daemon = null;
  await rejects(
    () => executeTool("outline", {}, rootA),
    /ENOENT|ECONNREFUSED/,
    "daemon unavailability is a hard error",
  );
} finally {
  if (daemon) await stopDaemon(daemon);
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
