import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import Parser, { Query, type Language } from "tree-sitter";

// createRequire is needed because dynamic tree-sitter grammar loading uses CJS require.
// Pi (via jiti) and tsx both resolve ESM imports, but the grammar packages are CJS.
const _require = createRequire(import.meta.url);

// Mapping: extension → language name (matches Aider query filenames without .scm)
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "c_sharp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".elm": "elm",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".jl": "julia",
  ".zig": "zig",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".hcl": "hcl",
  ".tf": "hcl",
  ".el": "elisp",
  ".f90": "fortran",
  ".f95": "fortran",
  ".f03": "fortran",
  ".ql": "ql",
  ".m": "matlab",
};

// Mapping: language name → npm package name
const LANG_TO_PKG: Record<string, string> = {
  typescript: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
  rust: "tree-sitter-rust",
  go: "tree-sitter-go",
  java: "tree-sitter-java",
  ruby: "tree-sitter-ruby",
  php: "tree-sitter-php",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  c_sharp: "tree-sitter-c-sharp",
  kotlin: "tree-sitter-kotlin",
  scala: "tree-sitter-scala",
  dart: "tree-sitter-dart",
  elixir: "tree-sitter-elixir",
  elm: "tree-sitter-elm",
  haskell: "tree-sitter-haskell",
  julia: "tree-sitter-julia",
  zig: "tree-sitter-zig",
  ocaml: "tree-sitter-ocaml",
  hcl: "tree-sitter-hcl",
  elisp: "tree-sitter-elisp",
  fortran: "tree-sitter-fortran",
  ql: "tree-sitter-ql",
  matlab: "tree-sitter-matlab",
};

export interface LoadedLang {
  name: string;
  language: Language;
  query: Query;
  extensions: string[];
}

const loaded: Map<string, LoadedLang> = new Map();
const queriesDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "queries",
);

function loadLanguage(langName: string): LoadedLang | null {
  const cached = loaded.get(langName);
  if (cached) return cached;

  const pkgName = LANG_TO_PKG[langName];
  if (!pkgName) return null;

  try {
    // Dynamic import of the tree-sitter grammar package
    // @ts-expect-error dynamic require
    const pkg = _require(pkgName) as Record<string, unknown>;

    // Look for the language export (usually pkg.<langname> or pkg.default)
    let lang: Language | undefined;
    if (langName === "typescript" || langName === "javascript") {
      // tree-sitter-typescript exports { typescript, tsx }
      // tree-sitter-javascript exports { default }
      lang = (pkg as { typescript?: Language }).typescript ?? (pkg as { default?: Language }).default;
    } else if (langName === "ocaml") {
      lang = (pkg as { ocaml: Language }).ocaml;
    } else {
      // Most packages export the language as default or named
      lang = (pkg as { default?: Language }).default ?? (pkg as Record<string, Language>)[langName];
    }
    if (!lang) return null;

    // Load the query file
    const queryPath = path.join(queriesDir, `${langName}.scm`);
    if (!fs.existsSync(queryPath)) return null;
    const querySrc = fs.readFileSync(queryPath, "utf-8");
    const query = new Query(lang, querySrc);

    // Collect extensions for this language
    const extensions = Object.entries(EXT_TO_LANG)
      .filter(([, l]) => l === langName)
      .map(([ext]) => ext);

    const result = { name: langName, language: lang, query, extensions };
    loaded.set(langName, result);
    return result;
  } catch {
    // Grammar package not installed or failed to load
    return null;
  }
}

/**
 * Get the loaded language for a file path, or null if no grammar is available.
 */
export function getLanguageForFile(filePath: string): LoadedLang | null {
  const ext = path.extname(filePath).toLowerCase();
  const langName = EXT_TO_LANG[ext];
  if (!langName) return null;
  return loadLanguage(langName);
}

/**
 * List all languages that have grammars installed and can be indexed.
 */
export function getAvailableLanguages(): string[] {
  const langs: string[] = [];
  for (const langName of new Set(Object.values(EXT_TO_LANG))) {
    if (loadLanguage(langName)) langs.push(langName);
  }
  return langs;
}

/**
 * Check which file extensions are supported (grammar installed + query available).
 */
export function getSupportedExtensions(): Set<string> {
  const exts = new Set<string>();
  for (const [ext, langName] of Object.entries(EXT_TO_LANG)) {
    if (loadLanguage(langName)) exts.add(ext);
  }
  return exts;
}
