# trace

Deterministic, system-wide code exploration primitives for Pi. The extension uses tree-sitter with a persistent SQLite cache and exposes three tools.

- **`def(name, path?)`** — return a complete named source definition as one unit.
- **`callers(name, path?)`** — find syntactic call sites for a symbol.
- **`outline(path?)`** — list symbols in a file or directory, including nested members.

Every search has an explicit file or directory scope. Tool paths default to Pi's current working directory, relative paths resolve from it, and absolute paths can target any readable file or directory.

## Structure

```text
trace/
├── extensions/index.ts     # Pi tools and session lifecycle
├── src/
│   ├── trace.ts            # scoped reconciliation and query entry points
│   ├── traverse.ts         # logical source walk for scoped reconciliation
│   ├── fs-errors.ts        # narrow filesystem race classification
│   ├── indexer.ts          # reconcile scopes → parse changed files → extract graph
│   ├── languages.ts        # hardcoded grammar config
│   ├── source-filter.ts    # absolute lexical policy and nested .gitignore filtering
│   └── db.ts               # persistent path/content cache and scoped queries
├── queries/*-tags.scm      # first-party extraction contracts for supported languages
└── tests/test.ts
```

## Design

- Every query has an existing file or directory scope; omitted paths use Pi's current working directory.
- The extension uses one persistent SQLite cache. Every query invalidates cached ignore rules, reconciles exactly the requested file or directory, validates the scope, and then queries SQLite.
- The cache has no schema or extraction version, migrations, compatibility handling, or automatic deletion. When the schema or extraction contract changes, stop sessions using trace and manually delete `~/.pi/agent/extensions/trace/index.sqlite`, `index.sqlite-shm`, and `index.sqlite-wal` before running the changed code. Do not add startup recovery or deletion logic.
- `node_modules` and `.venv` are dependency environments: indexed only when explicitly scoped despite `.gitignore`, stored at their logical (symlink-unresolved) paths, and excluded from queries whose scope is outside them. Non-environment reconciliation neither enters environments nor deletes their cached rows. A query racing package installation may see an intermediate state; the next scoped query reconciles again.
- Lexical filtering starts at the filesystem-volume root so ancestor and nested `.gitignore` rules are deterministic for every scope. Logical routes containing `.git`, `.pnpm`, or `.pnpm-store` are never indexed. Packages physically stored under `.pnpm` remain available through accepted project-visible paths such as `node_modules/pkg`; exclusion decisions never use the resolved physical target.
- Directory symlinks are traversed through each accepted logical path. `(device, inode)` identity prevents cycles only while a target is on the current ancestor chain; it never globally selects a winning alias. Independent non-cyclic aliases are independently cached and queryable. File symlinks are not indexed.
- Files are stored at logical absolute paths and classified individually as environment or non-environment source. Symbols and calls are stored per content (hash + language), so identical bytes at distinct indexed paths are parsed once. Freshness is a per-path stat comparison: unchanged files are skipped without being read, and stat is only ever a hint, never the content identity.
- The extension initializes the parser and opens the database on session start, then closes both on session shutdown.
- Traversal, indexing, and database failures fail the tool call; narrow `ENOENT`/`ENOTDIR` races during reconciliation are treated as absence.
- Invalid query scopes are errors. Empty directory scopes and supported source files without symbols are valid and return empty results.
- **tree-sitter** provides syntax, not semantics: callers do not resolve aliases, reassignments, or types. Owned queries use `@definition`, `@reference.call`, and `@name`; each definition or call site must be emitted exactly once because extraction does not deduplicate matches. Symbol `node_type` values are the grammar's tree-sitter `Node.type` values.
- Use `rg` and `read` for text content, strings, and comments.

## Testing

- Keep the test suite minimal and behavior-focused: use black-box contract tests against externally observable behavior.
- Test through public interfaces and boundaries, not lower-level implementation details or internal structure.
- Prefer a small set of representative, high-value scenarios over exhaustive or redundant cases.
- Refactoring without a behavior change should not require test changes.
