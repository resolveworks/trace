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
- **No index staleness** — re-index on startup, then keep in sync via chokidar file watching (add/change/unlink).
- **Positions itself as an addition to grep, not a replacement.** The agent uses `def`/`callers`/`outline` for structured navigation and `rg`/`read` for strings and comments.

## Structure

```
arbid/
├── package.json          # pi package manifest
├── AGENTS.md
├── extensions/
│   └── index.ts          # registers def, callers, outline tools
├── src/
│   ├── indexer.ts         # walk repo → parse → extract via native tag queries
│   ├── languages.ts       # grammar auto-discovery from node_modules
│   ├── db.ts              # SQLite schema + query functions
│   └── tree-sitter-language.d.ts  # Language type augmentation
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

Grammar auto-discovery at startup via `discoverGrammars()`:

1. Scans `node_modules/tree-sitter-*` directories for `tree-sitter.json` manifests.
2. Uses each grammar's native **tag capture queries** (`@definition.X`, `@reference.X`, `@name`) from the query files listed in the manifest's `tags` field — no more vendored `.scm` files.
3. Reads `file-types` from the manifest for extension-to-language mapping.
4. Resolves the `Language` object by matching `grammar.name` to each exported object's `name` property.

Any tree-sitter grammar package with a `tree-sitter.json` manifest is automatically supported. Languages without a grammar installed are silently skipped. Bundled by default: TypeScript.
