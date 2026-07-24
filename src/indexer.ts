import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Parser, { type SyntaxNode } from "tree-sitter";
import { getLanguageForFile, type LoadedLang } from "./languages.ts";
import { ProjectFilter } from "./project-filter.ts";
import {
  deleteFile,
  getIndexedFiles,
  insertCall,
  insertSymbol,
  replaceFile,
  updateSymbolParent,
} from "./db.ts";

const parser = new Parser();

export interface IndexResult {
  files: number;
  changed: number;
  removed: number;
  symbols: number;
  calls: number;
  langs: string[];
}

export function indexRoot(rootId: number, filter: ProjectFilter): IndexResult {
  const files = collectFiles(filter.root, filter);
  const indexed = getIndexedFiles(rootId);
  const present = new Set(files);
  let changed = 0;
  let removed = 0;
  let symbols = 0;
  let calls = 0;
  const langs = new Set<string>();

  for (const file of files) {
    const lang = getLanguageForFile(file)!;
    langs.add(lang.name);
    const sourceFile = readSourceFile(file);
    const previous = indexed.get(file);
    if (previous === sourceFile.hash) continue;

    const result = indexSourceFile(rootId, file, sourceFile, lang);
    changed++;
    symbols += result.symbols;
    calls += result.calls;
  }

  for (const file of indexed.keys()) {
    if (!present.has(file)) {
      deleteFile(file);
      removed++;
    }
  }

  return {
    files: files.length,
    changed,
    removed,
    symbols,
    calls,
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
  fileId: number,
  lang: LoadedLang,
): { symbols: number; calls: number } {
  const defMap = new Map<string, ExtractedDef>();
  const refBuffer: { refNode: SyntaxNode; nameNode: SyntaxNode }[] = [];

  for (const match of lang.query.matches(root)) {
    let defNode: SyntaxNode | null = null;
    let refNode: SyntaxNode | null = null;
    let nameNode: SyntaxNode | null = null;

    for (const capture of match.captures) {
      if (capture.name.startsWith("definition.")) {
        defNode = capture.node;
      } else if (capture.name.startsWith("reference.")) {
        refNode = capture.node;
      } else if (capture.name === "name") {
        nameNode = capture.node;
      }
    }

    if (defNode && nameNode) {
      const name = nameNode.text;
      const startLine = defNode.startPosition.row + 1;
      const key = `${name}|${startLine}`;
      if (!defMap.has(key)) {
        const kind = defNode.type;
        const endLine = defNode.endPosition.row + 1;
        const dbId = insertSymbol(fileId, name, kind, startLine, endLine);
        defMap.set(key, { dbId, name, kind, startLine, endLine });
      }
    } else if (refNode && nameNode) {
      refBuffer.push({ refNode, nameNode });
    }
  }

  const definitions = [...defMap.values()];
  for (const definition of definitions) {
    const parent = findEnclosingDef(definition.startLine, definitions, definition.dbId);
    if (parent) updateSymbolParent(definition.dbId, parent.dbId);
  }

  for (const { refNode, nameNode } of refBuffer) {
    const line = refNode.startPosition.row + 1;
    const parent = findEnclosingDef(line, definitions);
    insertCall(fileId, parent?.dbId ?? null, nameNode.text, line, refNode.endPosition.row + 1);
  }

  return { symbols: defMap.size, calls: refBuffer.length };
}

function findEnclosingDef(
  line: number,
  definitions: ExtractedDef[],
  excludeId?: number,
): ExtractedDef | null {
  let best: ExtractedDef | null = null;
  let bestSize = Infinity;
  for (const definition of definitions) {
    if (definition.dbId === excludeId) continue;
    if (line >= definition.startLine && line <= definition.endLine) {
      const size = definition.endLine - definition.startLine;
      if (size < bestSize) {
        bestSize = size;
        best = definition;
      }
    }
  }
  return best;
}

function collectFiles(dir: string, filter: ProjectFilter): string[] {
  const results: string[] = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && filter.includesDirectory(file)) {
      results.push(...collectFiles(file, filter));
    } else if (entry.isFile() && filter.includesFile(file)) {
      results.push(file);
    }
  }
  return results;
}

interface SourceFile {
  source: string;
  hash: string;
}

function readSourceFile(file: string): SourceFile {
  const source = fs.readFileSync(file, "utf-8");
  return {
    source,
    hash: createHash("sha256").update(source).digest("hex"),
  };
}

function indexSourceFile(
  rootId: number,
  file: string,
  sourceFile: SourceFile,
  lang: LoadedLang,
): { symbols: number; calls: number } {
  parser.setLanguage(lang.language);
  const tree = parser.parse(sourceFile.source);
  let result = { symbols: 0, calls: 0 };
  replaceFile(rootId, file, sourceFile.hash, (fileId) => {
    result = extractFromTree(tree.rootNode, fileId, lang);
  });
  return result;
}

export function reindexFile(rootId: number, file: string): { symbols: number; calls: number } {
  const lang = getLanguageForFile(file);
  if (!lang) throw new Error(`unsupported source file: ${file}`);
  return indexSourceFile(rootId, file, readSourceFile(file), lang);
}

export function removeFile(file: string): void {
  deleteFile(file);
}
