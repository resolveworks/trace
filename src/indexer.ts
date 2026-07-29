import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { Parser, type Node as SyntaxNode } from "web-tree-sitter";
import { isPathMissing } from "./fs-errors.ts";
import { getLanguageForFile, initializeLanguages, type LoadedLang } from "./languages.ts";
import { SourceFilter } from "./source-filter.ts";
import { walkSourceFiles } from "./traverse.ts";
import {
  deleteFiles,
  getFileStatsInScope,
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

/** Reconcile one directory and remove stale rows within the same query domain. */
export function reconcileDirectory(filter: SourceFilter, dir: string): void {
  getParser();
  let files: string[];
  try {
    files = walkSourceFiles(filter, dir);
  } catch (error) {
    if (!isPathMissing(error)) throw error;
    files = [];
  }

  const includeEnvironments = filter.isEnvironmentPath(dir);
  const indexed = getFileStatsInScope(dir, includeEnvironments);
  const present = new Set<string>();

  for (const file of files) {
    try {
      const stat = statSourceFile(file);
      if (!stat) continue;
      const current = indexed.get(file);
      if (!current || !sameStat(current, stat)) indexSourceFile(filter, file, stat);
      present.add(file);
    } catch (error) {
      if (!isPathMissing(error)) throw error;
    }
  }

  deleteFiles([...indexed.keys()].filter((file) => !present.has(file)));
}

/** Reconcile one exact file scope, including stale rows from a replaced directory. */
export function reconcileFile(filter: SourceFilter, file: string): boolean {
  getParser();
  const indexed = getFileStatsInScope(file, true);
  const cachedPaths = [...indexed.keys()];
  const descendants = cachedPaths.filter((candidate) => candidate !== file);

  if (!filter.includesFile(file)) {
    deleteFiles(cachedPaths);
    return false;
  }

  try {
    const stat = statSourceFile(file);
    if (!stat) {
      deleteFiles(cachedPaths);
      return false;
    }
    const current = indexed.get(file);
    if (!current || !sameStat(current, stat)) indexSourceFile(filter, file, stat);
    deleteFiles(descendants);
    return true;
  } catch (error) {
    if (!isPathMissing(error)) throw error;
    deleteFiles(cachedPaths);
    return false;
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
function indexSourceFile(filter: SourceFilter, file: string, stat: FileStat): void {
  const lang = getLanguageForFile(file);
  if (!lang) throw new Error(`unsupported source file: ${file}`);
  const source = fs.readFileSync(file, "utf-8");
  const hash = createHash("sha256").update(source).digest("hex");
  replaceFile(file, stat, hash, lang.name, filter.isEnvironmentPath(file), (contentId) => {
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
  startIndex: number;
  endIndex: number;
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
      } else if (capture.name === "reference.call") {
        refNode = capture.node;
      } else if (capture.name === "name") {
        nameNode = capture.node;
      }
    }

    if (defNode && nameNode) {
      const name = nameNode.text;
      const startLine = defNode.startPosition.row + 1;
      const key = `${name}|${defNode.startIndex}`;
      if (!defMap.has(key)) {
        const kind = defNode.type;
        const endLine = defNode.endPosition.row + 1;
        const dbId = insertSymbol(contentId, name, kind, startLine, endLine);
        defMap.set(key, {
          dbId,
          name,
          kind,
          startLine,
          endLine,
          startIndex: defNode.startIndex,
          endIndex: defNode.endIndex,
        });
      }
    } else if (refNode && nameNode) {
      refBuffer.push({ refNode, nameNode });
    }
  }

  const definitions = [...defMap.values()];
  for (const definition of definitions) {
    const parent = findEnclosingDef(
      definition.startIndex,
      definition.endIndex,
      definitions,
      definition.dbId,
    );
    if (parent) updateSymbolParent(definition.dbId, parent.dbId);
  }

  for (const { refNode, nameNode } of refBuffer) {
    const line = refNode.startPosition.row + 1;
    const parent = findEnclosingDef(refNode.startIndex, refNode.endIndex, definitions);
    insertCall(contentId, parent?.dbId ?? null, nameNode.text, line, refNode.endPosition.row + 1);
  }
}

function findEnclosingDef(
  startIndex: number,
  endIndex: number,
  definitions: ExtractedDef[],
  excludeId?: number,
): ExtractedDef | null {
  let best: ExtractedDef | null = null;
  let bestSize = Infinity;
  for (const definition of definitions) {
    if (definition.dbId === excludeId) continue;
    const strictlyContains =
      startIndex >= definition.startIndex &&
      endIndex <= definition.endIndex &&
      (startIndex > definition.startIndex || endIndex < definition.endIndex);
    if (strictlyContains) {
      const size = definition.endIndex - definition.startIndex;
      if (size < bestSize) {
        bestSize = size;
        best = definition;
      }
    }
  }
  return best;
}
