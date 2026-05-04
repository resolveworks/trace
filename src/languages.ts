import * as fs from "node:fs";
import * as path from "node:path";
import { Query, type Language } from "tree-sitter";

import python from "tree-sitter-python";
import rust from "tree-sitter-rust";
import tsGrammars from "tree-sitter-typescript";

const { typescript, tsx } = tsGrammars;

export interface LoadedLang {
  name: string;
  language: Language;
  query: Query;
  extensions: string[];
}

function readTags(pkgName: string, tagPaths: string[]): string {
  let combined = "";
  for (const tagPath of tagPaths) {
    const specifier = `${pkgName}/${tagPath}`;
    const resolved = import.meta.resolve(specifier);
    combined += fs.readFileSync(new URL(resolved), "utf-8") + "\n";
  }
  return combined.replace(/^.*#strip!.*\n?/gm, "").replace(/^.*#select-adjacent!.*\n?/gm, "");
}

function loadLocalQuery(filename: string): string {
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(thisDir, "..", "queries", filename), // src/
    path.join(thisDir, "..", "..", "queries", filename), // dist/src/
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf-8") + "\n";
    } catch {
      // try next candidate
    }
  }
  return "";
}

const JSX_TAGS = loadLocalQuery("jsx-tags.scm");

export const byExtension = new Map<string, LoadedLang>();

for (const cfg of [
  {
    name: "python",
    lang: python,
    pkg: "tree-sitter-python",
    tags: ["queries/tags.scm"],
    exts: [".py"],
  },
  { name: "rust", lang: rust, pkg: "tree-sitter-rust", tags: ["queries/tags.scm"], exts: [".rs"] },
  {
    name: "typescript",
    lang: typescript,
    pkg: "tree-sitter-typescript",
    tags: ["queries/tags.scm", "node_modules/tree-sitter-javascript/queries/tags.scm"],
    exts: [".ts"],
  },
  {
    name: "tsx",
    lang: tsx,
    pkg: "tree-sitter-typescript",
    tags: ["queries/tags.scm", "node_modules/tree-sitter-javascript/queries/tags.scm"],
    exts: [".tsx"],
  },
]) {
  let queryText = readTags(cfg.pkg, cfg.tags);
  if (cfg.name === "tsx") {
    queryText += JSX_TAGS;
  }

  const loaded: LoadedLang = {
    name: cfg.name,
    language: cfg.lang,
    query: new Query(cfg.lang, queryText),
    extensions: cfg.exts,
  };
  for (const ext of cfg.exts) byExtension.set(ext, loaded);
}

export function getLanguageForFile(filePath: string): LoadedLang | null {
  return byExtension.get(path.extname(filePath).toLowerCase()) ?? null;
}
