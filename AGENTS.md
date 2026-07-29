# trace

Deterministic, system-wide code exploration primitives for Pi. A required per-user daemon maintains a persistent tree-sitter + SQLite cache for query scopes under configured roots and exposes three tools over a Unix socket.

- **`def(name, path?)`** — return a function/class/method/type body as one unit.
- **`callers(name, path?)`** — find syntactic call sites for a symbol.
- **`outline(path?)`** — list symbols in a file or directory, including nested members.

Tool paths default to Pi's current working directory, relative paths resolve from it, and absolute paths can target any configured root.

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
│   ├── config.ts           # ~/.pi/agent/trace.json and persistent path configuration
│   ├── fs-errors.ts        # narrow filesystem race classification
│   ├── indexer.ts          # reconcile scopes → parse changed files → extract graph
│   ├── languages.ts        # hardcoded grammar config
│   ├── project-filter.ts   # nested .gitignore filtering
│   └── db.ts               # persistent multi-root schema and scoped queries
├── systemd/traced.service
└── tests/test.ts
```

## Design

- Roots are configured in `~/.pi/agent/trace.json` (or `TRACE_PATH`): a list of non-overlapping absolute directories of first-party code. Package-manager caches (uv archive, pnpm store) are never roots.
- The daemon owns one persistent SQLite cache and never scans roots at startup or watches the filesystem. Before every query it invalidates cached ignore rules, reconciles exactly the requested file or directory, validates the resulting scope, and then queries SQLite. The schema is never migrated: on change, delete the database and let queries repopulate it.
- `node_modules` and `.venv` under a root are dependency environments: indexed only when explicitly scoped despite `.gitignore`, stored at their logical (symlink-unresolved) paths, and excluded from queries whose scope is not inside them. Project reconciliation neither enters environments nor deletes their cached rows. A query racing package installation may see an intermediate state; the next scoped query reconciles again.
- Logical routes containing `.git`, `.pnpm`, or `.pnpm-store` are never indexed. Packages physically stored under `.pnpm` remain available through accepted project-visible paths such as `node_modules/pkg`; exclusion decisions never use the resolved physical target. File symlinks are not indexed.
- Directory symlinks are traversed through each accepted logical path. `(device, inode)` identity prevents cycles only while a target is on the current ancestor chain; it never globally selects a winning alias. Independent non-cyclic aliases are independently cached and queryable.
- Files are stored as logical absolute paths and belong to explicit roots; symbols and calls are stored per content (hash + language), so identical bytes at distinct indexed paths are parsed once. Freshness is a per-path stat comparison: unchanged files are skipped without being read, and stat is only ever a hint, never the content identity.
- Every query has a file or directory scope; there is no global fallback search.
- The extension never indexes locally, starts the daemon, retries, or falls back.
- A configured root disappearing is fatal. Other traversal, indexing, and database failures also terminate the daemon; only `ENOENT`/`ENOTDIR` races below a live root are reconciled as absence.
- Missing daemon, invalid configuration, and invalid query scopes are errors.
- **tree-sitter** provides syntax, not semantics: callers do not resolve aliases, reassignments, or types.
- Use `rg` and `read` for text content, strings, and comments.

## Testing

- Keep the test suite minimal and behavior-focused: use black-box contract tests against externally observable behavior.
- Test through public interfaces and boundaries, not lower-level implementation details or internal structure.
- Prefer a small set of representative, high-value scenarios over exhaustive or redundant cases.
- Refactoring without a behavior change should not require test changes.
