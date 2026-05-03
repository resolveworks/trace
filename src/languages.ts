import * as fs from "node:fs";
import * as path from "node:path";
import { Query, type Language } from "tree-sitter";

import python from "tree-sitter-python";
import rust from "tree-sitter-rust";
import tsGrammars from "tree-sitter-typescript";

const { typescript, tsx } = tsGrammars;

// arbid's own package root, where node_modules lives.
const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export interface LoadedLang {
  name: string;
  language: Language;
  query: Query;
  extensions: string[];
}

function loadQuery(lang: Language, pkgName: string, tagPaths: string[]): Query {
  let combined = "";
  for (const tagPath of tagPaths) {
    let fullPath = path.resolve(PKG_ROOT, "node_modules", pkgName, tagPath);
    if (!fs.existsSync(fullPath)) {
      fullPath = path.resolve(PKG_ROOT, tagPath);
    }
    if (fs.existsSync(fullPath)) {
      combined += fs.readFileSync(fullPath, "utf-8") + "\n";
    }
  }
  // Strip unsupported predicates (tree-sitter 0.21 compat).
  combined = combined.replace(/^.*#strip!.*\n?/gm, "").replace(/^.*#select-adjacent!.*\n?/gm, "");
  return new Query(lang, combined);
}

const byExtension = new Map<string, LoadedLang>();

function register(
  name: string,
  language: Language,
  pkgName: string,
  tagPaths: string[],
  extensions: string[],
) {
  const query = loadQuery(language, pkgName, tagPaths);
  const loaded: LoadedLang = { name, language, query, extensions };
  byExtension.set(name, loaded);
  for (const ext of extensions) byExtension.set(ext, loaded);
}

register("python", python, "tree-sitter-python", ["queries/tags.scm"], [".py"]);
register("rust", rust, "tree-sitter-rust", ["queries/tags.scm"], [".rs"]);
register(
  "typescript",
  typescript,
  "tree-sitter-typescript",
  ["queries/tags.scm", "node_modules/tree-sitter-javascript/queries/tags.scm"],
  [".ts"],
);
register(
  "tsx",
  tsx,
  "tree-sitter-typescript",
  ["queries/tags.scm", "node_modules/tree-sitter-javascript/queries/tags.scm"],
  [".tsx"],
);

export function discoverGrammars(): Map<string, LoadedLang> {
  return byExtension;
}

export function getLanguageForFile(
  filePath: string,
  byExt: Map<string, LoadedLang>,
): LoadedLang | null {
  const ext = path.extname(filePath).toLowerCase();
  return byExt.get(ext) ?? null;
}
