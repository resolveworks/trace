import * as fs from "node:fs";
import * as path from "node:path";
import Parser, { type SyntaxNode } from "tree-sitter";
import { getLanguageForFile, type LoadedLang } from "./languages.js";
import { ProjectFilter } from "./project-filter.js";
import {
  openDb,
  clearAll,
  deleteByFile,
  insertSymbol,
  insertCall,
  updateSymbolParent,
} from "./db.js";

const parser = new Parser();

export function indexProject(filter: ProjectFilter): {
  files: number;
  symbols: number;
  calls: number;
  langs: string[];
} {
  openDb();
  clearAll();

  const root = filter.root;
  const files = collectFiles(root, root, filter);
  let totalSymbols = 0;
  let totalCalls = 0;
  const langs = new Set<string>();

  for (const file of files) {
    const lang = getLanguageForFile(file)!;
    langs.add(lang.name);

    try {
      const source = fs.readFileSync(path.join(root, file), "utf-8");
      parser.setLanguage(lang.language);
      const tree = parser.parse(source);

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

function collectFiles(dir: string, root: string, filter: ProjectFilter): string[] {
  const results: string[] = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory() && filter.includesDirectory(filePath)) {
      results.push(...collectFiles(filePath, root, filter));
    } else if (entry.isFile() && filter.includesFile(filePath)) {
      results.push(path.relative(root, filePath));
    }
  }
  return results;
}

/** Re-index a single source file, replacing any existing entries for it. */
export function reindexFile(rootDir: string, filePath: string): void {
  const lang = getLanguageForFile(filePath);
  if (!lang) return;

  try {
    const source = fs.readFileSync(path.resolve(rootDir, filePath), "utf-8");
    parser.setLanguage(lang.language);
    const tree = parser.parse(source);

    deleteByFile(filePath);
    extractFromTree(tree.rootNode, source, filePath, lang);
  } catch {
    // skip files that tree-sitter can't parse
  }
}

/** Remove a file's entries from the index. */
export function removeFile(filePath: string): void {
  deleteByFile(filePath);
}
