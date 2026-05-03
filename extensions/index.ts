import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import chokidar, { type FSWatcher } from "chokidar";
import { discoverGrammars } from "../src/languages.js";
import type { LoadedLang } from "../src/languages.js";
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
  let byExtension: Map<string, LoadedLang> | null = null;

  pi.on("session_start", async (_event, ctx) => {
    // Discover installed tree-sitter grammars from arbid's node_modules.
    const { byExtension: extMap } = discoverGrammars();
    byExtension = extMap;

    openDb();
    try {
      const result = indexProject(ctx.cwd, byExtension);
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
      if (byExtension) reindexFile(relPath(filePath), byExtension);
    });

    watcher.on("change", (filePath: string) => {
      if (byExtension) reindexFile(relPath(filePath), byExtension);
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
    byExtension = null;
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

      const blocks = results.map((r, i) =>
        [`${i + 1}. ${r.kind} in ${r.file}:${r.start_line}-${r.end_line}`, r.body].join("\n"),
      );

      return {
        content: [{ type: "text" as const, text: [header, "", ...blocks].join("\n\n") }],
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
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = findCallers(params.name);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No callers found for "${params.name}"` }],
          details: {} as Record<string, never>,
        };
      }
      const lines = results.map(
        (c) => `${c.file}:${c.line} — called in ${c.caller_name} (${c.caller_kind})`,
      );
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
