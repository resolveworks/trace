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

function readTags(specifiers: string[]): string {
  let combined = "";
  for (const spec of specifiers) {
    combined += fs.readFileSync(new URL(import.meta.resolve(spec)), "utf-8") + "\n";
  }
  return combined.replace(/^.*#strip!.*\n?/gm, "").replace(/^.*#select-adjacent!.*\n?/gm, "");
}

export const byExtension = new Map<string, LoadedLang>();

for (const cfg of [
  {
    name: "python",
    lang: python,
    tags: ["tree-sitter-python/queries/tags.scm"],
    exts: [".py"],
  },
  { name: "rust", lang: rust, tags: ["tree-sitter-rust/queries/tags.scm"], exts: [".rs"] },
  {
    name: "typescript",
    lang: typescript,
    tags: ["tree-sitter-typescript/queries/tags.scm", "tree-sitter-javascript/queries/tags.scm"],
    exts: [".ts"],
  },
  {
    name: "tsx",
    lang: tsx,
    tags: [
      "tree-sitter-typescript/queries/tags.scm",
      "tree-sitter-javascript/queries/tags.scm",
      "../queries/jsx-tags.scm",
    ],
    exts: [".tsx"],
  },
]) {
  const queryText = readTags(cfg.tags);

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
