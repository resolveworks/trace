import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
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
const dependencyAliasDirectory = path.join(rootA, "node_modules", "dep-alias");
fs.symlinkSync(path.dirname(dependencyPhysical), dependencyAliasDirectory, "dir");
const dependencyAlias = path.join(dependencyAliasDirectory, "index.js");
const metacharacterPackage = path.join(rootA, "node_modules", "pkg[one]");
const metacharacterFile = write(
  metacharacterPackage,
  "index.js",
  "export function metacharacterBoundary() { return 1; }\n",
);
const globSiblingFile = write(
  rootA,
  "node_modules/pkgo/index.js",
  "export function metacharacterBoundary() { return 2; }\n",
);
const venvModule = write(
  rootA,
  ".venv/lib/python3.12/site-packages/pkg/mod.py",
  "def environment_value():\n    return 12\n",
);
write(rootB, "b.ts", "export function target(): number { return 2; }\n");
const projectBehindStoreBacklink = path.join(rootB, "project");
const backlinkSource = write(
  projectBehindStoreBacklink,
  "src/backlink.ts",
  "export function backlinkSymbol() { return 1; }\n",
);
const storeBacklink = path.join(rootB, ".pnpm-store", "v11", "projects", "id");
fs.mkdirSync(path.dirname(storeBacklink), { recursive: true });
fs.symlinkSync(projectBehindStoreBacklink, storeBacklink, "dir");
const cycleNeighbor = write(
  rootA,
  "cycle/neighbor.ts",
  "export function cycleNeighborSymbol() {}\n",
);
fs.symlinkSync(rootA, path.join(rootA, "cycle", "back"), "dir");
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
    /file is not accepted source/,
    "file symlinks are rejected",
  );

  const backlinkDefinition = await executeTool(
    "def",
    { name: "backlinkSymbol", path: projectBehindStoreBacklink },
    rootB,
  );
  assert(
    resultText(backlinkDefinition).includes(`in ${backlinkSource}:1`) &&
      !resultText(backlinkDefinition).includes(storeBacklink),
    "an excluded store backlink cannot suppress the real first-party path",
  );
  await rejects(
    () => executeTool("outline", { path: storeBacklink }, rootB),
    /directory contains no accepted source files/,
    ".pnpm-store logical routes are rejected",
  );
  fs.writeFileSync(backlinkSource, "export function backlinkSymbol() {\n  return 2;\n}\n");
  const refreshedBacklink = await executeTool(
    "def",
    { name: "backlinkSymbol", path: projectBehindStoreBacklink },
    rootB,
  );
  assert(
    resultText(refreshedBacklink).includes(`in ${backlinkSource}:1-3`),
    "the normal first-party path behind a store backlink remains queryable",
  );

  const cycleDefinition = await executeTool(
    "def",
    { name: "cycleNeighborSymbol", path: path.dirname(cycleNeighbor) },
    rootA,
  );
  assert(
    resultText(cycleDefinition).includes(`in ${cycleNeighbor}:1`) &&
      !resultText(cycleDefinition).includes(`${path.sep}back${path.sep}`),
    "an ancestor symlink cycle terminates without suppressing neighboring files",
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
    "two directory aliases to one package remain independently queryable",
  );

  const metacharacterDefinition = await executeTool(
    "def",
    { name: "metacharacterBoundary", path: metacharacterPackage },
    rootA,
  );
  assert(
    resultText(metacharacterDefinition).includes(`in ${metacharacterFile}:1`) &&
      !resultText(metacharacterDefinition).includes(globSiblingFile),
    "dependency reconciliation and queries use a literal subtree boundary",
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
  const updatedDependency = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyDirectory },
    rootA,
  );
  assert(
    resultText(updatedDependency).includes(`in ${dependencyLogical}:1-4`) &&
      resultText(updatedDependency).includes("   3 |   return updated;"),
    "a dependency-scoped query reconciles a deep dependency change",
  );
  await rejects(
    () => executeTool("def", { name: "dependencyValue", path: dependencyPhysical }, rootA),
    /file is not accepted source/,
    "physical .pnpm package files remain excluded",
  );

  const newlyInstalledDirectory = path.join(rootA, "node_modules", "new-package");
  const newlyInstalledFile = write(
    newlyInstalledDirectory,
    "index.js",
    "export function newlyInstalledSymbol() {}\n",
  );
  const newlyInstalled = await executeTool(
    "def",
    { name: "newlyInstalledSymbol", path: newlyInstalledDirectory },
    rootA,
  );
  assert(
    resultText(newlyInstalled).includes(`in ${newlyInstalledFile}:1`),
    "a newly installed package is indexed by its first scoped query",
  );
  fs.writeFileSync(newlyInstalledFile, "export function replacementPackageSymbol() {}\n");
  const removedPackageSymbol = await executeTool(
    "def",
    { name: "newlyInstalledSymbol", path: newlyInstalledDirectory },
    rootA,
  );
  const replacementPackageSymbol = await executeTool(
    "def",
    { name: "replacementPackageSymbol", path: newlyInstalledDirectory },
    rootA,
  );
  assert(
    resultText(removedPackageSymbol) === 'No definition found for "newlyInstalledSymbol"' &&
      resultText(replacementPackageSymbol).includes(`in ${newlyInstalledFile}:1`),
    "a package-scoped query removes rewritten dependency symbols",
  );

  fs.rmSync(path.dirname(dependencyPhysical), { recursive: true, force: true });
  const deletedDependency = await executeTool(
    "def",
    { name: "dependencyValue", path: path.join(rootA, "node_modules") },
    rootA,
  );
  assert(
    resultText(deletedDependency) === 'No definition found for "dependencyValue"',
    "a dependency subtree query removes files deleted below that boundary",
  );

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
  const restoredDependency = await executeTool(
    "def",
    { name: "restoredDependency", path: dependencyDirectory },
    rootA,
  );
  assert(
    resultText(restoredDependency).includes(`in ${dependencyLogical}:5`),
    "querying a replaced dependency symlink refreshes its logical rows",
  );
  const addedDeepDependency = await executeTool(
    "def",
    { name: "deepDependencySymbol", path: dependencyDirectory },
    rootA,
  );
  assert(
    resultText(addedDeepDependency).includes(`in ${deepLogical}:1`) &&
      !resultText(addedDeepDependency).includes(deepPhysical),
    "a scoped query adds a new deep file through its logical path",
  );

  fs.writeFileSync(
    dependencyPhysical,
    "export function dependencyValue() {\n  return 4;\n}\n\nexport function restoredDependency() {\n  return 8;\n}\n",
  );
  const changedRestoredDependency = await executeTool(
    "def",
    { name: "restoredDependency", path: dependencyDirectory },
    rootA,
  );
  assert(
    resultText(changedRestoredDependency).includes(`in ${dependencyLogical}:5-7`) &&
      resultText(changedRestoredDependency).includes("   6 |   return 8;"),
    "a changed file at a replaced dependency symlink is reconciled on query",
  );

  fs.writeFileSync(deepPhysical, "export function deepDependencySymbol() {\n  return 42;\n}\n");
  const changedDeepDependency = await executeTool(
    "def",
    { name: "deepDependencySymbol", path: deepLogical },
    rootA,
  );
  assert(
    resultText(changedDeepDependency).includes(`in ${deepLogical}:1-3`) &&
      resultText(changedDeepDependency).includes("   2 |   return 42;"),
    "an exact dependency file query reconciles only that file",
  );
  await rejects(
    () => executeTool("def", { name: "deepDependencySymbol", path: deepPhysical }, rootA),
    /file is not accepted source/,
    "deep physical .pnpm files remain excluded",
  );

  console.log("\nFilesystem lifecycle...");
  const changing = path.join(rootA, "changing.ts");
  fs.writeFileSync(changing, "export function addedSymbol() {}\n");
  const addedSymbol = await executeTool("def", { name: "addedSymbol" }, rootA);
  assert(
    resultText(addedSymbol).includes("function_declaration addedSymbol"),
    "a query exposes an added symbol",
  );

  fs.writeFileSync(changing, "export function changedSymbol() {}\n");
  const removedAddedSymbol = await executeTool("def", { name: "addedSymbol" }, rootA);
  const changedSymbol = await executeTool("def", { name: "changedSymbol" }, rootA);
  assert(
    resultText(removedAddedSymbol) === 'No definition found for "addedSymbol"' &&
      resultText(changedSymbol).includes("function_declaration changedSymbol"),
    "a query replaces changed symbols",
  );

  fs.unlinkSync(changing);
  const removedChangedSymbol = await executeTool("def", { name: "changedSymbol" }, rootA);
  assert(
    resultText(removedChangedSymbol) === 'No definition found for "changedSymbol"',
    "a query removes deleted symbols",
  );

  const replacedScope = write(rootA, "replaced.ts", "export function formerFileSymbol() {}\n");
  await executeTool("outline", { path: replacedScope }, rootA);
  fs.unlinkSync(replacedScope);
  write(replacedScope, "child.ts", "export function directoryChildSymbol() {}\n");
  const replacementDirectoryOutline = await executeTool("outline", { path: replacedScope }, rootA);
  assert(
    resultText(replacementDirectoryOutline).includes("directoryChildSymbol") &&
      !resultText(replacementDirectoryOutline).includes("formerFileSymbol"),
    "replacing a file with a directory removes the exact file row",
  );

  fs.rmSync(replacedScope, { recursive: true });
  fs.writeFileSync(replacedScope, "export function replacementFileSymbol() {}\n");
  const replacementFileOutline = await executeTool("outline", { path: replacedScope }, rootA);
  assert(
    resultText(replacementFileOutline).includes("replacementFileSymbol") &&
      !resultText(replacementFileOutline).includes("directoryChildSymbol"),
    "replacing a directory with a file removes descendant rows",
  );

  console.log("\nDirectory topology...");
  const created = path.join(rootA, "created");
  fs.mkdirSync(path.join(created, "inner"), { recursive: true });
  fs.writeFileSync(path.join(created, "fresh.ts"), "export function freshSymbol() {}\n");
  fs.writeFileSync(path.join(created, "inner", "inner.ts"), "export function innerSymbol() {}\n");
  const freshSymbol = await executeTool("def", { name: "freshSymbol" }, rootA);
  assert(
    resultText(freshSymbol).includes("function_declaration freshSymbol"),
    "a new directory already containing a source file is indexed",
  );
  const innerSymbol = await executeTool("def", { name: "innerSymbol" }, rootA);
  assert(
    resultText(innerSymbol).includes("function_declaration innerSymbol"),
    "a nested file inside a newly created directory tree is indexed",
  );

  const nestedFile = path.join(rootA, "nested", "deep", "nested.ts");
  fs.writeFileSync(nestedFile, "export function nestedSymbol() {}\n");
  const nestedSymbol = await executeTool("def", { name: "nestedSymbol" }, rootA);
  assert(
    resultText(nestedSymbol).includes("function_declaration nestedSymbol"),
    "a file added in a nested directory is indexed",
  );
  fs.writeFileSync(nestedFile, "export function renamedNestedSymbol() {}\n");
  const removedNestedSymbol = await executeTool("def", { name: "nestedSymbol" }, rootA);
  const renamedNestedSymbol = await executeTool("def", { name: "renamedNestedSymbol" }, rootA);
  assert(
    resultText(removedNestedSymbol) === 'No definition found for "nestedSymbol"' &&
      resultText(renamedNestedSymbol).includes("function_declaration renamedNestedSymbol"),
    "a change in a nested directory is reconciled",
  );
  fs.unlinkSync(nestedFile);
  const removedRenamedNestedSymbol = await executeTool(
    "def",
    { name: "renamedNestedSymbol" },
    rootA,
  );
  assert(
    resultText(removedRenamedNestedSymbol) === 'No definition found for "renamedNestedSymbol"',
    "a deletion in a nested directory is removed",
  );

  fs.rmSync(created, { recursive: true, force: true });
  const removedFreshSymbol = await executeTool("def", { name: "freshSymbol" }, rootA);
  const removedInnerSymbol = await executeTool("def", { name: "innerSymbol" }, rootA);
  assert(
    resultText(removedFreshSymbol) === 'No definition found for "freshSymbol"' &&
      resultText(removedInnerSymbol) === 'No definition found for "innerSymbol"',
    "deleting a populated directory removes all of its indexed files",
  );

  const staging = path.join(home, "staging");
  write(staging, "incoming/pack/moved.ts", "export function movedSymbol() {}\n");
  const movedFile = path.join(rootA, "incoming", "pack", "moved.ts");
  fs.renameSync(path.join(staging, "incoming"), path.join(rootA, "incoming"));
  const movedSymbol = await executeTool("def", { name: "movedSymbol" }, rootA);
  assert(
    resultText(movedSymbol).includes(`function_declaration movedSymbol in ${movedFile}:1`),
    "a populated directory moved into the root is indexed",
  );
  fs.writeFileSync(movedFile, "export function movedSymbol() {\n  return 7;\n}\n");
  const changedMovedSymbol = await executeTool("def", { name: "movedSymbol" }, rootA);
  assert(
    resultText(changedMovedSymbol).includes(`in ${movedFile}:1-3`),
    "changes inside a moved-in directory are reconciled",
  );
  fs.renameSync(path.join(rootA, "incoming"), path.join(staging, "departed"));
  const removedMovedSymbol = await executeTool("def", { name: "movedSymbol" }, rootA);
  assert(
    resultText(removedMovedSymbol) === 'No definition found for "movedSymbol"',
    "moving a populated directory out of the root removes its indexed files",
  );

  console.log("\nScope and failure contract...");
  const emptyOutline = await executeTool("outline", { path: empty }, rootA);
  assert(
    resultText(emptyOutline) === `No symbols found in "${empty}"`,
    "an indexed file may have no symbols",
  );
  await rejects(
    () => executeTool("outline", { path: ignored }, rootA),
    /file is not accepted source/,
    "a gitignored file is rejected",
  );
  await rejects(
    () => executeTool("outline", { path: home }, rootA),
    new RegExp(`outside configured roots:.*roots: ${rootA}, ${rootB}`),
    "an outside-roots error lists the configured roots",
  );

  console.log("\n.gitignore lifecycle...");
  const gitignore = path.join(rootA, ".gitignore");
  const originalGitignore = fs.readFileSync(gitignore, "utf-8");
  fs.writeFileSync(gitignore, `${originalGitignore}empty.ts\n`);
  await rejects(
    () => executeTool("outline", { path: empty }, rootA),
    /file is not accepted source/,
    "a newly gitignored file disappears from the index",
  );

  fs.writeFileSync(gitignore, originalGitignore.replace("ignored.ts\n", ""));
  const unignoredSymbol = await executeTool("def", { name: "ignoredSymbol" }, rootA);
  assert(
    resultText(unignoredSymbol).includes("function_declaration ignoredSymbol"),
    "a newly unignored file appears in the index",
  );
  const restoredEmptyOutline = await executeTool("outline", { path: empty }, rootA);
  assert(
    resultText(restoredEmptyOutline) === `No symbols found in "${empty}"`,
    "removing the ignore rule restores the previously ignored file",
  );

  fs.writeFileSync(gitignore, originalGitignore);
  const reignoredSymbol = await executeTool("def", { name: "ignoredSymbol" }, rootA);
  assert(
    resultText(reignoredSymbol) === 'No definition found for "ignoredSymbol"',
    "restoring the .gitignore re-ignores its files",
  );

  const stalledClient = net.createConnection(socket);
  await once(stalledClient, "connect");
  const shutdownStarted = Date.now();
  await stopDaemon(daemon);
  assert(Date.now() - shutdownStarted < 2_500, "shutdown closes incomplete client connections");
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
