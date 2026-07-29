# trace

Deterministic, system-wide code navigation for [Pi](https://pi.dev). A persistent daemon uses tree-sitter and SQLite to answer common exploration questions without chains of `rg` and `read`.

- **`def(name, path?)`** — return complete function, class, method, type, interface, or enum bodies.
- **`callers(name, path?)`** — find syntactic call sites for a symbol.
- **`outline(path?)`** — list symbols in a file or directory, including nested members.

Every tool uses Pi's current working directory when `path` is omitted. A relative path resolves from that directory; an absolute path can target any file or directory below a configured root. There is no global unscoped symbol search.

## Architecture

`traced` is a required per-user daemon. It owns:

- one persistent SQLite database at `~/.pi/agent/extensions/trace/index.sqlite`,
- one index namespace spanning all configured roots,
- the tree-sitter parsers and filesystem watchers, and
- a Unix socket at `~/.pi/agent/extensions/trace/trace.sock`.

The Pi extension is only an IPC client. It does not create an in-memory index, start the daemon, retry failed requests, or fall back to project-local behavior. A missing daemon, invalid scope, or invalid root configuration is an error. Watch installation, traversal, indexing, and database failures terminate the daemon rather than leave a partial state running. The database has no schema versioning: after a schema change, delete it and let the daemon rebuild on startup.

Files and results use logical absolute paths. Initial daemon startup indexes both first-party source and installed dependency environments, hashing changed files and sharing parsed content for identical bytes. File symlinks are not indexed because their target changes are not observable from the logical parent directory.

Freshness follows two policies:

- First-party directories are recursively covered by one non-recursive `fs.watch` per included logical directory. Source file changes are reconciled eagerly; directory topology and nested `.gitignore` changes rebuild that root's topology and index.
- `node_modules` and `.venv` are startup snapshots. They are indexed despite `.gitignore`, are not watched recursively, and are reconciled immediately before a query whose requested scope is inside that environment. A file query refreshes that file; a directory query refreshes exactly that logical subtree.

A query racing an active package installation may observe an intermediate filesystem state. The next dependency-scoped query reconciles the selected scope again; package-manager completion detection and transactional environment snapshots are intentionally out of scope.

Currently supported languages: TypeScript/TSX, Python, and Rust.

## Configuration

The daemon reads `~/.pi/agent/trace.json`. Only `roots` is required:

```json
{
  "roots": ["/home/me/projects", "/home/me/src"]
}
```

Entries must be existing absolute directories containing first-party source. Duplicate or overlapping roots are rejected. Broad roots may contain multiple nested repositories; nested `.gitignore` files are honored. Installed `node_modules` and `.venv` environments beneath roots are discovered automatically—package-manager stores should not be configured as roots.

The socket and database always live under `~/.pi/agent/extensions/trace/`. The environment variables `TRACE_PATH` (colon-separated, like `PATH`), `TRACE_SOCKET`, and `TRACE_DB` override all configuration for tests and development daemons.

## Running with systemd

Configure the daemon roots, then install the service:

```sh
mkdir -p ~/.pi/agent ~/.config/systemd/user
cat > ~/.pi/agent/trace.json <<'EOF'
{
  "roots": ["/home/me/projects", "/home/me/src"]
}
EOF
cp systemd/traced.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now traced.service
```

Check startup and indexing directly:

```sh
systemctl --user status traced.service
journalctl --user -u traced.service
```

The service deliberately has no restart loop or compatibility mode. Configuration and startup failures remain failed until corrected.

## Development

Requires Node.js 22.18 or newer (native TypeScript type stripping) and pnpm 11.3.0 (pinned in `package.json`).

Grammar WASM files and tag queries are supplied by the `tree-sitter-*` npm grammar packages; no local grammar checkout is required.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm format:check
```

Run the daemon against this checkout:

```sh
TRACE_PATH="$PWD" pnpm traced
```

Then, in another terminal, load the extension:

```sh
pnpm exec pi -e .
```

## Query semantics

All three operations resolve their optional path to one canonical scope:

```text
path omitted   → Pi cwd
relative path  → Pi cwd + path
absolute path  → path
```

A file scope matches exactly that indexed file. A directory scope matches indexed files beneath it. Scopes must exist, lie below exactly one configured root, and be indexed. Dependency scopes are reconciled before this indexed-scope check, so a newly installed package is available on its first scoped query. An indexed source file containing no symbols is valid and returns an empty result; an ignored or unsupported file is an error.

Path filtering is lexical relative to the configured root. `.git`, `.pnpm`, and `.pnpm-store` routes are always excluded. A package physically stored under `.pnpm` is still indexed when reached through an accepted project-visible path such as `node_modules/pkg`. Directory symlinks retain their logical paths. `(device, inode)` identity prevents only cycles already on the current ancestor chain, so separate non-cyclic logical aliases to one target are independently indexed and queryable.

Project-root queries omit definitions and calls under `node_modules` and `.venv`; a scope inside an environment includes them.

`callers` is intentionally syntactic. Tree-sitter does not resolve imports, aliases, variable reassignments, types, or dynamic dispatch. This trades semantic precision for deterministic operation on compiling, broken, and dependency source alike.
