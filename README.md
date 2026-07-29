# trace

Trace adds deterministic code-navigation tools to [Pi](https://pi.dev), backed by tree-sitter and a persistent SQLite index.

- **`def`** retrieves complete named definitions.
- **`callers`** finds syntactic call sites.
- **`outline`** lists the symbols in a file or directory.

Trace supports JavaScript, TypeScript/TSX, Python, and Rust.

## Install

Install directly from GitHub:

```sh
pi install git:github.com/resolveworks/trace
```

To try a local checkout without installing it:

```sh
pnpm install --frozen-lockfile
pnpm exec pi -e .
```

## Tools

| Tool                   | Purpose                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `def(name, path?)`     | Return complete definitions named `name`, including their source and line range.     |
| `callers(name, path?)` | Find syntactic calls to `name`, including their enclosing definition when available. |
| `outline(path?)`       | Show the definitions in a file or directory as a nested outline.                     |

For example, ask Pi to:

```text
Show me the definition of openDb in src.
Find callers of reconcileFile in this project.
Outline src/indexer.ts.
Find the definition of parse in node_modules/typescript.
```

The optional path always defines the search scope:

```text
path omitted   → Pi's current working directory
relative path  → resolved from Pi's current working directory
absolute path  → used directly
```

## How indexing works

Trace maintains its index at:

```text
~/.pi/agent/extensions/trace/index.sqlite
```

Before each tool runs, Trace reconciles the requested file or directory with the filesystem. Unchanged files are skipped using their size and modification time; changed content is hashed and parsed with tree-sitter. Identical content using the same grammar shares one parsed index entry.

There is no daemon, configured source root, or startup scan. Any supported source file or readable directory can be queried directly.

## Scope and path behavior

- A file scope searches exactly that source file.
- A directory scope searches supported source files beneath it.
- Ancestor and nested `.gitignore` files are honored.
- Logical routes containing `.git`, `.pnpm`, or `.pnpm-store` are excluded.
- Project scopes do not enter `node_modules` or `.venv`.
- A scope inside `node_modules` or `.venv` indexes that dependency subtree despite `.gitignore`.
- File and directory symlinks retain their logical paths, and separate aliases remain independently queryable.

Empty directories and supported source files without definitions are valid and return no results. Missing paths, unsupported file scopes, and ignored file scopes are errors.

## Semantics and limitations

`callers` is intentionally syntactic. It recognizes call-shaped syntax but does not resolve imports, aliases, variable reassignments, types, or dynamic dispatch. This allows it to operate deterministically on incomplete, broken, and dependency source.

Definition and enclosing-scope types are reported using the grammar's tree-sitter `Node.type` values, such as `function_declaration`, `method_definition`, or `function_item`.

Large results use Pi's standard output limits. Narrow the path scope when output is truncated.

## Cache compatibility

The index is derived data and has no migrations or automatic compatibility handling. After a schema or extraction-contract change, stop active Pi sessions using Trace and remove the cache:

```sh
rm ~/.pi/agent/extensions/trace/index.sqlite{,-shm,-wal}
```

The next query recreates it.

## Development

Requires Node.js 22.18 or newer and pnpm 11.3.0.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm format:check
```

Use `pnpm format` to apply formatting and `pnpm exec pi -e .` to load the checkout in Pi.

Grammar WASM files come from the pinned `tree-sitter-*` packages. Trace's extraction queries live in `queries/`.
