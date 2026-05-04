# arbid

Deterministic code exploration primitives for Pi — three tools built on tree-sitter + SQLite that answer common navigation questions in one call instead of chains of `rg` + `read`.

- **`def(name)`** — return a function/class/method/type body as one unit, with file path and precise line range.
- **`callers(name)`** — find every call site for a symbol via AST traversal. Catches aliased calls, callbacks, and method dispatch that `rg` misses.
- **`outline(file)`** — list symbols in a file or directory, with kind and line range. Deep mode shows nested members (e.g. class methods).

## Structure

```
arbid/
├── extensions/index.ts    # registers def, callers, outline with Pi
├── src/
│   ├── indexer.ts         # walk repo → parse → extract symbols & calls via tag queries
│   ├── languages.ts       # hardcoded grammar config (TypeScript/TSX, Python, Rust)
│   ├── db.ts              # SQLite schema + query functions
│   └── tree-sitter-language.d.ts
├── tests/test.ts
└── tsconfig.json
```

## Design

- **tree-sitter** for parsing (syntax trees, not semantics — no LSP, no type resolution)
- **SQLite** in-memory DB for symbols and calls (graph queries are just JOINs)
- **File watcher** (chokidar) keeps the index in sync after startup re-index
- **Complements grep** — use `def`/`callers`/`outline` for structure, `rg`/`read` for strings and comments
