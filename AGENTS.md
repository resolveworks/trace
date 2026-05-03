# arbid

A Pi coding agent package that gives the model fast, deterministic code exploration primitives. Instead of burning tool calls and tokens on `rg` + `read` chains to understand code, arbid provides three tools built on tree-sitter + SQLite that answer common navigation questions in one call.

## Tools

- **`def(name)`** — return a function/class/method/type body as one unit, with file and line range. One call instead of grep-then-read-then-slice.
- **`callers(name)`** — find every call site for a symbol via AST traversal. Catches aliased calls, callbacks, and method dispatch that `rg` misses.
- **`outline(file)`** — list top-level symbols in a file without reading it. Faster and cleaner than `rg` approximations.

All tools output plain text. `def` includes the body inline; `callers` and `outline` list results one per line.

## Design

- **tree-sitter** for parsing (syntax trees, not semantics — no LSP, no type resolution)
- **SQLite** for storage (symbols table + calls table; graph queries are just JOINs)
- **No index staleness** — re-index on startup, add file watching later if needed
- **Positions itself as an addition to grep, not a replacement.** The agent uses `def`/`callers`/`outline` for structured navigation and `rg`/`read` for strings and comments.

## Structure

```
arbid/
├── package.json          # pi package manifest
├── AGENTS.md
├── extensions/
│   └── index.ts          # registers def, callers, outline tools
├── src/
│   ├── indexer.ts         # walk repo → parse → extract via queries
│   ├── languages.ts       # grammar loading + extension mapping
│   ├── db.ts              # SQLite schema + query functions
│   └── queries/           # vendored Aider .scm files (26 languages)
├── tests/
│   └── test.ts            # unit tests
└── tsconfig.json
```

## Install

```bash
pi install git:github.com/johan/arbid
```

## Usage

The tools appear automatically in Pi's tool list once installed. The model will reach for them naturally — their names and descriptions make the cost/benefit obvious versus grep + read.

## Multi-language support

Uses **Aider's tree-sitter tag queries** — 26 languages supported via vendored `.scm` files. Each language activates when its tree-sitter grammar package is installed:

```bash
cd arbid && npm install tree-sitter-python  # activates Python indexing
```

Languages without a grammar installed are silently skipped. Bundled by default: TypeScript.
