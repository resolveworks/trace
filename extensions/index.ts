import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import chokidar, { type FSWatcher } from "chokidar";
import { byExtension } from "../src/languages.js";
import { indexProject, reindexFile, removeFile, clearTreeCache } from "../src/indexer.js";
import {
  findDefinition,
  findCallers,
  getOutline,
  getDirOutline,
  closeDb,
  openDb,
  type OutlineSymbol,
  type DirSymbol,
} from "../src/db.js";

// Kinds that represent executable code blocks; we don't descend into their
// children in deep outline mode (avoids showing local arrow functions, etc.)
const FUNCTION_LIKE_KINDS = new Set([
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "lexical_declaration",
  "variable_declaration",
  "assignment_expression",
  "pair",
]);

function shortKind(kind: string): string {
  return kind
    .replace(/_declaration$/, "")
    .replace(/_definition$/, "")
    .replace(/_signature$/, "");
}

function buildSymbolTree(symbols: OutlineSymbol[]): Map<number | null, OutlineSymbol[]> {
  const map = new Map<number | null, OutlineSymbol[]>();
  for (const s of symbols) {
    const key = s.parent_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  for (const children of map.values()) {
    children.sort((a, b) => a.start_line - b.start_line);
  }
  return map;
}

function renderTreeLines(
  tree: Map<number | null, OutlineSymbol[]>,
  parentId: number | null = null,
  indent: string = "",
): string[] {
  const children = tree.get(parentId) ?? [];
  const lines: string[] = [];
  for (const s of children) {
    lines.push(`${indent}${s.name} (${shortKind(s.kind)}) — lines ${s.start_line}-${s.end_line}`);
    if (!FUNCTION_LIKE_KINDS.has(s.kind)) {
      lines.push(...renderTreeLines(tree, s.id, indent + "  "));
    }
  }
  return lines;
}

export default function (pi: ExtensionAPI) {
  let watcher: FSWatcher | null = null;

  pi.on("session_start", async (_event, ctx) => {
    openDb();
    try {
      const result = indexProject(ctx.cwd);
      ctx.ui.notify(
        `arbid: indexed ${result.files} files, ${result.symbols} symbols, ${result.calls} calls (${result.langs.join(", ") || "none"})`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(`arbid: index failed — ${err}`, "error");
      return;
    }

    watcher = chokidar.watch(ctx.cwd, { ignoreInitial: true });

    const relPath = (p: string) => path.relative(ctx.cwd, p);

    watcher.on("add", (filePath: string) => {
      reindexFile(relPath(filePath));
    });

    watcher.on("change", (filePath: string) => {
      reindexFile(relPath(filePath));
    });

    watcher.on("unlink", (filePath: string) => {
      removeFile(relPath(filePath));
    });
  });

  pi.on("session_shutdown", async () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    clearTreeCache();
    closeDb();
  });

  // def(name) — get function/class definition
  pi.registerTool({
    name: "def",
    label: "Definition",
    description:
      "Return the full source body of a function, class, method, type, or interface by name. Returns the entire definition — matched braces/brackets, all inner code — with file path and precise line range. One call gets you the complete implementation.",
    promptSnippet: "Look up a named definition and return its full body",
    promptGuidelines: [
      "Use def to get a function/class/type's complete body as one unit. Returns the exact code block with matched delimiters and line range.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the symbol to look up" }),
      file: Type.Optional(
        Type.String({
          description: "Optional file path to narrow the search (relative to project root)",
        }),
      ),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("def "));
      text += theme.fg("accent", args.name);
      if (args.file) {
        text += theme.fg("dim", " in " + args.file);
      }
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = findDefinition(params.name, params.file);
      if (results.length === 0) {
        const scope = params.file ? ` in "${params.file}"` : "";
        return {
          content: [
            { type: "text" as const, text: `No definition found for "${params.name}"${scope}` },
          ],
          details: {} as Record<string, never>,
        };
      }

      const header =
        results.length === 1
          ? `1 definition of "${params.name}":`
          : `${results.length} definitions of "${params.name}":`;

      const blocks = results.map((r, i) => {
        const qualName = r.parent_name ? `${r.parent_name}.${r.name}` : r.name;
        const label =
          results.length === 1
            ? `${r.kind} ${qualName} in ${r.file}:${r.start_line}-${r.end_line}`
            : `${i + 1}. ${r.kind} ${qualName} in ${r.file}:${r.start_line}-${r.end_line}`;
        // Read actual file lines to ensure correct indentation (tree-sitter body strips
        // leading whitespace for nested definitions)
        const filePath = path.resolve(_ctx.cwd, r.file);
        const fileLines = fs.readFileSync(filePath, "utf-8").split("\n");
        const lines = fileLines.slice(r.start_line - 1, r.end_line);
        const numberedBody = lines
          .map((line, idx) => `${String(r.start_line + idx).padStart(4)} | ${line}`)
          .join("\n");
        return [label, numberedBody].join("\n");
      });

      return {
        content: [{ type: "text" as const, text: [header, ...blocks].join("\n\n") }],
        details: { definitions: results },
      };
    },
  });

  // callers(name) — find all call sites
  pi.registerTool({
    name: "callers",
    label: "Callers",
    description:
      "Find every call site for a named function or method by analyzing the syntax tree. Returns file, line, and enclosing function for each call. AST-based, so it correctly resolves calls through renames, callbacks, and method dispatch.",
    promptSnippet: "Find where a function or method is called",
    promptGuidelines: [
      "Use callers to find all call sites of a function/method. AST-aware so it catches aliased calls, callbacks, and method dispatch.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the function or method" }),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("callers "));
      text += theme.fg("accent", args.name);
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = findCallers(params.name);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No callers found for "${params.name}"` }],
          details: {} as Record<string, never>,
        };
      }
      const fileCache = new Map<string, string[]>();
      const getLines = (file: string): string[] | undefined => {
        if (fileCache.has(file)) return fileCache.get(file);
        try {
          const lines = fs.readFileSync(path.resolve(_ctx.cwd, file), "utf-8").split("\n");
          fileCache.set(file, lines);
          return lines;
        } catch {
          return undefined;
        }
      };
      const lines = results.map((c) => {
        const scope = c.caller_name ? `${c.caller_name} (${c.caller_kind})` : "(top-level)";
        const fileLines = getLines(c.file);
        const snippet = fileLines?.[c.line - 1]?.trim();
        if (snippet) {
          return `${c.file}:${c.line} — called in ${scope}\n    ${snippet}`;
        }
        return `${c.file}:${c.line} — called in ${scope}`;
      });
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { callers: results },
      };
    },
  });

  // outline(file) — top-level symbols in a file or directory
  pi.registerTool({
    name: "outline",
    label: "Outline",
    description:
      "List top-level symbols in a file or directory — functions, classes, types, interfaces, enums — with their kind and line range. In deep mode, shows nested members (e.g. class methods) indented under their parents, but skips local variables and nested functions.",
    promptSnippet: "List top-level symbols in a file or directory",
    promptGuidelines: [
      "Use outline to get a file's symbol structure before reading it. Returns name, kind, and line range for each top-level symbol.",
      "Use deep mode to see nested members like class methods. Local variables inside functions are never shown.",
    ],
    parameters: Type.Object({
      file: Type.String({
        description: "Path to the file or directory (relative to project root, or absolute)",
      }),
      deep: Type.Optional(
        Type.Boolean({
          description: "Show nested symbols (e.g. class methods) indented under their parents",
          default: false,
        }),
      ),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("outline "));
      text += theme.fg("accent", args.file);
      if (args.deep) {
        text += theme.fg("muted", " --deep");
      }
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const resolved = path.resolve(_ctx.cwd, params.file);
      const relPath = path.relative(_ctx.cwd, resolved);
      const deep = params.deep ?? false;

      const isDir =
        (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) || relPath === "";

      if (isDir) {
        const results = getDirOutline(relPath, deep);
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No symbols found under "${params.file}" (directory not indexed or empty)`,
              },
            ],
            details: {} as Record<string, never>,
          };
        }

        const lines: string[] = [];
        const byFile = new Map<string, DirSymbol[]>();
        for (const s of results) {
          if (!byFile.has(s.file)) byFile.set(s.file, []);
          byFile.get(s.file)!.push(s);
        }
        for (const [file, fileSymbols] of byFile) {
          lines.push(`${file}:`);
          if (deep) {
            const tree = buildSymbolTree(fileSymbols);
            lines.push(...renderTreeLines(tree, null, "  "));
          } else {
            for (const s of fileSymbols) {
              lines.push(
                `  ${s.name} (${shortKind(s.kind)}) — lines ${s.start_line}-${s.end_line}`,
              );
            }
          }
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { symbols: results },
        };
      }

      const results = getOutline(relPath, deep);
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No symbols found in "${params.file}" (not indexed or not a file)`,
            },
          ],
          details: {} as Record<string, never>,
        };
      }

      let lines: string[];
      if (deep) {
        const tree = buildSymbolTree(results);
        lines = renderTreeLines(tree);
      } else {
        lines = results.map(
          (s) => `${s.name} (${shortKind(s.kind)}) — lines ${s.start_line}-${s.end_line}`,
        );
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { symbols: results },
      };
    },
  });
}
