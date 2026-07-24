# trace

Deterministic, system-wide code navigation for [Pi](https://pi.dev). A persistent daemon uses tree-sitter and SQLite to answer common exploration questions without chains of `rg` and `read`.

- **`def(name, path?)`** — return complete function, class, method, type, interface, or enum bodies.
- **`callers(name, path?)`** — find syntactic call sites for a symbol.
- **`outline(path?)`** — list symbols in a file or directory, including nested members.

Every tool uses Pi's current working directory when `path` is omitted. A relative path resolves from that directory; an absolute path can target any file or directory below `TRACE_PATH`. There is no global unscoped symbol search.

## Architecture

`traced` is a required per-user daemon. It owns:

- one persistent SQLite database at `$XDG_STATE_HOME/trace/index.sqlite` (or `~/.local/state/trace/index.sqlite`),
- one index namespace spanning all roots in `TRACE_PATH`,
- the tree-sitter parsers and filesystem watchers, and
- a Unix socket at `$XDG_RUNTIME_DIR/trace/trace.sock`.

The Pi extension is only an IPC client. It does not create an in-memory index, start the daemon, retry failed requests, or fall back to project-local behavior. A missing daemon, invalid scope, or invalid `TRACE_PATH` is an error. The database has no schema versioning: after a schema change, delete it and let the daemon rebuild on startup.

Files and results use canonical absolute paths. Initial daemon startup hashes source files and only reparses changed content. Source changes are indexed by chokidar using the same nested `.gitignore` rules as the initial walk.

Currently supported languages: TypeScript/TSX, Python, and Rust.

## Configuration

`TRACE_PATH` is required by the daemon. It is a colon-separated list on Unix, like `PATH`:

```sh
TRACE_PATH=/home/me/projects:/home/me/.local/share/pnpm/store
```

Entries must be existing absolute directories. Duplicate or overlapping roots are rejected. Broad roots may contain multiple nested repositories; nested `.gitignore` files are honored.

The following optional variables override the standard locations:

```sh
TRACE_DB=/absolute/path/to/index.sqlite
TRACE_SOCKET=/absolute/path/to/trace.sock
```

## Running with systemd

Install the package so `traced` is on the service's deterministic pnpm path, then create the daemon environment:

```sh
pnpm link --global
mkdir -p ~/.config/trace ~/.config/systemd/user
cat > ~/.config/trace/environment <<'EOF'
TRACE_PATH=/home/me/projects:/home/me/.local/share/pnpm/store
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

Requires Node.js 20.19 or newer and pnpm 11.3.0 (pinned in `package.json`).

> **Temporary:** `tree-sitter` resolves from `../node-tree-sitter` until current upstream releases are published again. Check out that repository beside this one before installing.

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
