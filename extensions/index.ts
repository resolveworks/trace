import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import chokidar, { type FSWatcher } from "chokidar";
import { byExtension } from "../src/languages.js";
import { indexProject, reindexFile, removeFile } from "../src/indexer.js";
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
// children (avoids showing local arrow functions, etc.)
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
    lines.push(`${indent}${s.name} (${shortKind(s.kind)}) — ${s.start_line}-${s.end_line}`);
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
        `trace: indexed ${result.files} files, ${result.symbols} symbols, ${result.calls} calls (${result.langs.join(", ") || "none"})`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(`trace: index failed — ${err}`, "error");
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
    closeDb();
  });

  // def(name) — get function/class definition
  pi.registerTool({
    name: "def",
    label: "Definition",
    description:
      "Retrieve the complete source body of a named function, class, method, type, interface, or enum across the project. Returns the full definition with original indentation, plus file path and exact line range. If the name appears in multiple places, all definitions are returned. Optionally narrow the search to a specific file.",
    promptSnippet: "Get the full implementation of a named symbol",
    promptGuidelines: [
      "Use def when you already know the exact symbol name and need its full implementation. Pass the file parameter to disambiguate overloaded names.",
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
      "Find every syntactic call site for a named function or method across the project. Returns each invocation with its file path, line number, and the enclosing function or scope where it occurs. Does not trace variable reassignments, import aliases, or resolve types.",
    promptSnippet: "Find all invocations of a named function or method",
    promptGuidelines: [
      "Use callers to trace how a specific function or method is used across the project. It does not follow reassignments, aliases, or resolved types.",
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
      const blocks = results.map((c) => {
        const scope = c.caller_name ? `${c.caller_name} (${c.caller_kind})` : "(top-level)";
        const fileLines = getLines(c.file);
        const label = `${c.file}:${c.line} — called in ${scope}`;
        if (!fileLines) return label;
        const lines = fileLines.slice(c.line - 1, c.end_line);
        const numbered = lines
          .map((line, idx) => `${String(c.line + idx).padStart(4)} | ${line}`)
          .join("\n");
        return [label, numbered].join("\n");
      });
      return {
        content: [{ type: "text" as const, text: blocks.join("\n\n") }],
        details: { callers: results },
      };
    },
  });

  // outline(file) — top-level symbols in a file or directory
  pi.registerTool({
    name: "outline",
    label: "Outline",
    description:
      "List the symbols defined in a file or directory, such as functions, classes, types, interfaces, and enums. Returns each symbol's name, kind, and line range. Nested members such as class methods, interface members, and inner types are shown indented under their parents.",
    promptSnippet: "List the structure of a file or directory",
    promptGuidelines: [
      "Use outline to map an unfamiliar file or directory before deciding which symbols to inspect with def or callers.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file or directory (relative to project root, or absolute)",
      }),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("outline "));
      text += theme.fg("accent", args.path);
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const resolved = path.resolve(_ctx.cwd, params.path);
      const relPath = path.relative(_ctx.cwd, resolved);

      const isDir =
        (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) || relPath === "";

      if (isDir) {
        const results = getDirOutline(relPath);
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No symbols found under "${params.path}" (directory not indexed or empty)`,
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
          const tree = buildSymbolTree(fileSymbols);
          lines.push(...renderTreeLines(tree, null, "  "));
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { symbols: results },
        };
      }

      const results = getOutline(relPath);
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No symbols found in "${params.path}" (not indexed or not a file)`,
            },
          ],
          details: {} as Record<string, never>,
        };
      }

      const tree = buildSymbolTree(results);
      const lines = renderTreeLines(tree);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { symbols: results },
      };
    },
  });
}
