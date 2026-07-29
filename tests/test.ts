import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerTrace } from "../extensions/index.ts";

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

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
const home = path.join(temporary, "home");
const projectA = path.join(home, "workspace", "project-a");
const projectB = path.join(home, "workspace", "project-b");
const database = path.join(temporary, "index.sqlite");

const tools = new Map<string, ToolDefinition>();
const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
registerTrace(
  {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: LifecycleHandler) {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
  } as unknown as ExtensionAPI,
  database,
);

async function emitLifecycle(event: string, cwd: string): Promise<void> {
  for (const handler of lifecycleHandlers.get(event) ?? []) {
    await handler({}, { cwd } as ExtensionContext);
  }
}

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
const javascriptContract = write(
  projectA,
  "contract/client.js",
  [
    "class Client {",
    "  run() { return api.fetch(); }",
    "}",
    "const build = () => new Client();",
    "",
  ].join("\n"),
);
const typescriptContract = write(
  projectA,
  "contract/types.ts",
  [
    "interface Service {",
    "  run(input: Input): Output;",
    "}",
    "interface Compact { ping(): void; ping(value: string): void; }",
    "type Input = string;",
    "type Output = Widget;",
    "declare function create(input: Input): Service;",
    "namespace API {",
    "  export function declared(): void;",
    "}",
    "class Widget {}",
    "function build(value: Widget): Service {",
    "  const widget = new Widget();",
    "  service.run(value);",
    "  return widget;",
    "}",
    "function sameLine() { nested(); } topLevel();",
    "",
  ].join("\n"),
);
const tsxContract = write(
  projectA,
  "contract/view.tsx",
  [
    "function View() {",
    "  return <section>",
    "    <Button />",
    "    <UI.Button></UI.Button>",
    "    <button />",
    "  </section>;",
    "}",
    "",
  ].join("\n"),
);
const pythonContract = write(
  projectA,
  "contract/worker.py",
  [
    "class Worker:",
    "    def work(self):",
    "        helper()",
    "        self.finish()",
    "",
    "def helper():",
    "    return None",
    "",
  ].join("\n"),
);
const rustContract = write(
  projectA,
  "contract/engine.rs",
  [
    "struct Engine;",
    "enum Mode { Fast }",
    "union Value { integer: i32 }",
    "type EngineAlias = Engine;",
    "trait Runner {}",
    "mod support {}",
    "macro_rules! local_macro { () => {} }",
    "",
    "impl Runner for Engine {",
    "    fn execute(&self) {",
    "        helper();",
    "        self.finish();",
    '        println!("running");',
    "    }",
    "}",
    "",
    "fn helper() {}",
    "",
  ].join("\n"),
);
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
let sessionStarted = false;
try {
  await emitLifecycle("session_start", projectA);
  sessionStarted = true;

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

  const linkedDefinition = await executeTool(
    "def",
    { name: "linkedSymbol", path: sourceSymlink },
    projectA,
  );
  assert(
    resultText(linkedDefinition).includes(
      `function_declaration linkedSymbol in ${sourceSymlink}:1`,
    ) && !resultText(linkedDefinition).includes(linkedSource),
    "a file symlink scope is indexed through its logical path",
  );

  const directoryLinkedDefinition = await executeTool("def", { name: "linkedSymbol" }, projectA);
  assert(
    resultText(directoryLinkedDefinition).includes(
      `function_declaration linkedSymbol in ${sourceSymlink}:1`,
    ) && !resultText(directoryLinkedDefinition).includes(linkedSource),
    "directory reconciliation includes file symlinks",
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
        "  target (function_declaration) — 1-3",
        "  Counter (class_declaration) — 5-9",
        "    increment (method_definition) — 6-8",
      ].join("\n"),
    "outline accepts an absolute directory and renders nested symbols",
  );

  console.log("\nExtraction contract...");
  const javascriptOutline = resultText(
    await executeTool("outline", { path: javascriptContract }, projectA),
  );
  const javascriptMemberCallers = resultText(
    await executeTool("callers", { name: "fetch", path: javascriptContract }, projectA),
  );
  const javascriptConstructorCallers = resultText(
    await executeTool("callers", { name: "Client", path: javascriptContract }, projectA),
  );
  assert(
    javascriptOutline ===
      [
        "Client (class_declaration) — 1-3",
        "  run (method_definition) — 2-2",
        "build (variable_declarator) — 4-4",
      ].join("\n") &&
      javascriptMemberCallers.includes("called in run (method_definition)") &&
      javascriptConstructorCallers.includes("called in build (variable_declarator)"),
    "JavaScript definitions, methods, member calls, and constructors are extracted",
  );

  const typescriptOutline = resultText(
    await executeTool("outline", { path: typescriptContract }, projectA),
  );
  assert(
    typescriptOutline ===
      [
        "Service (interface_declaration) — 1-3",
        "  run (method_signature) — 2-2",
        "Compact (interface_declaration) — 4-4",
        "  ping (method_signature) — 4-4",
        "  ping (method_signature) — 4-4",
        "Input (type_alias_declaration) — 5-5",
        "Output (type_alias_declaration) — 6-6",
        "create (function_signature) — 7-7",
        "API (internal_module) — 8-10",
        "  declared (function_signature) — 9-9",
        "Widget (class_declaration) — 11-11",
        "build (function_declaration) — 12-16",
        "sameLine (function_declaration) — 17-17",
      ].join("\n"),
    "TypeScript interfaces, signatures, types, modules, classes, and functions are outlined",
  );
  const widgetCallers = resultText(
    await executeTool("callers", { name: "Widget", path: typescriptContract }, projectA),
  );
  assert(
    (widgetCallers.match(/called in/g) ?? []).length === 1 &&
      widgetCallers.includes(`${typescriptContract}:13 — called in build (function_declaration)`) &&
      widgetCallers.includes("new Widget()"),
    "constructors are callers while TypeScript annotations are not",
  );
  const inputCallers = await executeTool(
    "callers",
    { name: "Input", path: typescriptContract },
    projectA,
  );
  assert(
    resultText(inputCallers) === 'No callers found for "Input"',
    "TypeScript type references are not callers",
  );
  const nestedCallers = resultText(
    await executeTool("callers", { name: "nested", path: typescriptContract }, projectA),
  );
  const topLevelCallers = resultText(
    await executeTool("callers", { name: "topLevel", path: typescriptContract }, projectA),
  );
  assert(
    nestedCallers.includes("called in sameLine (function_declaration)") &&
      topLevelCallers.includes("called in (top-level)"),
    "same-line calls are assigned by syntax boundaries rather than line range",
  );

  const tsxButtonCallers = resultText(
    await executeTool("callers", { name: "Button", path: tsxContract }, projectA),
  );
  const intrinsicCallers = await executeTool(
    "callers",
    { name: "button", path: tsxContract },
    projectA,
  );
  assert(
    (tsxButtonCallers.match(/called in/g) ?? []).length === 2 &&
      tsxButtonCallers.includes("<Button />") &&
      tsxButtonCallers.includes("<UI.Button>") &&
      resultText(intrinsicCallers) === 'No callers found for "button"',
    "TSX components include simple and member tags without closers or intrinsic tags",
  );

  const pythonOutline = resultText(
    await executeTool("outline", { path: pythonContract }, projectA),
  );
  const pythonHelperCallers = resultText(
    await executeTool("callers", { name: "helper", path: pythonContract }, projectA),
  );
  const pythonMemberCallers = resultText(
    await executeTool("callers", { name: "finish", path: pythonContract }, projectA),
  );
  assert(
    pythonOutline ===
      [
        "Worker (class_definition) — 1-4",
        "  work (function_definition) — 2-4",
        "helper (function_definition) — 6-7",
      ].join("\n") &&
      pythonHelperCallers.includes("called in work (function_definition)") &&
      pythonMemberCallers.includes("self.finish()"),
    "Python classes, functions, and direct and member calls are extracted",
  );

  const rustOutline = resultText(await executeTool("outline", { path: rustContract }, projectA));
  const rustHelperCallers = resultText(
    await executeTool("callers", { name: "helper", path: rustContract }, projectA),
  );
  const rustMemberCallers = resultText(
    await executeTool("callers", { name: "finish", path: rustContract }, projectA),
  );
  const rustMacroCallers = resultText(
    await executeTool("callers", { name: "println", path: rustContract }, projectA),
  );
  const rustImplCallers = await executeTool(
    "callers",
    { name: "Runner", path: rustContract },
    projectA,
  );
  assert(
    rustOutline ===
      [
        "Engine (struct_item) — 1-1",
        "Mode (enum_item) — 2-2",
        "Value (union_item) — 3-3",
        "EngineAlias (type_item) — 4-4",
        "Runner (trait_item) — 5-5",
        "support (mod_item) — 6-6",
        "local_macro (macro_definition) — 7-7",
        "execute (function_item) — 10-14",
        "helper (function_item) — 17-17",
      ].join("\n") &&
      rustHelperCallers.includes("called in execute (function_item)") &&
      rustMemberCallers.includes("self.finish()") &&
      rustMacroCallers.includes('println!("running")') &&
      resultText(rustImplCallers) === 'No callers found for "Runner"',
    "Rust types, functions, methods, macros, and calls exclude impl references",
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
  fs.writeFileSync(linkedSource, "export function linkedSymbol() {\n  return 2;\n}\n");
  const refreshedLinkedDefinition = await executeTool(
    "def",
    { name: "linkedSymbol", path: sourceSymlink },
    projectA,
  );
  assert(
    resultText(refreshedLinkedDefinition).includes(`in ${sourceSymlink}:1-3`) &&
      resultText(refreshedLinkedDefinition).includes("   2 |   return 2;"),
    "a file symlink scope reconciles changes to its target",
  );

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
} finally {
  if (sessionStarted) await emitLifecycle("session_shutdown", projectA);
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
