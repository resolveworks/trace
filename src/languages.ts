import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { Query, type Language } from "tree-sitter";

// Dynamic CJS require for tree-sitter grammar packages.
// Pi (jiti) and tsx both resolve ESM, but grammar packages are CJS.
const _require = createRequire(import.meta.url);

// arbid's own package root, where node_modules lives.
const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export interface LoadedLang {
  name: string;
  language: Language;
  query: Query;
  extensions: string[];
}

interface GrammarManifest {
  grammars: {
    name: string;
    "file-types"?: string[];
    tags?: string[];
  }[];
}

/** Resolve the Language object from a grammar module by matching Language.name. */
function resolveLanguage(name: string, langModule: Record<string, unknown>): Language | undefined {
  for (const value of Object.values(langModule)) {
    if (
      value != null &&
      typeof value === "object" &&
      "name" in value &&
      (value as Language).name === name
    ) {
      return value as Language;
    }
  }
  return undefined;
}

/**
 * Load, combine, and sanitize tag query files for a grammar.
 * Resolves each path relative to pkgDir first, then relative to PKG_ROOT
 * (handles hoisted cross-grammar references from pnpm/npm).
 * Strips #strip! and #select-adjacent! predicates unsupported by tree-sitter 0.21.
 */
function loadCombinedQuery(lang: Language, tagPaths: string[], pkgDir: string): Query | null {
  let combined = "";
  for (const tagPath of tagPaths) {
    let fullPath = path.resolve(pkgDir, tagPath);
    if (!fs.existsSync(fullPath)) {
      fullPath = path.resolve(PKG_ROOT, tagPath);
    }
    if (fs.existsSync(fullPath)) {
      combined += fs.readFileSync(fullPath, "utf-8") + "\n";
    }
  }
  if (!combined) return null;

  combined = combined.replace(/^.*#strip!.*\n?/gm, "").replace(/^.*#select-adjacent!.*\n?/gm, "");

  return new Query(lang, combined);
}

/**
 * Discover all installed tree-sitter grammars from arbid's node_modules.
 *
 * Scans for `node_modules/tree-sitter-*` directories that contain a
 * `tree-sitter.json` manifest. For each grammar entry, loads and combines
 * the listed tag query files, resolves the Language object by name, and
 * builds extension → language maps from the `file-types` field.
 */
export function discoverGrammars(): Map<string, LoadedLang> {
  const byExtension = new Map<string, LoadedLang>();

  const nodeModules = path.join(PKG_ROOT, "node_modules");
  if (!fs.existsSync(nodeModules)) return byExtension;

  for (const entry of fs.readdirSync(nodeModules)) {
    if (!entry.startsWith("tree-sitter-")) continue;

    const pkgDir = path.join(nodeModules, entry);
    const manifestPath = path.join(pkgDir, "tree-sitter.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: GrammarManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      continue;
    }

    let langModule: Record<string, unknown>;
    try {
      langModule = _require(entry);
    } catch {
      continue;
    }

    for (const grammar of manifest.grammars) {
      const tagPaths = grammar.tags;
      if (!tagPaths || tagPaths.length === 0) continue;

      const lang = resolveLanguage(grammar.name, langModule);
      if (!lang) continue;

      const query = loadCombinedQuery(lang, tagPaths, pkgDir);
      if (!query) continue;

      const extensions = (grammar["file-types"] ?? []).map((ft) => `.${ft}`);

      byExtension.set(grammar.name, {
        name: grammar.name,
        language: lang,
        query,
        extensions,
      });
      for (const ext of extensions) {
        byExtension.set(ext, {
          name: grammar.name,
          language: lang,
          query,
          extensions,
        });
      }
    }
  }

  return byExtension;
}

/** Look up the LoadedLang for a file path from the discovery result. */
export function getLanguageForFile(
  filePath: string,
  byExtension: Map<string, LoadedLang>,
): LoadedLang | null {
  const ext = path.extname(filePath).toLowerCase();
  return byExtension.get(ext) ?? null;
}
