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
} from "../src/db.js";

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
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("def "));
      text += theme.fg("accent", args.name);
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = findDefinition(params.name);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No definition found for "${params.name}"` }],
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
      "List all top-level symbols in a file or directory — functions, classes, types, interfaces, enums — with their kind and line range, sorted by line. Gives you the file's structure without reading it.",
    promptSnippet: "List top-level symbols in a file or directory",
    promptGuidelines: [
      "Use outline to get a file's symbol structure before reading it. Returns name, kind, and line range for each top-level symbol.",
    ],
    parameters: Type.Object({
      file: Type.String({
        description: "Path to the file or directory (relative to project root, or absolute)",
      }),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("outline "));
      text += theme.fg("accent", args.file);
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const resolved = path.resolve(_ctx.cwd, params.file);
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
                text: `No symbols found under "${params.file}" (directory not indexed or empty)`,
              },
            ],
            details: {} as Record<string, never>,
          };
        }

        const lines: string[] = [];
        let currentFile = "";
        for (const s of results) {
          if (s.file !== currentFile) {
            currentFile = s.file;
            lines.push(`${currentFile}:`);
          }
          lines.push(`  ${s.name} (${s.kind}) — lines ${s.start_line}-${s.end_line}`);
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
              text: `No symbols found in "${params.file}" (not indexed or not a file)`,
            },
          ],
          details: {} as Record<string, never>,
        };
      }
      const lines = results.map(
        (s) => `${s.name} (${s.kind}) — lines ${s.start_line}-${s.end_line}`,
      );
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { symbols: results },
      };
    },
  });
}
