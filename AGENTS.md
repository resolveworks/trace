# trace

Deterministic, system-wide code exploration primitives for Pi. A required per-user daemon builds a persistent tree-sitter + SQLite index across configured roots and exposes three path-scoped tools over a Unix socket.

- **`def(name, path?)`** — return a function/class/method/type body as one unit.
- **`callers(name, path?)`** — find syntactic call sites for a symbol.
- **`outline(path?)`** — list symbols in a file or directory, including nested members.

Tool paths default to Pi's current working directory, relative paths resolve from it, and absolute paths can target any indexed root.

## Structure

```text
trace/
├── extensions/index.ts     # Pi tools; mandatory IPC client only
├── src/
│   ├── daemon.ts           # daemon process entrypoint
│   ├── server.ts           # indexing lifecycle, watchers, Unix socket server
│   ├── client.ts           # one-request-per-connection IPC client
│   ├── protocol.ts         # request/response types
│   ├── config.ts           # ~/.pi/agent/trace.json and persistent path configuration
│   ├── indexer.ts          # walk roots → parse changed files → extract graph
│   ├── languages.ts        # hardcoded grammar config
│   ├── project-filter.ts   # nested .gitignore filtering
│   └── db.ts               # persistent multi-root schema and scoped queries
├── systemd/traced.service
└── tests/test.ts
```

## Design

- Roots are configured in `~/.pi/agent/trace.json` (or `TRACE_PATH`): a list of non-overlapping absolute directories of first-party code. Package-manager caches (uv archive, pnpm store) are never roots.
- The daemon owns one persistent SQLite database and all chokidar watchers. The schema is never migrated: on change, delete the database and the daemon rebuilds it from the roots.
- `node_modules` and `.venv` under a root are dependency environments: indexed despite `.gitignore`, stored at their logical (symlink-unresolved) paths, and excluded from queries whose scope is not inside them. Physical `.pnpm` store directories are never indexed or watched; packages are reached through their logical symlink paths. The installed environment is authoritative, not the cache.
- Files are stored as logical absolute paths and belong to explicit roots; symbols and calls are stored per content (hash + language), so identical bytes — hardlinks, symlinks, copies — are parsed once no matter how many paths hold them. Freshness is a per-path stat comparison: unchanged files are skipped without being read, and stat is only ever a hint, never an identity.
- Every query has a file or directory scope; there is no global fallback search.
- The extension never indexes locally, starts the daemon, retries, or falls back.
- Missing daemon, invalid configuration, and unindexed scope are errors.
- **tree-sitter** provides syntax, not semantics: callers do not resolve aliases, reassignments, or types.
- Use `rg` and `read` for text content, strings, and comments.

## Testing

- Keep the test suite minimal and behavior-focused: use black-box contract tests against externally observable behavior.
- Test through public interfaces and boundaries, not lower-level implementation details or internal structure.
- Prefer a small set of representative, high-value scenarios over exhaustive or redundant cases.
- Refactoring without a behavior change should not require test changes.
