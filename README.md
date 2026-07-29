# trace

Deterministic, system-wide code navigation for [Pi](https://pi.dev). The extension uses tree-sitter and SQLite to answer common exploration questions without chains of `rg` and `read`.

- **`def(name, path?)`** — return complete named source definitions.
- **`callers(name, path?)`** — find syntactic call sites for a symbol.
- **`outline(path?)`** — list symbols in a file or directory, including nested members.

Every search has an explicit file or directory scope. The scope defaults to Pi's current working directory, a relative path resolves from that directory, and an absolute path can target any readable file or directory.

## Architecture

The Pi extension opens a persistent SQLite cache at `~/.pi/agent/extensions/trace/index.sqlite` and initializes tree-sitter when the session starts. It closes the database connection and parser resources when the session shuts down.

Every operation invalidates cached ignore rules, reconciles exactly the requested file or directory, and then queries SQLite. Each result is therefore fresh for its requested scope; cached rows elsewhere may be stale until that scope is queried. Unchanged files are skipped by stat and identical content at different paths shares one parsed content row.

An invalid scope, traversal failure, indexing failure, or database failure is an error. The database is a disposable, versioned cache; a schema or extraction-contract version mismatch replaces it and lets queries repopulate it.

Project scopes reconcile first-party source while preserving cached dependency rows. A request inside `node_modules` or `.venv` reconciles that exact logical subtree despite `.gitignore`, so dependencies are indexed entirely on demand. A query racing a filesystem rewrite or package installation may observe an intermediate state; the next query reconciles the scope again.

Currently supported languages: JavaScript, TypeScript/TSX, Python, and Rust.

## Development

Requires Node.js 22.18 or newer (native TypeScript type stripping) and pnpm 11.3.0 (pinned in `package.json`).

Grammar WASM files are supplied by the pinned `tree-sitter-*` npm packages; no local grammar checkout is required. Trace owns the extraction queries in `queries/`. JavaScript definitions and calls form the base for the composable TypeScript and JSX additions.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm format:check
```

Load the extension:

```sh
pnpm exec pi -e .
```

## Query semantics

All three operations resolve their optional path to one absolute logical scope:

```text
path omitted   → Pi cwd
relative path  → Pi cwd + path
absolute path  → path
```

A file scope reconciles and matches exactly that source file. A directory scope reconciles and matches supported files beneath it; empty, ignored, and excluded directories are valid and return an empty result. Scopes must exist and be files or directories. A supported source file containing no symbols is valid; an ignored, unsupported, or file-symlink file scope is an error.

Path filtering is lexical from the filesystem-volume root. Nested `.gitignore` files are honored from the volume root through the requested subtree. Logical routes containing `.git`, `.pnpm`, or `.pnpm-store` are always excluded. A package physically stored under `.pnpm` is still indexed when reached through an accepted project-visible path such as `node_modules/pkg`.

Directory symlinks retain their logical paths. `(device, inode)` identity prevents only cycles already on the current ancestor chain, so separate non-cyclic logical aliases to one target are independently indexed and queryable. File symlinks are not indexed.

Queries outside `node_modules` and `.venv` omit definitions and calls in those environments; a scope inside an environment includes and refreshes them.

`callers` is intentionally syntactic. Tree-sitter does not resolve imports, aliases, variable reassignments, types, or dynamic dispatch. This trades semantic precision for deterministic operation on compiling, broken, and dependency source alike.
