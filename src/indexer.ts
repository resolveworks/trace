import * as fs from "node:fs";
import * as path from "node:path";
import Parser, { type SyntaxNode } from "tree-sitter";
import { getLanguageForFile, getSupportedExtensions } from "./languages.js";
import {
  openDb,
  clearAll,
  insertSymbol,
  insertCall,
} from "./db.js";

const parser = new Parser();

export function indexProject(rootDir: string): { files: number; symbols: number; calls: number; langs: string[] } {
  openDb();
  clearAll();

  const supportedExts = getSupportedExtensions();
  const files = collectFiles(rootDir, supportedExts);
  let totalSymbols = 0;
  let totalCalls = 0;
  const langs = new Set<string>();

  for (const file of files) {
    const lang = getLanguageForFile(file);
    if (!lang) continue;
    langs.add(lang.name);

    const source = fs.readFileSync(file, "utf-8");
    parser.setLanguage(lang.language);
    const tree = parser.parse(source);

    const { symbols, callCount } = extractFromTree(tree.rootNode, source, file, lang);
    totalSymbols += symbols;
    totalCalls += callCount;
  }

  return { files: files.length, symbols: totalSymbols, calls: totalCalls, langs: [...langs].sort() };
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
  lang: import("./languages.js").LoadedLang,
): { symbols: number; callCount: number } {
  const matches = lang.query.matches(root);

  // First pass: collect all definitions and their DB IDs
  const defMap = new Map<string, ExtractedDef>(); // key: "name|startLine"

  for (const match of matches) {
    let defNode: SyntaxNode | null = null;
    let nameNode: SyntaxNode | null = null;

    for (const cap of match.captures) {
      if (cap.name.startsWith("definition.")) {
        defNode = cap.node;
      } else if (cap.name.startsWith("name.definition.")) {
        nameNode = cap.node;
      }
    }

    if (defNode && nameNode) {
      const kind = defNode.type;
      const name = nameNode.text;
      const startLine = defNode.startPosition.row + 1;
      const endLine = defNode.endPosition.row + 1;
      const body = source.slice(defNode.startIndex, defNode.endIndex);

      // Deduplicate: same name at same start line = already seen
      const key = `${name}|${startLine}`;
      if (!defMap.has(key)) {
        const dbId = insertSymbol(name, kind, file, startLine, endLine, body);
        defMap.set(key, { dbId, name, kind, startLine, endLine });
      }
    }
  }

  // Third pass: collect call references, handling file-level calls
  let callCount = 0;
  const defs = [...defMap.values()];

  // Add a synthetic file-level symbol for calls not inside any named definition
  const fileSymbol: ExtractedDef = {
    dbId: insertSymbol(`<file> ${path.basename(file)}`, "(file-level)", file, 1, root.endPosition.row + 1, ""),
    name: `(file) ${path.basename(file)}`,
    kind: "file",
    startLine: 1,
    endLine: root.endPosition.row + 1,
  };

  for (const match of matches) {
    let callNode: SyntaxNode | null = null;
    let nameNode: SyntaxNode | null = null;

    for (const cap of match.captures) {
      if (cap.name === "reference.call") {
        callNode = cap.node;
      } else if (cap.name === "name.reference.call") {
        nameNode = cap.node;
      }
    }

    if (callNode && nameNode) {
      const calleeName = nameNode.text;
      const line = callNode.startPosition.row + 1;

      // Find the enclosing definition (innermost def that contains this call)
      const parent = findEnclosingDef(callNode.startPosition.row + 1, defs) ?? fileSymbol;
      if (parent) {
        insertCall(parent.dbId, parent.name, calleeName, file, line);
        callCount++;
      }
    }
  }

  return { symbols: defMap.size, callCount };
}

function findEnclosingDef(
  line: number,
  defs: ExtractedDef[],
): ExtractedDef | null {
  let best: ExtractedDef | null = null;
  let bestSize = Infinity;
  for (const d of defs) {
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

function collectFiles(dir: string, supportedExts: Set<string>): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "dist" &&
        entry.name !== "build" &&
        entry.name !== ".git" &&
        entry.name !== "target" &&
        entry.name !== "__pycache__" &&
        entry.name !== ".venv" &&
        entry.name !== "vendor"
      ) {
        results.push(...collectFiles(fullPath, supportedExts));
      }
    } else if (entry.isFile() && supportedExts.has(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }

  return results;
}
