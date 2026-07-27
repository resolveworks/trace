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
const sharedSource = write(
  rootA,
  "shared.ts",
  "export function sharedEnvironmentValue(): number { return 10; }\n",
);
write(rootA, ".gitignore", "ignored.ts\nnode_modules/\n.venv/\n");
const ignored = write(rootA, "ignored.ts", "export function ignoredSymbol() {}\n");
const dependencyPhysical = write(
  rootA,
  "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js",
  [
    "export function dependencyValue() {",
    "  return 1;",
    "}",
    "",
    "export function sharedEnvironmentValue() {",
    "  return 20;",
    "}",
    "",
    "export function dependencyCaller() {",
    "  return sharedEnvironmentValue();",
    "}",
    "",
  ].join("\n"),
);
const dependencyDirectory = path.join(rootA, "node_modules", "dep");
fs.symlinkSync(path.dirname(dependencyPhysical), dependencyDirectory, "dir");
const dependencyLogical = path.join(dependencyDirectory, "index.js");
const venvModule = write(
  rootA,
  ".venv/lib/python3.12/site-packages/pkg/mod.py",
  "def environment_value():\n    return 12\n",
);
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

  console.log("\nDependency environments...");
  const dependencyDefinition = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyDirectory },
    rootA,
  );
  assert(
    resultText(dependencyDefinition).includes(
      `function_declaration dependencyValue in ${dependencyLogical}:1-3`,
    ) && !resultText(dependencyDefinition).includes(dependencyPhysical),
    "a pnpm package is indexed and reported through its logical symlink path",
  );

  const dependencyFileDefinition = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyLogical },
    rootA,
  );
  assert(
    resultText(dependencyFileDefinition).includes(`in ${dependencyLogical}:1-3`),
    "a dependency file can be scoped through its symlink path",
  );

  const venvDefinition = await executeTool(
    "def",
    { name: "environment_value", path: path.dirname(venvModule) },
    rootA,
  );
  const venvOutline = await executeTool("outline", { path: venvModule }, rootA);
  assert(
    resultText(venvDefinition).includes(`function_definition environment_value in ${venvModule}`) &&
      resultText(venvOutline).includes("environment_value (function)"),
    "a gitignored virtual environment remains indexable",
  );

  const projectSharedDefinition = await executeTool(
    "def",
    { name: "sharedEnvironmentValue" },
    rootA,
  );
  const dependencySharedDefinition = await executeTool(
    "def",
    { name: "sharedEnvironmentValue", path: dependencyDirectory },
    rootA,
  );
  const nodeModulesSharedDefinition = await executeTool(
    "def",
    { name: "sharedEnvironmentValue", path: path.join(rootA, "node_modules") },
    rootA,
  );
  assert(
    resultText(projectSharedDefinition).includes(`in ${sharedSource}:1`) &&
      !resultText(projectSharedDefinition).includes(dependencyLogical) &&
      (projectSharedDefinition.details as { definitions: unknown[] }).definitions.length === 1,
    "project-scoped definitions exclude dependency environments",
  );
  assert(
    resultText(dependencySharedDefinition).includes(`in ${dependencyLogical}:5-7`) &&
      !resultText(dependencySharedDefinition).includes(sharedSource),
    "dependency-scoped definitions include the dependency definition",
  );
  assert(
    resultText(nodeModulesSharedDefinition).includes(`in ${dependencyLogical}:5-7`),
    "a scope at the environment directory includes dependency definitions",
  );

  const projectSharedCallers = await executeTool(
    "callers",
    { name: "sharedEnvironmentValue" },
    rootA,
  );
  assert(
    resultText(projectSharedCallers) === 'No callers found for "sharedEnvironmentValue"',
    "project-scoped callers exclude call sites in dependency environments",
  );

  const projectOutline = await executeTool("outline", {}, rootA);
  assert(
    resultText(projectOutline).includes(`${sharedSource}:`) &&
      !resultText(projectOutline).includes(dependencyLogical) &&
      !resultText(projectOutline).includes(venvModule),
    "project-scoped outlines exclude dependency environment files",
  );

  fs.writeFileSync(
    dependencyPhysical,
    "export function dependencyValue() {\n  const updated = 2;\n  return updated;\n}\n",
  );
  await eventually(async () => {
    const result = await executeTool(
      "def",
      { name: "dependencyValue", path: dependencyDirectory },
      rootA,
    );
    return (
      resultText(result).includes(`in ${dependencyLogical}:1-4`) &&
      resultText(result).includes("   3 |   return updated;")
    );
  }, "watcher reindexes dependency changes through the logical scope");
  await rejects(
    () => executeTool("def", { name: "dependencyValue", path: dependencyPhysical }, rootA),
    /file is not indexed/,
    "dependency events do not create physical .pnpm index rows",
  );

  fs.rmSync(path.dirname(dependencyPhysical), { recursive: true, force: true });
  await eventually(async () => {
    const result = await executeTool("def", { name: "dependencyValue" }, rootA);
    return resultText(result) === 'No definition found for "dependencyValue"';
  }, "watcher removes dependency symbols when their physical package is deleted");

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
    new RegExp(`outside indexed roots:.*roots: ${rootA}, ${rootB}`),
    "an outside-roots error lists the indexed roots",
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
