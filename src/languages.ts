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

/**
 * Discover all installed tree-sitter grammars from arbid's node_modules.
 *
 * Scans for `node_modules/tree-sitter-*` directories that contain a
 * `tree-sitter.json` manifest. For each grammar entry, loads and combines
 * the listed tag query files, resolves the Language object by name, and
 * builds extension → language maps from the `file-types` field.
 */
export function discoverGrammars(): {
  byName: Map<string, LoadedLang>;
  byExtension: Map<string, LoadedLang>;
} {
  const byName = new Map<string, LoadedLang>();
  const byExtension = new Map<string, LoadedLang>();

  const nodeModules = path.join(PKG_ROOT, "node_modules");
  if (!fs.existsSync(nodeModules)) return { byName, byExtension };

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

      // Resolve the Language object by matching `Language.name` to `grammar.name`.
      let lang: Language | undefined;
      for (const value of Object.values(langModule)) {
        if (
          value != null &&
          typeof value === "object" &&
          "name" in value &&
          (value as Language).name === grammar.name
        ) {
          lang = value as Language;
          break;
        }
      }
      if (!lang) continue;

      // Combine all listed tag query files. Paths are relative to the grammar
      // package, but npm/pnpm may hoist cross-grammar references to our root.
      let combinedQuery = "";
      for (const tagPath of tagPaths) {
        let fullPath = path.resolve(pkgDir, tagPath);
        if (!fs.existsSync(fullPath)) {
          fullPath = path.resolve(PKG_ROOT, tagPath);
        }
        if (fs.existsSync(fullPath)) {
          combinedQuery += fs.readFileSync(fullPath, "utf-8") + "\n";
        }
      }
      if (!combinedQuery) continue;

      // Strip query predicates unsupported by tree-sitter 0.21.
      // #strip! and #select-adjacent! only affect @doc captures, which we ignore.
      combinedQuery = combinedQuery
        .replace(/^.*#strip!.*\n?/gm, "")
        .replace(/^.*#select-adjacent!.*\n?/gm, "");

      const query = new Query(lang, combinedQuery);
      const extensions = (grammar["file-types"] ?? []).map((ft) => `.${ft}`);

      const loaded: LoadedLang = {
        name: grammar.name,
        language: lang,
        query,
        extensions,
      };

      byName.set(grammar.name, loaded);
      for (const ext of extensions) {
        byExtension.set(ext, loaded);
      }
    }
  }

  return { byName, byExtension };
}

/** Look up the LoadedLang for a file path from the discovery result. */
export function getLanguageForFile(
  filePath: string,
  byExtension: Map<string, LoadedLang>,
): LoadedLang | null {
  const ext = path.extname(filePath).toLowerCase();
  return byExtension.get(ext) ?? null;
}
