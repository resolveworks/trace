# trace

Deterministic code navigation for [Pi](https://pi.dev) — three tools built on tree-sitter + SQLite that answer common exploration questions in one call instead of chains of `rg` + `read`.

- **`def(name)`** — return a function/class/method/type body as one unit, with file path and precise line range.
- **`callers(name)`** — find every syntactic call site for a symbol via AST traversal.
- **`outline(file)`** — list symbols in a file or directory, with kind and line range. Nested members (e.g. class methods, interface members, inner types) are shown indented under their parents.

## How it works

1. **Indexer** (`src/indexer.ts`) walks the repo, parses files, and extracts symbols & calls via tree-sitter tag queries.
2. **Database** (`src/db.ts`) stores the graph in SQLite (in-memory), so structural queries are just JOINs.
3. **File watcher** (chokidar) keeps the index in sync after the initial startup re-index.

Currently supported languages: TypeScript/TSX, Python, Rust.

## Why tree-sitter and not LSP?

Both can answer the same questions, but with different accuracy-vs-availability trade-offs.

**LSP gives semantically correct answers.** It follows imports, resolves aliases, and respects type boundaries, so `callers` is accurate even when the same name is used in different modules or overloaded on different types. The cost is operational: one server per language, cold-start latency, stateful connections, and failure modes when the code does not compile or the server crashes.

**Tree-sitter gives syntactically approximate answers instantly.** It parses files in milliseconds, works on broken code, and uses the same library for every language. The downside is that cross-file relationships (imports, aliases, type-based dispatch) are invisible unless you rebuild a subset of the language's semantics yourself.

For `def` and `outline` the two approaches are roughly equivalent. For `callers`, LSP is strictly more accurate — but its answers can lag behind the file on disk, and it needs a compiling build and a running server. Tree-sitter reads exactly what is there, instantly. We chose predictability and zero-config operability over semantic precision.

## Limitations

- Syntax-tree navigation only — no LSP, no type resolution.
- `callers` does not trace variable reassignments or resolve dynamic dispatch.
