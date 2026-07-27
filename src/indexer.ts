import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Parser, type Node as SyntaxNode } from "web-tree-sitter";
import { getLanguageForFile, initializeLanguages, type LoadedLang } from "./languages.ts";
import { ProjectFilter } from "./project-filter.ts";
import {
  deleteFile,
  deleteOrphanContents,
  getIndexedFiles,
  insertCall,
  insertSymbol,
  replaceFile,
  updateSymbolParent,
} from "./db.ts";

let parser: Parser | null = null;

/** Initialize the parser after the WASM runtime and grammars are ready. */
export async function initializeIndexer(): Promise<void> {
  await initializeLanguages();
  parser ??= new Parser();
}

export function closeIndexer(): void {
  parser?.delete();
  parser = null;
}

function getParser(): Parser {
  if (!parser) throw new Error("tree-sitter indexer is not initialized");
  return parser;
}

export interface IndexResult {
  files: number;
  changed: number;
  removed: number;
}

export function indexRoot(rootId: number, filter: ProjectFilter, dir = filter.root): IndexResult {
  getParser();
  const files = fs.existsSync(dir) ? collectFiles(dir, filter) : [];
  const indexed = getIndexedFiles(rootId);
  const present = new Set(files);
  let changed = 0;
  let removed = 0;

  for (const file of files) {
    const lang = getLanguageForFile(file)!;
    const sourceFile = readSourceFile(file);
    if (indexed.get(file) === sourceFile.hash) continue;

    indexSourceFile(rootId, file, sourceFile, lang);
    changed++;
  }

  for (const file of indexed.keys()) {
    const relative = path.relative(dir, file);
    const isUnderDir =
      relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
    if (isUnderDir && !present.has(file)) {
      deleteFile(file, false);
      removed++;
    }
  }

  if (removed > 0) deleteOrphanContents();

  return { files: files.length, changed, removed };
}

interface ExtractedDef {
  dbId: number;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

function extractFromTree(root: SyntaxNode, contentId: number, lang: LoadedLang): void {
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
        const dbId = insertSymbol(contentId, name, kind, startLine, endLine);
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
    insertCall(contentId, parent?.dbId ?? null, nameNode.text, line, refNode.endPosition.row + 1);
  }
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

function collectFiles(
  dir: string,
  filter: ProjectFilter,
  visited = new Set<string>([fs.realpathSync(dir)]),
): string[] {
  const results: string[] = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(file);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory && entry.name !== ".pnpm" && filter.includesDirectory(file)) {
      const realpath = fs.realpathSync(file);
      if (visited.has(realpath)) continue;
      visited.add(realpath);
      results.push(...collectFiles(file, filter, visited));
    } else if (isFile && filter.includesFile(file)) {
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
): void {
  replaceFile(rootId, file, sourceFile.hash, lang.name, (contentId) => {
    const activeParser = getParser();
    activeParser.setLanguage(lang.language);
    const tree = activeParser.parse(sourceFile.source);
    if (!tree) throw new Error(`failed to parse source file: ${file}`);
    try {
      extractFromTree(tree.rootNode, contentId, lang);
    } finally {
      tree.delete();
    }
  });
}

export function reindexFile(rootId: number, file: string): void {
  getParser();
  const lang = getLanguageForFile(file);
  if (!lang) throw new Error(`unsupported source file: ${file}`);
  indexSourceFile(rootId, file, readSourceFile(file), lang);
}

export function removeFile(file: string): void {
  deleteFile(file);
}
