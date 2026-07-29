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
const dependencyAlias = write(
  rootA,
  "node_modules/dep-alias/index.js",
  fs.readFileSync(dependencyPhysical, "utf-8"),
);
const venvModule = write(
  rootA,
  ".venv/lib/python3.12/site-packages/pkg/mod.py",
  "def environment_value():\n    return 12\n",
);
write(rootB, "b.ts", "export function target(): number { return 2; }\n");
const linkedSource = write(home, "linked/source.ts", "export function linkedSymbol() {}\n");
const sourceSymlink = path.join(rootA, "linked.ts");
fs.symlinkSync(linkedSource, sourceSymlink);
fs.mkdirSync(path.join(rootA, "nested", "deep"), { recursive: true });
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

  await rejects(
    () => executeTool("def", { name: "linkedSymbol", path: sourceSymlink }, rootA),
    /file is not indexed/,
    "file symlinks are not indexed without a watchable logical directory",
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

  const originalCopyDefinition = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyLogical },
    rootA,
  );
  const aliasCopyDefinition = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyAlias },
    rootA,
  );
  assert(
    resultText(originalCopyDefinition).includes(`in ${dependencyLogical}:1-3`) &&
      !resultText(originalCopyDefinition).includes(dependencyAlias) &&
      resultText(aliasCopyDefinition).includes(`in ${dependencyAlias}:1-3`) &&
      !resultText(aliasCopyDefinition).includes(dependencyLogical),
    "identical content remains independently queryable at each logical path",
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

  write(
    rootA,
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js",
    "export function dependencyValue() {\n  return 3;\n}\n\nexport function restoredDependency() {}\n",
  );
  const deepPhysical = write(
    rootA,
    "node_modules/.pnpm/dep@1.0.0/node_modules/dep/lib/deep.js",
    "export function deepDependencySymbol() {}\n",
  );
  const deepLogical = path.join(dependencyDirectory, "lib", "deep.js");
  fs.unlinkSync(dependencyDirectory);
  fs.symlinkSync(path.dirname(dependencyPhysical), dependencyDirectory, "dir");
  await eventually(async () => {
    const result = await executeTool(
      "def",
      { name: "restoredDependency", path: dependencyDirectory },
      rootA,
    );
    return resultText(result).includes(`in ${dependencyLogical}:5`);
  }, "replacing a dependency symlink target refreshes the logical dependency rows");
  await eventually(async () => {
    const result = await executeTool(
      "def",
      { name: "deepDependencySymbol", path: dependencyDirectory },
      rootA,
    );
    return (
      resultText(result).includes(`in ${deepLogical}:1`) &&
      !resultText(result).includes(deepPhysical)
    );
  }, "a new deep file behind the dependency symlink is indexed through its logical path");

  fs.writeFileSync(
    dependencyPhysical,
    "export function dependencyValue() {\n  return 4;\n}\n\nexport function restoredDependency() {\n  return 8;\n}\n",
  );
  await eventually(async () => {
    const result = await executeTool(
      "def",
      { name: "restoredDependency", path: dependencyDirectory },
      rootA,
    );
    return (
      resultText(result).includes(`in ${dependencyLogical}:5-7`) &&
      resultText(result).includes("   6 |   return 8;")
    );
  }, "the root of a replaced directory symlink remains watched");

  fs.writeFileSync(deepPhysical, "export function deepDependencySymbol() {\n  return 42;\n}\n");
  await eventually(async () => {
    const result = await executeTool(
      "def",
      { name: "deepDependencySymbol", path: dependencyDirectory },
      rootA,
    );
    return (
      resultText(result).includes(`in ${deepLogical}:1-3`) &&
      resultText(result).includes("   2 |   return 42;")
    );
  }, "a deep change behind the dependency symlink reindexes the logical path");
  await rejects(
    () => executeTool("def", { name: "deepDependencySymbol", path: deepPhysical }, rootA),
    /file is not indexed/,
    "deep dependency events do not create physical .pnpm index rows",
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

  console.log("\nDirectory topology...");
  const created = path.join(rootA, "created");
  fs.mkdirSync(path.join(created, "inner"), { recursive: true });
  fs.writeFileSync(path.join(created, "fresh.ts"), "export function freshSymbol() {}\n");
  fs.writeFileSync(path.join(created, "inner", "inner.ts"), "export function innerSymbol() {}\n");
  await eventually(async () => {
    const result = await executeTool("def", { name: "freshSymbol" }, rootA);
    return resultText(result).includes("function_declaration freshSymbol");
  }, "a new directory already containing a source file is indexed");
  await eventually(async () => {
    const result = await executeTool("def", { name: "innerSymbol" }, rootA);
    return resultText(result).includes("function_declaration innerSymbol");
  }, "a nested file inside a newly created directory tree is indexed");

  const nestedFile = path.join(rootA, "nested", "deep", "nested.ts");
  fs.writeFileSync(nestedFile, "export function nestedSymbol() {}\n");
  await eventually(async () => {
    const result = await executeTool("def", { name: "nestedSymbol" }, rootA);
    return resultText(result).includes("function_declaration nestedSymbol");
  }, "a file added in a watched nested directory is indexed");
  fs.writeFileSync(nestedFile, "export function renamedNestedSymbol() {}\n");
  await eventually(async () => {
    const oldResult = await executeTool("def", { name: "nestedSymbol" }, rootA);
    const newResult = await executeTool("def", { name: "renamedNestedSymbol" }, rootA);
    return (
      resultText(oldResult) === 'No definition found for "nestedSymbol"' &&
      resultText(newResult).includes("function_declaration renamedNestedSymbol")
    );
  }, "a change in a watched nested directory is reindexed");
  fs.unlinkSync(nestedFile);
  await eventually(async () => {
    const result = await executeTool("def", { name: "renamedNestedSymbol" }, rootA);
    return resultText(result) === 'No definition found for "renamedNestedSymbol"';
  }, "a deletion in a watched nested directory is removed");

  fs.rmSync(created, { recursive: true, force: true });
  await eventually(async () => {
    const fresh = await executeTool("def", { name: "freshSymbol" }, rootA);
    const inner = await executeTool("def", { name: "innerSymbol" }, rootA);
    return (
      resultText(fresh) === 'No definition found for "freshSymbol"' &&
      resultText(inner) === 'No definition found for "innerSymbol"'
    );
  }, "deleting a populated directory removes all of its indexed files");

  const staging = path.join(home, "staging");
  write(staging, "incoming/pack/moved.ts", "export function movedSymbol() {}\n");
  const movedFile = path.join(rootA, "incoming", "pack", "moved.ts");
  fs.renameSync(path.join(staging, "incoming"), path.join(rootA, "incoming"));
  await eventually(async () => {
    const result = await executeTool("def", { name: "movedSymbol" }, rootA);
    return resultText(result).includes(`function_declaration movedSymbol in ${movedFile}:1`);
  }, "a populated directory moved into the root is indexed");
  fs.writeFileSync(movedFile, "export function movedSymbol() {\n  return 7;\n}\n");
  await eventually(async () => {
    const result = await executeTool("def", { name: "movedSymbol" }, rootA);
    return resultText(result).includes(`in ${movedFile}:1-3`);
  }, "changes inside a moved-in directory are watched");
  fs.renameSync(path.join(rootA, "incoming"), path.join(staging, "departed"));
  await eventually(async () => {
    const result = await executeTool("def", { name: "movedSymbol" }, rootA);
    return resultText(result) === 'No definition found for "movedSymbol"';
  }, "moving a populated directory out of the root removes its indexed files");

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

  console.log("\n.gitignore lifecycle...");
  const gitignore = path.join(rootA, ".gitignore");
  const originalGitignore = fs.readFileSync(gitignore, "utf-8");
  fs.writeFileSync(gitignore, `${originalGitignore}empty.ts\n`);
  await eventually(async () => {
    try {
      await executeTool("outline", { path: empty }, rootA);
      return false;
    } catch (error) {
      return /file is not indexed/.test(String(error));
    }
  }, "a newly gitignored file disappears from the index");

  fs.writeFileSync(gitignore, originalGitignore.replace("ignored.ts\n", ""));
  await eventually(async () => {
    const result = await executeTool("def", { name: "ignoredSymbol" }, rootA);
    return resultText(result).includes("function_declaration ignoredSymbol");
  }, "a newly unignored file appears in the index");
  await eventually(async () => {
    const result = await executeTool("outline", { path: empty }, rootA);
    return resultText(result) === `No symbols found in "${empty}"`;
  }, "removing the ignore rule restores the previously ignored file");

  fs.writeFileSync(gitignore, originalGitignore);
  await eventually(async () => {
    const result = await executeTool("def", { name: "ignoredSymbol" }, rootA);
    return resultText(result) === 'No definition found for "ignoredSymbol"';
  }, "restoring the .gitignore re-ignores its files");

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
