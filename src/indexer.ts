import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import Parser, { type SyntaxNode, type Tree } from "tree-sitter";
import { getLanguageForFile, byExtension, type LoadedLang } from "./languages.js";
import {
  openDb,
  clearAll,
  deleteByFile,
  insertSymbol,
  insertCall,
  updateSymbolParent,
} from "./db.js";

const parser = new Parser();
const treeCache = new Map<string, Tree>();

export function indexProject(rootDir: string): {
  files: number;
  symbols: number;
  calls: number;
  langs: string[];
} {
  openDb();
  clearAll();

  const files = collectFiles(rootDir, rootDir);
  let totalSymbols = 0;
  let totalCalls = 0;
  const langs = new Set<string>();

  for (const file of files) {
    const lang = getLanguageForFile(file);
    if (!lang) continue;
    langs.add(lang.name);

    try {
      const source = fs.readFileSync(file, "utf-8");
      parser.setLanguage(lang.language);
      const tree = parser.parse(source);
      treeCache.set(file, tree);

      const { symbols, callCount } = extractFromTree(tree.rootNode, source, file, lang);
      totalSymbols += symbols;
      totalCalls += callCount;
    } catch {
      // skip files that tree-sitter can't parse
    }
  }

  return {
    files: files.length,
    symbols: totalSymbols,
    calls: totalCalls,
    langs: [...langs].sort(),
  };
}

interface ExtractedDef {
  dbId: number;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

function extractFromTree(
  root: SyntaxNode,
  source: string,
  file: string,
  lang: LoadedLang,
): { symbols: number; callCount: number } {
  // Native tags.scm convention: @definition.X marks a definition node, @reference.X marks a
  // reference node, @name marks the identifier. A single match pairs e.g. @definition.function
  // with @name, or @reference.call with @name.
  //
  // We make a single pass over matches: collect definitions immediately, buffer references
  // for attribution after all defs are known.
  const defMap = new Map<string, ExtractedDef>(); // key: "name|startLine"
  const refBuffer: { refNode: SyntaxNode; nameNode: SyntaxNode }[] = [];

  for (const match of lang.query.matches(root)) {
    let defNode: SyntaxNode | null = null;
    let refNode: SyntaxNode | null = null;
    let nameNode: SyntaxNode | null = null;

    for (const cap of match.captures) {
      if (cap.name.startsWith("definition.")) {
        defNode = cap.node;
      } else if (cap.name.startsWith("reference.")) {
        refNode = cap.node;
      } else if (cap.name === "name") {
        nameNode = cap.node;
      }
    }

    if (defNode && nameNode) {
      const kind = defNode.type;
      const name = nameNode.text;
      const startLine = defNode.startPosition.row + 1;
      const endLine = defNode.endPosition.row + 1;
      const body = source.slice(defNode.startIndex, defNode.endIndex);

      const key = `${name}|${startLine}`;
      if (!defMap.has(key)) {
        const dbId = insertSymbol(name, kind, file, startLine, endLine);
        defMap.set(key, { dbId, name, kind, startLine, endLine });
      }
    } else if (refNode && nameNode) {
      refBuffer.push({ refNode, nameNode });
    }
  }

  // Compute parent relationships for nested definitions (e.g. methods inside classes)
  const allDefs = [...defMap.values()];
  for (const d of allDefs) {
    const parent = findEnclosingDef(d.startLine, allDefs, d.dbId);
    if (parent) {
      updateSymbolParent(d.dbId, parent.dbId);
    }
  }

  // Attribute each buffered reference to its nearest enclosing definition,
  // or leave caller_id NULL for file-level references.
  let callCount = 0;
  if (refBuffer.length > 0) {
    for (const { refNode, nameNode } of refBuffer) {
      const calleeName = nameNode.text;
      const line = refNode.startPosition.row + 1;
      const parent = findEnclosingDef(refNode.startPosition.row + 1, allDefs);
      insertCall(parent?.dbId ?? null, calleeName, file, line, refNode.endPosition.row + 1);
      callCount++;
    }
  }

  return { symbols: defMap.size, callCount };
}

function findEnclosingDef(
  line: number,
  defs: ExtractedDef[],
  excludeId?: number,
): ExtractedDef | null {
  let best: ExtractedDef | null = null;
  let bestSize = Infinity;
  for (const d of defs) {
    if (excludeId !== undefined && d.dbId === excludeId) continue;
    if (line >= d.startLine && line <= d.endLine) {
      const size = d.endLine - d.startLine;
      if (size < bestSize) {
        bestSize = size;
        best = d;
      }
    }
  }
  return best;
}

interface IgnoreEntry {
  dir: string;
  ig: ReturnType<typeof ignore>;
}

function isIgnored(fullPath: string, ignoreChain: IgnoreEntry[]): boolean {
  let result = false;
  for (const { dir, ig } of ignoreChain) {
    const rel = path.relative(dir, fullPath).replace(/\\/g, "/");
    if (rel.startsWith("..") || rel === "") continue;
    const t = ig.test(rel);
    if (t.ignored || t.unignored) {
      result = t.ignored;
    }
  }
  return result;
}

function collectFiles(dir: string, rootDir: string, ignoreChain: IgnoreEntry[] = []): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  const gitignorePath = path.join(dir, ".gitignore");
  let chain = ignoreChain;
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      chain = [...ignoreChain, { dir, ig: ignore().add(content) }];
    } catch {
      // malformed or unreadable .gitignore — skip it
    }
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.name === ".git") continue;
    if (isIgnored(fullPath, chain)) continue;

    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, rootDir, chain));
    } else if (entry.isFile() && byExtension.has(path.extname(entry.name).toLowerCase())) {
      results.push(path.relative(rootDir, fullPath));
    }
  }

  return results;
}

/**
 * Re-index a single file, replacing any existing entries for it.
 * Uses tree-sitter incremental parsing when a previous tree is cached.
 */
export function reindexFile(filePath: string): void {
  const lang = getLanguageForFile(filePath);
  if (!lang) return;

  try {
    const source = fs.readFileSync(filePath, "utf-8");
    parser.setLanguage(lang.language);

    const oldTree = treeCache.get(filePath);
    const tree = parser.parse(source, oldTree);
    treeCache.set(filePath, tree);

    deleteByFile(filePath);
    extractFromTree(tree.rootNode, source, filePath, lang);
  } catch {
    // skip files that tree-sitter can't parse
  }
}

/** Remove a file's entries from the index and tree cache. */
export function removeFile(filePath: string): void {
  treeCache.delete(filePath);
  deleteByFile(filePath);
}

/** Clear the tree cache (e.g. on session shutdown). */
export function clearTreeCache(): void {
  treeCache.clear();
}
