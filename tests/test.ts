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

function displayPath(cwd: string, file: string): string {
  return path.relative(cwd, file) || ".";
}

function definitionTitle(cwd: string, file: string, startLine: number, endLine: number): string {
  return `## Defined in \`${displayPath(cwd, file)}:${startLine}–${endLine}\``;
}

function callerTitle(
  cwd: string,
  file: string,
  line: number,
  endLine: number,
  name?: string,
  nodeType?: string,
): string {
  const location = `\`${displayPath(cwd, file)}:${line}-${endLine}\``;
  return name
    ? `## Called in \`${name}\` — \`${nodeType}\`, ${location}`
    : `## Called at top level, ${location}`;
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
const gitMetadataSource = write(
  projectA,
  ".git/internal.ts",
  "export function gitMetadataSymbol() {}\n",
);
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
    definitionTitle(projectA, source, 1, 3),
    "",
    "```typescript",
    "export function target(value: number): number {",
    "  return value + 1;",
    "}",
    "```",
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
    resultText(linkedDefinition).includes(definitionTitle(projectA, sourceSymlink, 1, 1)) &&
      !resultText(linkedDefinition).includes(linkedSource),
    "a file symlink scope is indexed through its logical path",
  );

  const directoryLinkedDefinition = await executeTool("def", { name: "linkedSymbol" }, projectA);
  assert(
    resultText(directoryLinkedDefinition).includes(
      definitionTitle(projectA, sourceSymlink, 1, 1),
    ) && !resultText(directoryLinkedDefinition).includes(linkedSource),
    "directory reconciliation includes file symlinks",
  );

  const cycleDefinition = await executeTool(
    "def",
    { name: "cycleNeighborSymbol", path: path.dirname(cycleNeighbor) },
    projectA,
  );
  assert(
    resultText(cycleDefinition).includes(definitionTitle(projectA, cycleNeighbor, 1, 1)) &&
      !resultText(cycleDefinition).includes(`${path.sep}back${path.sep}`),
    "an ancestor symlink cycle terminates without suppressing neighboring files",
  );

  const callers = await executeTool("callers", { name: "target", path: "src/a.ts" }, projectA);
  assert(
    resultText(callers) ===
      [
        callerTitle(projectA, source, 7, 7, "increment", "method_definition"),
        "",
        "```typescript",
        "    return target(value);",
        "```",
      ].join("\n"),
    "callers resolves a relative path and reports source context",
  );

  const outline = await executeTool("outline", { path: path.dirname(source) }, projectB);
  assert(
    resultText(outline) ===
      [
        `## Symbols in \`${displayPath(projectB, source)}\``,
        "",
        "- `target` — `function_declaration`, lines 1–3",
        "- `Counter` — `class_declaration`, lines 5–9",
        "  - `increment` — `method_definition`, lines 6–8",
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
        "- `Client` — `class_declaration`, lines 1–3",
        "  - `run` — `method_definition`, lines 2–2",
        "- `build` — `variable_declarator`, lines 4–4",
      ].join("\n") &&
      javascriptMemberCallers.includes(
        callerTitle(projectA, javascriptContract, 2, 2, "run", "method_definition"),
      ) &&
      javascriptConstructorCallers.includes(
        callerTitle(projectA, javascriptContract, 4, 4, "build", "variable_declarator"),
      ),
    "JavaScript definitions, methods, member calls, and constructors are extracted",
  );

  const typescriptOutline = resultText(
    await executeTool("outline", { path: typescriptContract }, projectA),
  );
  assert(
    typescriptOutline ===
      [
        "- `Service` — `interface_declaration`, lines 1–3",
        "  - `run` — `method_signature`, lines 2–2",
        "- `Compact` — `interface_declaration`, lines 4–4",
        "  - `ping` — `method_signature`, lines 4–4",
        "  - `ping` — `method_signature`, lines 4–4",
        "- `Input` — `type_alias_declaration`, lines 5–5",
        "- `Output` — `type_alias_declaration`, lines 6–6",
        "- `create` — `function_signature`, lines 7–7",
        "- `API` — `internal_module`, lines 8–10",
        "  - `declared` — `function_signature`, lines 9–9",
        "- `Widget` — `class_declaration`, lines 11–11",
        "- `build` — `function_declaration`, lines 12–16",
        "- `sameLine` — `function_declaration`, lines 17–17",
      ].join("\n"),
    "TypeScript interfaces, signatures, types, modules, classes, and functions are outlined",
  );
  const widgetCallers = resultText(
    await executeTool("callers", { name: "Widget", path: typescriptContract }, projectA),
  );
  assert(
    (widgetCallers.match(/Called in/g) ?? []).length === 1 &&
      widgetCallers.includes(
        callerTitle(projectA, typescriptContract, 13, 13, "build", "function_declaration"),
      ) &&
      widgetCallers.includes("new Widget()"),
    "constructors are callers while TypeScript annotations are not",
  );
  const inputCallers = await executeTool(
    "callers",
    { name: "Input", path: typescriptContract },
    projectA,
  );
  assert(
    resultText(inputCallers) ===
      `No callers named \`Input\` found under \`${displayPath(projectA, typescriptContract)}\`.`,
    "TypeScript type references are not callers",
  );
  const nestedCallers = resultText(
    await executeTool("callers", { name: "nested", path: typescriptContract }, projectA),
  );
  const topLevelCallers = resultText(
    await executeTool("callers", { name: "topLevel", path: typescriptContract }, projectA),
  );
  assert(
    nestedCallers.includes(
      callerTitle(projectA, typescriptContract, 17, 17, "sameLine", "function_declaration"),
    ) && topLevelCallers.includes(callerTitle(projectA, typescriptContract, 17, 17)),
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
    (tsxButtonCallers.match(/Called in/g) ?? []).length === 2 &&
      tsxButtonCallers.includes("<Button />") &&
      tsxButtonCallers.includes("<UI.Button>") &&
      resultText(intrinsicCallers) ===
        `No callers named \`button\` found under \`${displayPath(projectA, tsxContract)}\`.`,
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
        "- `Worker` — `class_definition`, lines 1–4",
        "  - `work` — `function_definition`, lines 2–4",
        "- `helper` — `function_definition`, lines 6–7",
      ].join("\n") &&
      pythonHelperCallers.includes(
        callerTitle(projectA, pythonContract, 3, 3, "work", "function_definition"),
      ) &&
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
        "- `Engine` — `struct_item`, lines 1–1",
        "- `Mode` — `enum_item`, lines 2–2",
        "- `Value` — `union_item`, lines 3–3",
        "- `EngineAlias` — `type_item`, lines 4–4",
        "- `Runner` — `trait_item`, lines 5–5",
        "- `support` — `mod_item`, lines 6–6",
        "- `local_macro` — `macro_definition`, lines 7–7",
        "- `execute` — `function_item`, lines 10–14",
        "- `helper` — `function_item`, lines 17–17",
      ].join("\n") &&
      rustHelperCallers.includes(
        callerTitle(projectA, rustContract, 11, 11, "execute", "function_item"),
      ) &&
      rustMemberCallers.includes("self.finish()") &&
      rustMacroCallers.includes('println!("running")') &&
      resultText(rustImplCallers) ===
        `No callers named \`Runner\` found under \`${displayPath(projectA, rustContract)}\`.`,
    "Rust types, functions, methods, macros, and calls exclude impl references",
  );

  console.log("\nDependency environments...");
  const dependencyDefinition = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyDirectory },
    projectA,
  );
  assert(
    resultText(dependencyDefinition).includes(definitionTitle(projectA, dependencyLogical, 1, 3)) &&
      !resultText(dependencyDefinition).includes(dependencyPhysical),
    "a pnpm package is indexed and reported through its logical symlink path",
  );

  const aliasDefinition = await executeTool(
    "def",
    { name: "dependencyValue", path: dependencyAlias },
    projectA,
  );
  assert(
    !resultText(dependencyDefinition).includes(dependencyAlias) &&
      resultText(aliasDefinition).includes(definitionTitle(projectA, dependencyAlias, 1, 3)) &&
      !resultText(aliasDefinition).includes(dependencyLogical),
    "two directory aliases to one package remain independently queryable",
  );

  const venvDefinition = await executeTool(
    "def",
    { name: "environment_value", path: path.dirname(venvModule) },
    projectA,
  );
  assert(
    resultText(venvDefinition).includes(definitionTitle(projectA, venvModule, 1, 2)),
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
    resultText(projectSharedDefinition).includes(definitionTitle(projectA, sharedSource, 1, 1)) &&
      !resultText(projectSharedDefinition).includes(dependencyLogical) &&
      (projectSharedDefinition.details as { definitions: unknown[] }).definitions.length === 1 &&
      resultText(dependencySharedDefinition).includes(
        definitionTitle(projectA, dependencyLogical, 5, 7),
      ) &&
      !resultText(dependencySharedDefinition).includes(sharedSource),
    "project and dependency scopes partition definitions",
  );

  const projectSharedCallers = await executeTool(
    "callers",
    { name: "sharedEnvironmentValue" },
    projectA,
  );
  assert(
    resultText(projectSharedCallers) ===
      "No callers named `sharedEnvironmentValue` found under `.`.",
    "project-scoped callers exclude call sites in dependency environments",
  );

  const projectOutline = await executeTool("outline", {}, projectA);
  assert(
    resultText(projectOutline).includes(
      `## Symbols in \`${displayPath(projectA, sharedSource)}\``,
    ) &&
      !resultText(projectOutline).includes(dependencyLogical) &&
      !resultText(projectOutline).includes(venvModule),
    "project-scoped outlines exclude dependency environment files",
  );

  console.log("\nFilesystem lifecycle...");
  fs.writeFileSync(linkedSource, "export function linkedSymbol() {\n  return 2;\n}\n");
  const refreshedLinkedDefinition = await executeTool(
    "def",
    { name: "linkedSymbol", path: sourceSymlink },
    projectA,
  );
  assert(
    resultText(refreshedLinkedDefinition).includes(
      definitionTitle(projectA, sourceSymlink, 1, 3),
    ) && resultText(refreshedLinkedDefinition).includes("  return 2;"),
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
    resultText(nestedSymbol).includes("export function nestedSymbol"),
    "a file added in a nested directory is indexed",
  );
  fs.writeFileSync(nestedFile, "export function renamedNestedSymbol() {}\n");
  const removedNestedSymbol = await executeTool("def", { name: "nestedSymbol" }, projectA);
  const renamedNestedSymbol = await executeTool("def", { name: "renamedNestedSymbol" }, projectA);
  assert(
    resultText(removedNestedSymbol) === "No definitions named `nestedSymbol` found under `.`." &&
      resultText(renamedNestedSymbol).includes("export function renamedNestedSymbol"),
    "a change in a nested directory is reconciled",
  );
  fs.unlinkSync(nestedFile);
  const removedRenamedNestedSymbol = await executeTool(
    "def",
    { name: "renamedNestedSymbol" },
    projectA,
  );
  assert(
    resultText(removedRenamedNestedSymbol) ===
      "No definitions named `renamedNestedSymbol` found under `.`.",
    "a deletion in a nested directory is removed",
  );

  console.log("\nScope and failure contract...");
  const emptyOutline = await executeTool("outline", { path: empty }, projectA);
  assert(
    resultText(emptyOutline) === `No symbols found under \`${displayPath(projectA, empty)}\`.`,
    "an indexed file may have no symbols",
  );
  await rejects(
    () => executeTool("outline", { path: ignored }, projectA),
    /file is not accepted source/,
    "a gitignored file is rejected",
  );
  await rejects(
    () => executeTool("outline", { path: gitMetadataSource }, projectA),
    /file is not accepted source/,
    ".git logical routes remain excluded",
  );
  const externalDefinition = await executeTool(
    "def",
    { name: "externalSymbol", path: externalSource },
    projectA,
  );
  assert(
    resultText(externalDefinition).includes(definitionTitle(projectA, externalSource, 1, 1)),
    "an arbitrary absolute file scope is searchable",
  );

  const emptyDirectoryOutline = await executeTool("outline", { path: emptyDirectory }, projectA);
  assert(
    resultText(emptyDirectoryOutline) ===
      `No symbols found under \`${displayPath(projectA, emptyDirectory)}\`.`,
    "an empty directory is a valid scope",
  );

  console.log("\nTool output truncation...");
  const hugeSource = write(
    projectA,
    "huge.ts",
    [
      "export function huge() {",
      ...Array.from({ length: 2_100 }, (_, index) => `  console.log(${index});`),
      "}",
      "",
    ].join("\n"),
  );
  const hugeDefinition = await executeTool("def", { name: "huge", path: hugeSource }, projectA);
  const hugeDetails = hugeDefinition.details as {
    truncation?: { truncated: boolean };
    fullOutputPath?: string;
  };
  const hugeOutputPath = hugeDetails.fullOutputPath;
  assert(
    hugeDetails.truncation?.truncated === true &&
      typeof hugeOutputPath === "string" &&
      path.dirname(hugeOutputPath) === os.tmpdir() &&
      /^pi-trace-[0-9a-f]{16}\.md$/.test(path.basename(hugeOutputPath)) &&
      resultText(hugeDefinition).includes(`Full output: \`${hugeOutputPath}\``) &&
      fs.readFileSync(hugeOutputPath, "utf-8").includes("  console.log(2099);") &&
      fs.readFileSync(hugeOutputPath, "utf-8").endsWith("}\n```"),
    "truncated output is persisted to a temp file and reports its path",
  );
  if (hugeOutputPath) fs.rmSync(hugeOutputPath, { force: true });

  console.log("\n.gitignore lifecycle...");
  const gitignore = path.join(projectA, ".gitignore");
  const originalGitignore = fs.readFileSync(gitignore, "utf-8");
  fs.writeFileSync(gitignore, originalGitignore.replace("ignored.ts\n", ""));
  const unignoredSymbol = await executeTool("def", { name: "ignoredSymbol" }, projectA);
  assert(
    resultText(unignoredSymbol).includes("export function ignoredSymbol"),
    "a newly unignored file appears in the index",
  );
  fs.writeFileSync(gitignore, originalGitignore);
  const reignoredSymbol = await executeTool("def", { name: "ignoredSymbol" }, projectA);
  assert(
    resultText(reignoredSymbol) === "No definitions named `ignoredSymbol` found under `.`.",
    "restoring the .gitignore re-ignores its files",
  );
} finally {
  if (sessionStarted) await emitLifecycle("session_shutdown", projectA);
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
