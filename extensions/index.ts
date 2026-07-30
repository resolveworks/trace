import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getLanguageFromPath,
  getMarkdownTheme,
  truncateHead,
  withFileMutationQueue,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderResultOptions,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
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

function inlineCode(value: string): string {
  const delimiter = "`".repeat(
    Math.max(...[...value.matchAll(/`+/g)].map(([run]) => run.length), 0) + 1,
  );
  return `${delimiter}${value}${delimiter}`;
}

function renderTreeMarkdown(
  tree: Map<number | null, OutlineSymbol[]>,
  parentId: number | null = null,
  indent = "",
): string[] {
  const lines: string[] = [];
  for (const symbol of tree.get(parentId) ?? []) {
    lines.push(
      `${indent}- ${inlineCode(symbol.name)} — ${inlineCode(symbol.node_type)}, lines ${symbol.start_line}–${symbol.end_line}`,
    );
    lines.push(...renderTreeMarkdown(tree, symbol.id, indent + "  "));
  }
  return lines;
}

function sourceBlock(file: string, source: string): string {
  return `\`\`\`${getLanguageFromPath(file) ?? "text"}\n${source}\n\`\`\``;
}

function resolveScope(cwd: string, input?: string): string {
  return path.resolve(cwd, input ?? ".");
}

function displayPath(cwd: string, logicalPath: string): string {
  return path.relative(cwd, logicalPath) || ".";
}

interface TruncatedOutput {
  content: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

async function saveFullOutput(content: string): Promise<string> {
  const id = randomBytes(8).toString("hex");
  const fullOutputPath = path.join(os.tmpdir(), `pi-trace-${id}.md`);
  await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath, content, "utf-8"));
  return fullOutputPath;
}

function truncationNotice(truncation: TruncationResult, fullOutputPath: string): string {
  const truncated =
    truncation.truncatedBy === "lines"
      ? `showing ${truncation.outputLines} of ${truncation.totalLines} lines`
      : `${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit)`;
  return `> **Truncated:** ${truncated}. Full output: ${inlineCode(fullOutputPath)}`;
}

async function truncate(text: string): Promise<TruncatedOutput> {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return { content: truncation.content };

  const fullOutputPath = await saveFullOutput(text);
  return {
    content: `${truncation.content}\n\n${truncationNotice(truncation, fullOutputPath)}`,
    truncation,
    fullOutputPath,
  };
}

function renderTraceResult(
  result: AgentToolResult<unknown>,
  _options: ToolRenderResultOptions,
  _theme: Theme,
): Markdown {
  const content = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  return new Markdown(`\n${content}`, 0, 0, getMarkdownTheme());
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
      "Retrieve complete source bodies of named definitions from the system-wide trace index. Search is scoped to the supplied file or directory, or the current working directory by default. Returns file paths and exact line ranges.",
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
      const scope = resolveScope(ctx.cwd, params.path);
      const definitions = getDefinitions(params.name, scope);
      if (definitions.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No definitions named ${inlineCode(params.name)} found under ${inlineCode(displayPath(ctx.cwd, scope))}.`,
            },
          ],
          details: { definitions },
        };
      }

      const blocks = definitions.map((definition) => {
        const location = `${displayPath(ctx.cwd, definition.file)}:${definition.start_line}–${definition.end_line}`;
        const source = fs
          .readFileSync(definition.file, "utf-8")
          .split("\n")
          .slice(definition.start_line - 1, definition.end_line)
          .join("\n");
        return [`## Defined in ${inlineCode(location)}`, sourceBlock(definition.file, source)].join(
          "\n\n",
        );
      });
      const output = await truncate(blocks.join("\n\n"));
      return {
        content: [{ type: "text" as const, text: output.content }],
        details: {
          definitions,
          truncation: output.truncation,
          fullOutputPath: output.fullOutputPath,
        },
      };
    },
    renderResult: renderTraceResult,
  });

  pi.registerTool({
    name: "callers",
    label: "Callers",
    description:
      "Find syntactic call sites for a named symbol in the system-wide trace index. Search is scoped to the supplied file or directory, or the current working directory by default. Returns file paths, line numbers, and enclosing scopes. Does not resolve types, imports, aliases, or variable reassignments.",
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
      const scope = resolveScope(ctx.cwd, params.path);
      const callers = getCallers(params.name, scope);
      if (callers.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No callers named ${inlineCode(params.name)} found under ${inlineCode(displayPath(ctx.cwd, scope))}.`,
            },
          ],
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
        const location = `${displayPath(ctx.cwd, call.file)}:${call.line}-${call.end_line}`;
        const title = call.caller_name
          ? `Called in ${inlineCode(call.caller_name)} — ${inlineCode(call.caller_node_type ?? "unknown")}, ${inlineCode(location)}`
          : `Called at top level, ${inlineCode(location)}`;
        const source = lines.slice(call.line - 1, call.end_line).join("\n");
        return [`## ${title}`, sourceBlock(call.file, source)].join("\n\n");
      });
      const output = await truncate(blocks.join("\n\n"));
      return {
        content: [{ type: "text" as const, text: output.content }],
        details: { callers, truncation: output.truncation, fullOutputPath: output.fullOutputPath },
      };
    },
    renderResult: renderTraceResult,
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
          content: [
            {
              type: "text" as const,
              text: `No symbols found under ${inlineCode(displayPath(ctx.cwd, scope))}.`,
            },
          ],
          details: { symbols },
        };
      }

      const lines: string[] = [];
      if (fs.statSync(scope).isFile()) {
        lines.push(...renderTreeMarkdown(buildSymbolTree(symbols)));
      } else {
        const byFile = new Map<string, DirSymbol[]>();
        for (const symbol of symbols) {
          const symbols = byFile.get(symbol.file) ?? [];
          symbols.push(symbol);
          byFile.set(symbol.file, symbols);
        }
        for (const [file, symbols] of byFile) {
          lines.push(`## Symbols in ${inlineCode(displayPath(ctx.cwd, file))}`, "");
          lines.push(...renderTreeMarkdown(buildSymbolTree(symbols)), "");
        }
      }
      const output = await truncate(lines.join("\n").trimEnd());
      return {
        content: [{ type: "text" as const, text: output.content }],
        details: { symbols, truncation: output.truncation, fullOutputPath: output.fullOutputPath },
      };
    },
    renderResult: renderTraceResult,
  });
}

export default function (pi: ExtensionAPI) {
  const database = path.join(os.homedir(), ".pi", "agent", "extensions", "trace", "index.sqlite");
  registerTrace(pi, database);
}
