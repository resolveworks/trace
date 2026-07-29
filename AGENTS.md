# trace

Deterministic, system-wide code exploration primitives for Pi. A required per-user daemon maintains a persistent tree-sitter + SQLite cache and exposes three tools over a Unix socket.

- **`def(name, path?)`** — return a complete named source definition as one unit.
- **`callers(name, path?)`** — find syntactic call sites for a symbol.
- **`outline(path?)`** — list symbols in a file or directory, including nested members.

Tool paths default to Pi's current working directory, relative paths resolve from it, and absolute paths can target any readable file or directory.

## Structure

```text
trace/
├── extensions/index.ts     # Pi tools; mandatory IPC client only
├── src/
│   ├── daemon.ts           # daemon process entrypoint
│   ├── server.ts           # query reconciliation and Unix socket server
│   ├── traverse.ts         # logical source walk for scoped reconciliation
│   ├── client.ts           # one-request-per-connection IPC client
│   ├── protocol.ts         # request/response types
│   ├── paths.ts            # persistent socket and database paths
│   ├── fs-errors.ts        # narrow filesystem race classification
│   ├── indexer.ts          # reconcile scopes → parse changed files → extract graph
│   ├── languages.ts        # hardcoded grammar config
│   ├── source-filter.ts    # absolute lexical policy and nested .gitignore filtering
│   └── db.ts               # persistent path/content cache and scoped queries
├── queries/*-tags.scm      # first-party extraction contracts for supported languages
├── systemd/traced.service
└── tests/test.ts
```

## Design

- Source paths require no configuration. Every query has an existing file or directory scope; omitted paths use Pi's current working directory. There is no global fallback search.
- The daemon owns one persistent SQLite cache and never scans the filesystem at startup or watches it. Before every query it invalidates cached ignore rules, reconciles exactly the requested file or directory, validates the scope, and then queries SQLite. Cached index data is never migrated: a cache-version mismatch deletes the database and lets queries repopulate it.
- `node_modules` and `.venv` are dependency environments: indexed only when explicitly scoped despite `.gitignore`, stored at their logical (symlink-unresolved) paths, and excluded from queries whose scope is outside them. Non-environment reconciliation neither enters environments nor deletes their cached rows. A query racing package installation may see an intermediate state; the next scoped query reconciles again.
- Lexical filtering starts at the filesystem-volume root so ancestor and nested `.gitignore` rules are deterministic for every scope. Logical routes containing `.git`, `.pnpm`, or `.pnpm-store` are never indexed. Packages physically stored under `.pnpm` remain available through accepted project-visible paths such as `node_modules/pkg`; exclusion decisions never use the resolved physical target.
- Directory symlinks are traversed through each accepted logical path. `(device, inode)` identity prevents cycles only while a target is on the current ancestor chain; it never globally selects a winning alias. Independent non-cyclic aliases are independently cached and queryable. File symlinks are not indexed.
- Files are stored at logical absolute paths and classified individually as environment or non-environment source. Symbols and calls are stored per content (hash + language), so identical bytes at distinct indexed paths are parsed once. Freshness is a per-path stat comparison: unchanged files are skipped without being read, and stat is only ever a hint, never the content identity.
- The extension never indexes locally, starts the daemon, retries, or falls back.
- Traversal, indexing, and database failures terminate the daemon; narrow `ENOENT`/`ENOTDIR` races during reconciliation are treated as absence.
- Missing daemon and invalid query scopes are errors. Empty directory scopes and supported source files without symbols are valid and return empty results.
- **tree-sitter** provides syntax, not semantics: callers do not resolve aliases, reassignments, or types.
- Use `rg` and `read` for text content, strings, and comments.

## Testing

- Keep the test suite minimal and behavior-focused: use black-box contract tests against externally observable behavior.
- Test through public interfaces and boundaries, not lower-level implementation details or internal structure.
- Prefer a small set of representative, high-value scenarios over exhaustive or redundant cases.
- Refactoring without a behavior change should not require test changes.
