import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { DirSymbol, OutlineSymbol } from "../src/db.ts";
import {
  closeTrace,
  getCallers,
  getDefinitions,
  getSymbols,
  initializeTrace,
} from "../src/trace.ts";

function buildSymbolTree(symbols: OutlineSymbol[]): Map<number | null, OutlineSymbol[]> {
  const tree = new Map<number | null, OutlineSymbol[]>();
  for (const symbol of symbols) {
    const children = tree.get(symbol.parent_id) ?? [];
    children.push(symbol);
    tree.set(symbol.parent_id, children);
  }
  for (const children of tree.values()) {
    children.sort((left, right) => left.start_line - right.start_line);
  }
  return tree;
}

function renderTreeLines(
  tree: Map<number | null, OutlineSymbol[]>,
  parentId: number | null = null,
  indent = "",
): string[] {
  const lines: string[] = [];
  for (const symbol of tree.get(parentId) ?? []) {
    lines.push(
      `${indent}${symbol.name} (${symbol.node_type}) — ${symbol.start_line}-${symbol.end_line}`,
    );
    lines.push(...renderTreeLines(tree, symbol.id, indent + "  "));
  }
  return lines;
}

function resolveScope(cwd: string, input?: string): string {
  return path.resolve(cwd, input ?? ".");
}

function truncate(text: string): string {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES} bytes. Narrow the path scope.]`;
}

function pathParameter() {
  return Type.Optional(
    Type.String({
      description:
        "File or directory to search. Relative paths resolve from the current working directory; defaults to the current working directory.",
    }),
  );
}

export function registerTrace(pi: ExtensionAPI, database: string) {
  pi.on("session_start", async () => {
    await initializeTrace(database);
  });
  pi.on("session_shutdown", () => {
    closeTrace();
  });

  pi.registerTool({
    name: "def",
    label: "Definition",
    description:
      "Retrieve complete source bodies of named definitions from the system-wide trace index. Search is scoped to the supplied file or directory, or the current working directory by default. Returns absolute file paths and exact line ranges.",
    promptSnippet: "Get the complete source definition of a named symbol",
    promptGuidelines: [
      "Use def when you know a symbol name and need its source definition. Pass path to search another source file, directory, project, or dependency.",
      'Query installed dependencies at their project-visible paths, e.g. def("get", ".venv/lib/python3.12/site-packages/httpx") or def("parse", "node_modules/typescript"). Project-scoped searches exclude dependency code unless the path points into it.',
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the symbol to look up" }),
      path: pathParameter(),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("def "));
      text += theme.fg("accent", args.name);
      if (args.path) text += theme.fg("dim", " in " + args.path);
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const definitions = getDefinitions(params.name, resolveScope(ctx.cwd, params.path));
      if (definitions.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No definition found for "${params.name}"` }],
          details: { definitions },
        };
      }

      const header =
        definitions.length === 1
          ? `1 definition of "${params.name}":`
          : `${definitions.length} definitions of "${params.name}":`;
      const blocks = definitions.map((definition, index) => {
        const qualifiedName = definition.parent_name
          ? `${definition.parent_name}.${definition.name}`
          : definition.name;
        const prefix = definitions.length === 1 ? "" : `${index + 1}. `;
        const label = `${prefix}${definition.node_type} ${qualifiedName} in ${definition.file}:${definition.start_line}-${definition.end_line}`;
        const lines = fs.readFileSync(definition.file, "utf-8").split("\n");
        const body = lines
          .slice(definition.start_line - 1, definition.end_line)
          .map(
            (line, lineIndex) =>
              `${String(definition.start_line + lineIndex).padStart(4)} | ${line}`,
          )
          .join("\n");
        return `${label}\n${body}`;
      });
      return {
        content: [{ type: "text" as const, text: truncate([header, ...blocks].join("\n\n")) }],
        details: { definitions },
      };
    },
  });

  pi.registerTool({
    name: "callers",
    label: "Callers",
    description:
      "Find syntactic call sites for a named symbol in the system-wide trace index. Search is scoped to the supplied file or directory, or the current working directory by default. Returns absolute file paths, line numbers, and enclosing scopes. Does not resolve types, imports, aliases, or variable reassignments.",
    promptSnippet: "Find all syntactic invocations of a named callable",
    promptGuidelines: [
      "Use callers to find syntactic invocations of a symbol. Pass path to search another source file, directory, project, or dependency.",
      "Query installed dependencies at their project-visible paths, e.g. node_modules/<pkg> or .venv/lib/python3.x/site-packages/<pkg>. Project-scoped searches exclude dependency code unless the path points into it.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the callable symbol" }),
      path: pathParameter(),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("callers "));
      text += theme.fg("accent", args.name);
      if (args.path) text += theme.fg("dim", " in " + args.path);
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const callers = getCallers(params.name, resolveScope(ctx.cwd, params.path));
      if (callers.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No callers found for "${params.name}"` }],
          details: { callers },
        };
      }

      const fileCache = new Map<string, string[]>();
      const blocks = callers.map((call) => {
        let lines = fileCache.get(call.file);
        if (!lines) {
          lines = fs.readFileSync(call.file, "utf-8").split("\n");
          fileCache.set(call.file, lines);
        }
        const scope = call.caller_name
          ? `${call.caller_name} (${call.caller_node_type})`
          : "(top-level)";
        const label = `${call.file}:${call.line} — called in ${scope}`;
        const source = lines
          .slice(call.line - 1, call.end_line)
          .map((line, lineIndex) => `${String(call.line + lineIndex).padStart(4)} | ${line}`)
          .join("\n");
        return `${label}\n${source}`;
      });
      return {
        content: [{ type: "text" as const, text: truncate(blocks.join("\n\n")) }],
        details: { callers },
      };
    },
  });

  pi.registerTool({
    name: "outline",
    label: "Outline",
    description:
      "List symbols in a file or directory from the system-wide trace index. The path may be relative to the current working directory or absolute, and defaults to the current working directory. Nested members are indented under their parents.",
    promptSnippet: "List the structure of a source file or directory",
    promptGuidelines: [
      "Use outline to map an unfamiliar source file or directory before choosing symbols for def or callers.",
    ],
    parameters: Type.Object({ path: pathParameter() }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("outline"));
      if (args.path) text += " " + theme.fg("accent", args.path);
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = resolveScope(ctx.cwd, params.path);
      const symbols = getSymbols(scope);
      if (symbols.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No symbols found in "${scope}"` }],
          details: { symbols },
        };
      }

      let lines: string[];
      if (fs.statSync(scope).isFile()) {
        lines = renderTreeLines(buildSymbolTree(symbols));
      } else {
        lines = [];
        const byFile = new Map<string, DirSymbol[]>();
        for (const symbol of symbols) {
          const symbols = byFile.get(symbol.file) ?? [];
          symbols.push(symbol);
          byFile.set(symbol.file, symbols);
        }
        for (const [file, symbols] of byFile) {
          lines.push(`${file}:`);
          lines.push(...renderTreeLines(buildSymbolTree(symbols), null, "  "));
        }
      }
      return {
        content: [{ type: "text" as const, text: truncate(lines.join("\n")) }],
        details: { symbols },
      };
    },
  });
}

export default function (pi: ExtensionAPI) {
  const database = path.join(os.homedir(), ".pi", "agent", "extensions", "trace", "index.sqlite");
  registerTrace(pi, database);
}
