import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { Parser, type Node as SyntaxNode } from "web-tree-sitter";
import { isPathMissing } from "./fs-errors.ts";
import { getLanguageForFile, initializeLanguages, type LoadedLang } from "./languages.ts";
import { ProjectFilter } from "./project-filter.ts";
import { walkDirectories, type TraversalMode } from "./traverse.ts";
import { contains } from "./config.ts";
import {
  deleteFiles,
  getIndexedFile,
  getIndexedFiles,
  insertCall,
  insertSymbol,
  replaceFile,
  sameStat,
  updateSymbolParent,
  type FileStat,
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

export function indexRoot(
  rootId: number,
  filter: ProjectFilter,
  dir = filter.root,
  traversalMode: TraversalMode = "index",
): IndexResult {
  getParser();
  let files: string[];
  try {
    files = walkDirectories(filter, dir, undefined, traversalMode).flatMap(
      (listing) => listing.files,
    );
  } catch (error) {
    if (dir === filter.root || !isPathMissing(error)) throw error;
    files = [];
  }
  const indexed = getIndexedFiles(rootId);
  const present = new Set<string>();
  let changed = 0;

  for (const file of files) {
    try {
      const stat = statSourceFile(file);
      if (!stat) continue;
      const current = indexed.get(file);
      if (!current || !sameStat(current, stat)) {
        indexSourceFile(rootId, file, stat);
        changed++;
      }
      present.add(file);
    } catch (error) {
      if (!isPathMissing(error)) throw error;
    }
  }

  const missing: string[] = [];
  for (const file of indexed.keys()) {
    if (traversalMode === "watch" && filter.isEnvironmentPath(file)) continue;
    if (contains(dir, file) && !present.has(file)) missing.push(file);
  }
  deleteFiles(missing);

  return { files: present.size, changed, removed: missing.length };
}

/** Reconcile one file after a watcher event. */
export function reindexFile(rootId: number, file: string): void {
  getParser();
  try {
    const stat = statSourceFile(file);
    if (stat) indexSourceFile(rootId, file, stat);
    else deleteFiles([file]);
  } catch (error) {
    if (!isPathMissing(error)) throw error;
    deleteFiles([file]);
  }
}

/** Stat-based reconciliation for an exact dependency query scope. */
export function reconcileFile(rootId: number, filter: ProjectFilter, file: string): void {
  getParser();
  if (!filter.includesFile(file)) {
    deleteFiles([file]);
    return;
  }

  try {
    const stat = statSourceFile(file);
    if (!stat) {
      deleteFiles([file]);
      return;
    }
    const current = getIndexedFile(file);
    if (!current || !sameStat(current, stat)) indexSourceFile(rootId, file, stat);
  } catch (error) {
    if (!isPathMissing(error)) throw error;
    deleteFiles([file]);
  }
}

/** Freshness hint for a regular, non-symlink source file. */
function statSourceFile(file: string): FileStat | null {
  const stats = fs.lstatSync(file, { bigint: true });
  if (!stats.isFile()) return null;
  return { size: stats.size, mtimeNs: stats.mtimeNs };
}

/**
 * Point a file at its content, parsing only when the content has never been
 * seen. Identical bytes under the same grammar at distinct indexed paths
 * share one content row.
 */
function indexSourceFile(rootId: number, file: string, stat: FileStat): void {
  const lang = getLanguageForFile(file);
  if (!lang) throw new Error(`unsupported source file: ${file}`);
  const source = fs.readFileSync(file, "utf-8");
  const hash = createHash("sha256").update(source).digest("hex");
  replaceFile(rootId, file, stat, hash, lang.name, (contentId) => {
    const activeParser = getParser();
    activeParser.setLanguage(lang.language);
    const tree = activeParser.parse(source);
    if (!tree) throw new Error(`failed to parse source file: ${file}`);
    try {
      extractFromTree(tree.rootNode, contentId, lang);
    } finally {
      tree.delete();
    }
  });
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
