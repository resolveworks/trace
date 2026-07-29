import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { requestTrace } from "../src/client.ts";
import { getTraceSocketPath } from "../src/paths.ts";
import type { DirSymbol, OutlineSymbol } from "../src/db.ts";

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
      `${indent}${symbol.name} (${shortKind(symbol.kind)}) — ${symbol.start_line}-${symbol.end_line}`,
    );
    if (!FUNCTION_LIKE_KINDS.has(symbol.kind)) {
      lines.push(...renderTreeLines(tree, symbol.id, indent + "  "));
    }
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "def",
    label: "Definition",
    description:
      "Retrieve complete source bodies of named functions, classes, methods, types, interfaces, or enums from the system-wide trace index. Search is scoped to the supplied file or directory, or the current working directory by default. Returns absolute file paths and exact line ranges.",
    promptSnippet: "Get the full implementation of a named symbol",
    promptGuidelines: [
      "Use def when you know a symbol name and need its implementation. Pass path to search another source file, directory, project, or dependency.",
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
      const result = await requestTrace(getTraceSocketPath(), {
        op: "def",
        name: params.name,
        scope: resolveScope(ctx.cwd, params.path),
      });
      if (result.definitions.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No definition found for "${params.name}"` }],
          details: { definitions: result.definitions },
        };
      }

      const header =
        result.definitions.length === 1
          ? `1 definition of "${params.name}":`
          : `${result.definitions.length} definitions of "${params.name}":`;
      const blocks = result.definitions.map((definition, index) => {
        const qualifiedName = definition.parent_name
          ? `${definition.parent_name}.${definition.name}`
          : definition.name;
        const prefix = result.definitions.length === 1 ? "" : `${index + 1}. `;
        const label = `${prefix}${definition.kind} ${qualifiedName} in ${definition.file}:${definition.start_line}-${definition.end_line}`;
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
        details: { definitions: result.definitions },
      };
    },
  });

  pi.registerTool({
    name: "callers",
    label: "Callers",
    description:
      "Find syntactic call sites for a function or method in the system-wide trace index. Search is scoped to the supplied file or directory, or the current working directory by default. Returns absolute file paths, line numbers, and enclosing scopes. Does not resolve types, imports, aliases, or variable reassignments.",
    promptSnippet: "Find all invocations of a named function or method",
    promptGuidelines: [
      "Use callers to find syntactic invocations of a symbol. Pass path to search another source file, directory, project, or dependency.",
      "Query installed dependencies at their project-visible paths, e.g. node_modules/<pkg> or .venv/lib/python3.x/site-packages/<pkg>. Project-scoped searches exclude dependency code unless the path points into it.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the function or method" }),
      path: pathParameter(),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("callers "));
      text += theme.fg("accent", args.name);
      if (args.path) text += theme.fg("dim", " in " + args.path);
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await requestTrace(getTraceSocketPath(), {
        op: "callers",
        name: params.name,
        scope: resolveScope(ctx.cwd, params.path),
      });
      if (result.callers.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No callers found for "${params.name}"` }],
          details: { callers: result.callers },
        };
      }

      const fileCache = new Map<string, string[]>();
      const blocks = result.callers.map((call) => {
        let lines = fileCache.get(call.file);
        if (!lines) {
          lines = fs.readFileSync(call.file, "utf-8").split("\n");
          fileCache.set(call.file, lines);
        }
        const scope = call.caller_name
          ? `${call.caller_name} (${call.caller_kind})`
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
        details: { callers: result.callers },
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
      const result = await requestTrace(getTraceSocketPath(), { op: "outline", scope });
      if (result.symbols.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No symbols found in "${scope}"` }],
          details: { symbols: result.symbols },
        };
      }

      let lines: string[];
      if (fs.statSync(scope).isFile()) {
        lines = renderTreeLines(buildSymbolTree(result.symbols));
      } else {
        lines = [];
        const byFile = new Map<string, DirSymbol[]>();
        for (const symbol of result.symbols) {
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
        details: { symbols: result.symbols },
      };
    },
  });
}
