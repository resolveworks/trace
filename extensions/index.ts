import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { indexProject } from "../src/indexer.js";
import { findDefinition, findCallers, getOutline, closeDb } from "../src/db.js";

let indexed = false;

export default function (pi: ExtensionAPI) {
  // Index the codebase at session start
  pi.on("session_start", async (_event, ctx) => {
    if (indexed) return;
    try {
      const result = indexProject(ctx.cwd);
      indexed = true;
      ctx.ui.notify(
        `arbid: indexed ${result.files} files, ${result.symbols} symbols, ${result.calls} calls (${result.langs.join(", ") || "none"})`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(`arbid: index failed — ${err}`, "error");
    }
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    closeDb();
    indexed = false;
  });

  // def(name) — get function/class definition
  pi.registerTool({
    name: "def",
    label: "Definition",
    description:
      "Return the full source body of a function, class, method, type, or interface by name. Returns the entire definition as a unit with file path and line range. Use this instead of grep + read when you need to see a symbol's implementation.",
    promptSnippet: "Look up a named definition and return its full body",
    promptGuidelines: [
      "Use def to get a function/class/type's complete body as one unit. Faster than grep then read then slice manually.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the symbol to look up" }),
    }),
    async execute(_toolCallId, params) {
      const result = findDefinition(params.name);
      if (!result) {
        return {
          content: [{ type: "text", text: `No definition found for "${params.name}"` }],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text",
            text: [
              `${result.name} (${result.kind}) — ${result.file}:${result.start_line}-${result.end_line}`,
              "",
              result.body,
            ].join("\n"),
          },
        ],
        details: {
          name: result.name,
          kind: result.kind,
          file: result.file,
          start_line: result.start_line,
          end_line: result.end_line,
        },
      };
    },
  });

  // callers(name) — find all call sites
  pi.registerTool({
    name: "callers",
    label: "Callers",
    description:
      "Find every call site for a named function or method. Uses AST traversal so it catches aliased calls, callbacks, and method dispatch that grep misses. Returns file, line, and calling function for each call site.",
    promptSnippet: "Find where a function or method is called",
    promptGuidelines: [
      "Use callers to find what calls a function/method. More accurate than grep for aliased calls and callbacks.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the function or method" }),
    }),
    async execute(_toolCallId, params) {
      const results = findCallers(params.name);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No callers found for "${params.name}"` }],
          details: {},
        };
      }
      const lines = results.map(
        (c) => `${c.file}:${c.line} — called in ${c.caller_name} (${c.caller_kind})`,
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { callers: results },
      };
    },
  });

  // outline(file) — top-level symbols in a file
  pi.registerTool({
    name: "outline",
    label: "Outline",
    description:
      "List all top-level symbols in a file (functions, classes, types, interfaces, enums) without reading the file. Returns name, kind, and line range for each symbol, sorted by line. Use this to orient yourself before reading a file.",
    promptSnippet: "List top-level symbols in a file",
    promptGuidelines: [
      "Use outline to see what's in a file before reading it. Faster and cleaner than a grep approximation.",
    ],
    parameters: Type.Object({
      file: Type.String({
        description: "Path to the file (relative to project root)",
      }),
    }),
    async execute(_toolCallId, params) {
      const results = getOutline(params.file);
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No symbols found in "${params.file}" (file not indexed or empty)`,
            },
          ],
          details: {},
        };
      }
      const lines = results.map(
        (s) => `${s.name} (${s.kind}) — lines ${s.start_line}-${s.end_line}`,
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { symbols: results },
      };
    },
  });
}
