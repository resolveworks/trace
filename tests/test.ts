import { indexProject } from "../src/indexer.js";
import { findDefinition, findCallers, getOutline, closeDb } from "../src/db.js";
import * as path from "node:path";

const ARBID_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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

// --- Index ---
console.log("Indexing arbid source...");
const result = indexProject(ARBID_ROOT);
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
assert(d.body.includes("function indexProject"), "body contains function definition");
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
const outline = getOutline(path.join(ARBID_ROOT, "extensions/index.ts"));
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

// --- Cleanup ---
closeDb();

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
