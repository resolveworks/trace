# trace

Trace is a Pi extension that provides deterministic `def`, `callers`, and `outline` tools using tree-sitter and a persistent SQLite index. It supports JavaScript, TypeScript/TSX, Python, and Rust.

## Development

Requires Node.js 22.18 or newer and pnpm 11.3.0.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm format:check
```

Use `pnpm format` to apply formatting. Run typecheck, tests, and the formatting check before finishing a change.

## Code organization

- `extensions/index.ts` registers the Pi tools and renders their results.
- `src/trace.ts` is the entry point for scope reconciliation and database queries.
- `src/traverse.ts` and `src/source-filter.ts` own filesystem traversal and filtering.
- `src/indexer.ts` owns parsing and extraction.
- `src/db.ts` owns the persistent index and scoped SQL queries.
- `queries/` contains the tree-sitter extraction contracts.
- `tests/test.ts` tests the extension through its registered tools.

## Implementation constraints

- Keep `callers` syntactic. Do not introduce type analysis, import resolution, alias resolution, or other semantic indexing.
- Preserve logical paths throughout filtering, caching, and results. Do not replace them with resolved physical paths.
- File symlinks to regular files are indexed at their logical paths. Directory symlinks are traversed, with physical identity used only to stop cycles on the current traversal branch. Independent logical aliases remain independently queryable.
- Project scopes must not enter `node_modules` or `.venv`; those environments are indexed only when explicitly scoped. Logical routes containing `.git`, `.pnpm`, or `.pnpm-store` are always excluded.
- Cache files by logical path and share parsed content by content hash and language. File stats are only a freshness hint for skipping unchanged files.
- Treat only `ENOENT` and `ENOTDIR` reconciliation races as absence. Propagate other traversal, parsing, and database failures.
- Tree-sitter queries use `@definition`, `@reference.call`, and `@name`. Each definition and call site must match exactly once; extraction does not deduplicate query matches. Definition types come from the captured node's tree-sitter `Node.type`.
- The SQLite cache has no migrations, versioning, startup recovery, or automatic deletion. After changing its schema or extraction contract, stop active Trace sessions and manually remove `~/.pi/agent/extensions/trace/index.sqlite`, `index.sqlite-shm`, and `index.sqlite-wal`.

## Testing

Test observable behavior through the registered tools in `tests/test.ts`, not internal helper functions. Keep the suite focused on public contracts and important filesystem boundaries; refactoring without a behavior change should not require test changes.
