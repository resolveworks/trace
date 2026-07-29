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

Files and results use logical absolute paths. Initial daemon startup hashes source files and only reparses changed content. Source changes are picked up by a directory-only `fs.watch` watcher using the same nested `.gitignore` rules and logical directory-symlink traversal as the initial walk. File symlinks are not indexed because their target changes are not observable from the logical parent directory.

Currently supported languages: TypeScript/TSX, Python, and Rust.

## Configuration

The daemon reads `~/.pi/agent/trace.json`. Only `roots` is required:

```json
{
  "roots": ["/home/me/projects", "/home/me/.local/share/pnpm/store"]
}
```

Entries must be existing absolute directories. Duplicate or overlapping roots are rejected. Broad roots may contain multiple nested repositories; nested `.gitignore` files are honored.

The socket and database always live under `~/.pi/agent/extensions/trace/`. The environment variables `TRACE_PATH` (colon-separated, like `PATH`), `TRACE_SOCKET`, and `TRACE_DB` override all configuration for tests and development daemons.

## Running with systemd

Configure the daemon roots, then install the service:

```sh
mkdir -p ~/.pi/agent ~/.config/systemd/user
cat > ~/.pi/agent/trace.json <<'EOF'
{
  "roots": ["/home/me/projects", "/home/me/.local/share/pnpm/store"]
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

A file scope matches exactly that indexed file. A directory scope matches indexed files beneath it. Scopes must exist, lie below exactly one configured root, and be indexed. An indexed source file containing no symbols is valid and returns an empty result; an ignored or unsupported file is an error.

`callers` is intentionally syntactic. Tree-sitter does not resolve imports, aliases, variable reassignments, types, or dynamic dispatch. This trades semantic precision for deterministic operation on compiling, broken, and dependency source alike.
