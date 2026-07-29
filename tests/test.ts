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

function write(base: string, file: string, content: string): string {
  const target = path.join(base, file);
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
const projectA = path.join(home, "workspace", "project-a");
const projectB = path.join(home, "workspace", "project-b");
const stateDirectory = path.join(home, ".pi", "agent", "extensions", "trace");
const socket = path.join(stateDirectory, "trace.sock");
const originalEnvironment = {
  HOME: process.env.HOME,
  TRACE_DB: process.env.TRACE_DB,
  TRACE_SOCKET: process.env.TRACE_SOCKET,
};

fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });
const source = write(
  projectA,
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
const empty = write(projectA, "empty.ts", "// indexed, with no symbols\n");
const sharedSource = write(
  projectA,
  "shared.ts",
  "export function sharedEnvironmentValue(): number { return 10; }\n",
);
write(projectA, ".gitignore", "ignored.ts\nnode_modules/\n.venv/\n");
const ignored = write(projectA, "ignored.ts", "export function ignoredSymbol() {}\n");
const dependencyPhysical = write(
  projectA,
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
const dependencyDirectory = path.join(projectA, "node_modules", "dep");
fs.symlinkSync(path.dirname(dependencyPhysical), dependencyDirectory, "dir");
const dependencyLogical = path.join(dependencyDirectory, "index.js");
const dependencyAliasDirectory = path.join(projectA, "node_modules", "dep-alias");
fs.symlinkSync(path.dirname(dependencyPhysical), dependencyAliasDirectory, "dir");
const dependencyAlias = path.join(dependencyAliasDirectory, "index.js");
const venvModule = write(
  projectA,
  ".venv/lib/python3.12/site-packages/pkg/mod.py",
  "def environment_value():\n    return 12\n",
);
write(projectB, "b.ts", "export function target(): number { return 2; }\n");
const projectBehindStoreBacklink = path.join(projectB, "project");
const backlinkSource = write(
  projectBehindStoreBacklink,
  "src/backlink.ts",
  "export function backlinkSymbol() { return 1; }\n",
);
const storeBacklink = path.join(projectB, ".pnpm-store", "v11", "projects", "id");
fs.mkdirSync(path.dirname(storeBacklink), { recursive: true });
fs.symlinkSync(projectBehindStoreBacklink, storeBacklink, "dir");
const cycleNeighbor = write(
  projectA,
  "cycle/neighbor.ts",
  "export function cycleNeighborSymbol() {}\n",
);
fs.symlinkSync(projectA, path.join(projectA, "cycle", "back"), "dir");
const linkedSource = write(home, "linked/source.ts", "export function linkedSymbol() {}\n");
const sourceSymlink = path.join(projectA, "linked.ts");
fs.symlinkSync(linkedSource, sourceSymlink);
const externalSource = write(
  temporary,
  "elsewhere/external.ts",
  "export function externalSymbol() { return 42; }\n",
);
const emptyDirectory = path.join(temporary, "elsewhere/empty");
fs.mkdirSync(emptyDirectory, { recursive: true });
fs.mkdirSync(stateDirectory, { recursive: true });

process.env.HOME = home;
delete process.env.TRACE_DB;
delete process.env.TRACE_SOCKET;

let daemon: ChildProcessWithoutNullStreams | null = null;
try {
  daemon = await startDaemon(socket);

  console.log("Core tool contract...");
  const definition = await executeTool("def", { name: "target" }, projectA);
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
    () => executeTool("def", { name: "linkedSymbol", path: sourceSymlink }, projectA),
    /file is not accepted source/,
    "file symlinks are rejected",
  );

  const backlinkDefinition = await executeTool(
    "def",
    { name: "backlinkSymbol", path: projectBehindStoreBacklink },
    projectB,
  );
  assert(
    resultText(backlinkDefinition).includes(`in ${backlinkSource}:1`) &&
      !resultText(backlinkDefinition).includes(storeBacklink),
    "an excluded store backlink cannot suppress the accepted logical path",
  );
  const storeOutline = await executeTool("outline", { path: storeBacklink }, projectB);
  assert(
    resultText(storeOutline) === `No symbols found in "${storeBacklink}"`,
    ".pnpm-store logical routes remain excluded",
  );
  const cycleDefinition = await executeTool(
    "def",
    { name: "cycleNeighborSymbol", path: path.dirname(cycleNeighbor) },
    projectA,
  );
  assert(
    resultText(cycleDefinition).includes(`in ${cycleNeighbor}:1`) &&
      !resultText(cycleDefinition).includes(`${path.sep}back${path.sep}`),
    "an ancestor symlink cycle terminates without suppressing neighboring files",
  );

  const callers = await executeTool("callers", { name: "target", path: "src/a.ts" }, projectA);
  assert(
    resultText(callers) ===
      `${source}:7 — called in increment (method_definition)\n   7 |     return target(value);`,
    "callers resolves a relative path and reports source context",
  );

  const outline = await executeTool("outline", { path: path.dirname(source) }, projectB);
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
    projectA,
  );
  assert(
    resultText(dependencyDefinition).includes(
      `function_declaration dependencyValue in ${dependencyLogical}:1-3`,
    ) && !resultText(dependencyDefinition).includes(dependencyPhysical),
    "a pnpm package is indexed and reported through its logical symlink path",
  );

  const aliasDefinition = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyAlias },
    projectA,
  );
  assert(
    !resultText(dependencyDefinition).includes(dependencyAlias) &&
      resultText(aliasDefinition).includes(`in ${dependencyAlias}:1-3`) &&
      !resultText(aliasDefinition).includes(dependencyLogical),
    "two directory aliases to one package remain independently queryable",
  );

  const venvDefinition = await executeTool(
    "def",
    { name: "environment_value", path: path.dirname(venvModule) },
    projectA,
  );
  assert(
    resultText(venvDefinition).includes(`function_definition environment_value in ${venvModule}`),
    "a gitignored virtual environment remains indexable",
  );

  const projectSharedDefinition = await executeTool(
    "def",
    { name: "sharedEnvironmentValue" },
    projectA,
  );
  const dependencySharedDefinition = await executeTool(
    "def",
    { name: "sharedEnvironmentValue", path: dependencyDirectory },
    projectA,
  );
  assert(
    resultText(projectSharedDefinition).includes(`in ${sharedSource}:1`) &&
      !resultText(projectSharedDefinition).includes(dependencyLogical) &&
      (projectSharedDefinition.details as { definitions: unknown[] }).definitions.length === 1 &&
      resultText(dependencySharedDefinition).includes(`in ${dependencyLogical}:5-7`) &&
      !resultText(dependencySharedDefinition).includes(sharedSource),
    "project and dependency scopes partition definitions",
  );

  const projectSharedCallers = await executeTool(
    "callers",
    { name: "sharedEnvironmentValue" },
    projectA,
  );
  assert(
    resultText(projectSharedCallers) === 'No callers found for "sharedEnvironmentValue"',
    "project-scoped callers exclude call sites in dependency environments",
  );

  const projectOutline = await executeTool("outline", {}, projectA);
  assert(
    resultText(projectOutline).includes(`${sharedSource}:`) &&
      !resultText(projectOutline).includes(dependencyLogical) &&
      !resultText(projectOutline).includes(venvModule),
    "project-scoped outlines exclude dependency environment files",
  );

  await rejects(
    () => executeTool("def", { name: "dependencyValue", path: dependencyPhysical }, projectA),
    /file is not accepted source/,
    "physical .pnpm package files remain excluded",
  );

  console.log("\nFilesystem lifecycle...");
  const replacedScope = write(projectA, "replaced.ts", "export function formerFileSymbol() {}\n");
  await executeTool("outline", { path: replacedScope }, projectA);
  fs.unlinkSync(replacedScope);
  write(replacedScope, "child.ts", "export function directoryChildSymbol() {}\n");
  const replacementDirectoryOutline = await executeTool(
    "outline",
    { path: replacedScope },
    projectA,
  );
  assert(
    resultText(replacementDirectoryOutline).includes("directoryChildSymbol") &&
      !resultText(replacementDirectoryOutline).includes("formerFileSymbol"),
    "replacing a file with a directory removes the exact file row",
  );

  fs.rmSync(replacedScope, { recursive: true });
  fs.writeFileSync(replacedScope, "export function replacementFileSymbol() {}\n");
  const replacementFileOutline = await executeTool("outline", { path: replacedScope }, projectA);
  assert(
    resultText(replacementFileOutline).includes("replacementFileSymbol") &&
      !resultText(replacementFileOutline).includes("directoryChildSymbol"),
    "replacing a directory with a file removes descendant rows",
  );

  const nestedFile = write(
    projectA,
    "nested/deep/nested.ts",
    "export function nestedSymbol() {}\n",
  );
  const nestedSymbol = await executeTool("def", { name: "nestedSymbol" }, projectA);
  assert(
    resultText(nestedSymbol).includes("function_declaration nestedSymbol"),
    "a file added in a nested directory is indexed",
  );
  fs.writeFileSync(nestedFile, "export function renamedNestedSymbol() {}\n");
  const removedNestedSymbol = await executeTool("def", { name: "nestedSymbol" }, projectA);
  const renamedNestedSymbol = await executeTool("def", { name: "renamedNestedSymbol" }, projectA);
  assert(
    resultText(removedNestedSymbol) === 'No definition found for "nestedSymbol"' &&
      resultText(renamedNestedSymbol).includes("function_declaration renamedNestedSymbol"),
    "a change in a nested directory is reconciled",
  );
  fs.unlinkSync(nestedFile);
  const removedRenamedNestedSymbol = await executeTool(
    "def",
    { name: "renamedNestedSymbol" },
    projectA,
  );
  assert(
    resultText(removedRenamedNestedSymbol) === 'No definition found for "renamedNestedSymbol"',
    "a deletion in a nested directory is removed",
  );

  console.log("\nScope and failure contract...");
  const emptyOutline = await executeTool("outline", { path: empty }, projectA);
  assert(
    resultText(emptyOutline) === `No symbols found in "${empty}"`,
    "an indexed file may have no symbols",
  );
  await rejects(
    () => executeTool("outline", { path: ignored }, projectA),
    /file is not accepted source/,
    "a gitignored file is rejected",
  );
  const externalDefinition = await executeTool(
    "def",
    { name: "externalSymbol", path: externalSource },
    projectA,
  );
  assert(
    resultText(externalDefinition).includes(`in ${externalSource}:1`),
    "an absolute scope is searchable without prior configuration",
  );

  const emptyDirectoryOutline = await executeTool("outline", { path: emptyDirectory }, projectA);
  assert(
    resultText(emptyDirectoryOutline) === `No symbols found in "${emptyDirectory}"`,
    "an empty directory is a valid scope",
  );

  console.log("\n.gitignore lifecycle...");
  const gitignore = path.join(projectA, ".gitignore");
  const originalGitignore = fs.readFileSync(gitignore, "utf-8");
  fs.writeFileSync(gitignore, originalGitignore.replace("ignored.ts\n", ""));
  const unignoredSymbol = await executeTool("def", { name: "ignoredSymbol" }, projectA);
  assert(
    resultText(unignoredSymbol).includes("function_declaration ignoredSymbol"),
    "a newly unignored file appears in the index",
  );
  fs.writeFileSync(gitignore, originalGitignore);
  const reignoredSymbol = await executeTool("def", { name: "ignoredSymbol" }, projectA);
  assert(
    resultText(reignoredSymbol) === 'No definition found for "ignoredSymbol"',
    "restoring the .gitignore re-ignores its files",
  );

  await stopDaemon(daemon);
  daemon = null;
  await rejects(
    () => executeTool("outline", {}, projectA),
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
