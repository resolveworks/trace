import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query } from "web-tree-sitter";

export interface LoadedLang {
  name: string;
  language: Language;
  query: Query;
}

interface LanguageConfig {
  name: string;
  wasm: string;
  queries: string[];
  exts: string[];
}

const configs: LanguageConfig[] = [
  {
    name: "python",
    wasm: "tree-sitter-python/tree-sitter-python.wasm",
    queries: ["python-tags.scm"],
    exts: [".py"],
  },
  {
    name: "rust",
    wasm: "tree-sitter-rust/tree-sitter-rust.wasm",
    queries: ["rust-tags.scm"],
    exts: [".rs"],
  },
  {
    name: "typescript",
    wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm",
    queries: ["javascript-tags.scm", "typescript-tags.scm"],
    exts: [".js", ".ts"],
  },
  {
    name: "tsx",
    wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",
    queries: ["javascript-tags.scm", "typescript-tags.scm", "jsx-tags.scm"],
    exts: [".tsx"],
  },
];

export const byExtension = new Map<string, LoadedLang>();
let parserInitialization: Promise<void> | null = null;
let languageInitialization: Promise<void> | null = null;

const queryDirectory = fileURLToPath(new URL("../queries/", import.meta.url));

function resolvePackageFile(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function readQueries(files: string[]): string {
  return files.map((file) => fs.readFileSync(path.join(queryDirectory, file), "utf-8")).join("\n");
}

/** Initialize the WASM runtime and all configured grammars. */
export function initializeLanguages(): Promise<void> {
  parserInitialization ??= Parser.init();
  languageInitialization ??= (async () => {
    await parserInitialization;
    for (const config of configs) {
      const language = await Language.load(resolvePackageFile(config.wasm));
      const loaded: LoadedLang = {
        name: config.name,
        language,
        query: new Query(language, readQueries(config.queries)),
      };
      for (const extension of config.exts) byExtension.set(extension, loaded);
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
