import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { Language, Parser, Query } from "web-tree-sitter";

export interface LoadedLang {
  name: string;
  language: Language;
  query: Query;
  extensions: string[];
}

interface LanguageConfig {
  name: string;
  wasm: string;
  tags: string[];
  exts: string[];
}

const configs: LanguageConfig[] = [
  {
    name: "python",
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
    tags: ["tree-sitter-python/queries/tags.scm"],
    exts: [".py"],
  },
  {
    name: "rust",
    wasm: "tree-sitter-rust/tree-sitter-rust.wasm",
    tags: ["tree-sitter-rust/queries/tags.scm"],
    exts: [".rs"],
  },
  {
    name: "typescript",
    wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm",
    tags: ["tree-sitter-typescript/queries/tags.scm", "tree-sitter-javascript/queries/tags.scm"],
    exts: [".js", ".ts"],
  },
  {
    name: "tsx",
    wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",
    tags: [
      "tree-sitter-typescript/queries/tags.scm",
      "tree-sitter-javascript/queries/tags.scm",
      "../queries/jsx-tags.scm",
    ],
    exts: [".tsx"],
  },
];

export const byExtension = new Map<string, LoadedLang>();
let parserInitialization: Promise<void> | null = null;
let languageInitialization: Promise<void> | null = null;

function resolvePackageFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function readTags(specifiers: string[]): string {
  let combined = "";
  for (const specifier of specifiers) {
    combined += fs.readFileSync(resolvePackageFile(specifier), "utf-8") + "\n";
  }
  return combined.replace(/^.*#strip!.*\n?/gm, "").replace(/^.*#select-adjacent!.*\n?/gm, "");
}

/** Initialize the WASM runtime and all configured grammars before indexing. */
export function initializeLanguages(): Promise<void> {
  parserInitialization ??= Parser.init();
  languageInitialization ??= (async () => {
    await parserInitialization;
    for (const config of configs) {
      const language = await Language.load(resolvePackageFile(config.wasm));
      const loaded: LoadedLang = {
        name: config.name,
        language,
        query: new Query(language, readTags(config.tags)),
        extensions: config.exts,
      };
      for (const extension of loaded.extensions) byExtension.set(extension, loaded);
    }
  })();
  return languageInitialization;
}

export function closeLanguages(): void {
  for (const language of new Set(byExtension.values())) language.query.delete();
  byExtension.clear();
  languageInitialization = null;
}

export function getLanguageForFile(filePath: string): LoadedLang | null {
  return byExtension.get(path.extname(filePath).toLowerCase()) ?? null;
}
