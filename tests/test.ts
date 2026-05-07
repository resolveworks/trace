import { indexProject } from "../src/indexer.js";
import { byExtension } from "../src/languages.js";
import { findDefinition, findCallers, getOutline, closeDb } from "../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";

const TRACE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

// --- Grammars ---
console.log("Grammars...");
const langNames = [...new Set([...byExtension.values()].map((l) => l.name))];
console.log(`  ${langNames.length} grammars: ${langNames.join(", ") || "none"}`);
assert(langNames.length > 0, "at least one grammar");
assert(langNames.includes("typescript"), "typescript grammar");
assert(byExtension.has(".ts"), ".ts extension mapped");

// --- Index ---
console.log("\nIndexing trace source...");
const result = indexProject(TRACE_ROOT);
console.log(`  Indexed ${result.files} files, ${result.symbols} symbols, ${result.calls} calls`);
console.log(`  Languages: ${result.langs.join(", ")}`);

assert(result.files > 0, "files > 0");
assert(result.symbols > 0, "symbols > 0");
assert(result.langs.includes("typescript"), "typescript language detected");

// --- def ---
console.log("\ndef tests:");
const defs = findDefinition("indexProject");
assert(defs.length > 0, "findDefinition('indexProject') returns non-null");
const d = defs[0];
assert(d.kind === "function_declaration", `kind is function_declaration (got ${d.kind})`);
assert(d.file.includes("src/indexer.ts"), `file is src/indexer.ts (got ${d.file})`);
const fileContent = fs.readFileSync(path.join(TRACE_ROOT, d.file), "utf-8");
const bodyLines = fileContent.split("\n").slice(d.start_line - 1, d.end_line);
assert(bodyLines.join("\n").includes("function indexProject"), "body contains function definition");
assert(d.start_line > 0, `start_line > 0 (got ${d.start_line})`);
assert(d.end_line > d.start_line, `end_line > start_line (${d.end_line} > ${d.start_line})`);

const noDefs = findDefinition("nonexistent_symbol_xyz");
assert(noDefs.length === 0, "findDefinition('nonexistent') returns empty array");

// Interface (type_alias_declaration or interface_declaration)
const dInterface = findDefinition("Symbol");
assert(dInterface.length > 0, "findDefinition('Symbol') finds Symbol type/interface");

// --- callers ---
console.log("\ncallers tests:");
const cs = findCallers("indexProject");
assert(cs.length > 0, `findCallers('indexProject') returns results (got ${cs.length})`);

const csDb = findCallers("findDefinition");
assert(csDb.length > 0, `findCallers('findDefinition') returns results (got ${csDb.length})`);

const csNone = findCallers("nonexistent_func_xyz");
assert(csNone.length === 0, "findCallers('nonexistent') returns empty array");

// --- outline ---
console.log("\noutline tests:");
const outline = getOutline("extensions/index.ts");
assert(outline.length > 0, "getOutline('extensions/index.ts') returns symbols");
if (outline.length > 0) {
  assert(outline[0].start_line > 0, "first symbol has start_line > 0");
  assert(
    outline.every((s) => s.start_line > 0),
    "all symbols have valid line ranges",
  );
}

const outlineNone = getOutline("nonexistent/file.ts");
assert(outlineNone.length === 0, "getOutline('nonexistent') returns empty array");

// Default mode now includes nested symbols (methods inside classes, etc.)
assert(
  outline.some((s) => s.parent_id !== null),
  "default outline includes nested symbols",
);

// --- Cleanup ---
closeDb();

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
