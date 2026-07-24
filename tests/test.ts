import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requestTrace } from "../src/client.ts";
import { closeDb, findCallers, findDefinition, getOutline, openDb, syncRoots } from "../src/db.ts";
import { indexRoot } from "../src/indexer.ts";
import { byExtension } from "../src/languages.ts";
import { ProjectFilter } from "../src/project-filter.ts";
import { TraceServer } from "../src/server.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

async function rejects(action: () => Promise<unknown>, pattern: RegExp, message: string) {
  try {
    await action();
    assert(false, message);
  } catch (error) {
    assert(pattern.test(String(error)), message);
  }
}

async function eventually(action: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await action()) {
      assert(true, message);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(false, message);
}

function write(root: string, file: string, content: string): string {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

console.log("Grammars...");
const languages = [...new Set([...byExtension.values()].map((language) => language.name))];
assert(languages.includes("typescript"), "typescript grammar");
assert(languages.includes("python"), "python grammar");
assert(languages.includes("rust"), "rust grammar");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
const rootA = path.join(temporary, "root-a");
const rootB = path.join(temporary, "root-b");
const childA = path.join(rootA, "src");
const database = path.join(temporary, "index.sqlite");
const socket = path.join(temporary, "trace.sock");
fs.mkdirSync(rootA);
fs.mkdirSync(rootB);

const aSource = write(
  rootA,
  "src/a.ts",
  [
    "export function shared(): number {",
    "  return 1;",
    "}",
    "",
    "export function useShared(): number {",
    "  return shared();",
    "}",
    "",
  ].join("\n"),
);
write(rootA, "empty.py", "# indexed, with no symbols\n");
write(rootA, ".gitignore", "ignored.py\nignored-dir/\n");
const ignoredFile = write(rootA, "ignored.py", "def ignored_symbol():\n    pass\n");
write(rootA, "ignored-dir/dependency.ts", "export function ignoredDependency() {}\n");
write(rootB, "b.ts", "export function shared(): number { return 2; }\n");

try {
  console.log("\nPersistent multi-root index...");
  openDb(database);
  let rootIds = syncRoots([rootA, rootB]);
  const resultA = indexRoot(rootIds.get(rootA)!, new ProjectFilter(rootA));
  const resultB = indexRoot(rootIds.get(rootB)!, new ProjectFilter(rootB));
  assert(resultA.files === 2, "gitignored files are excluded");
  assert(resultB.files === 1, "second root is indexed independently");
  assert(findDefinition("shared", rootA).length === 1, "definition is scoped to first root");
  assert(findDefinition("shared", rootB).length === 1, "definition is scoped to second root");
  assert(findDefinition("shared", temporary).length === 2, "directory scope uses path boundaries");
  assert(findDefinition("shared", aSource).length === 1, "file scope is exact");
  assert(findDefinition("ignored_symbol", rootA).length === 0, "ignored definition is absent");
  assert(findCallers("shared", rootA).length === 1, "callers are scope constrained");
  assert(
    getOutline(aSource).some((symbol) => symbol.name === "useShared"),
    "file outline",
  );
  assert(getOutline(childA).length > 0, "directory outline");

  closeDb();
  openDb(database);
  rootIds = syncRoots([rootA, rootB]);
  const unchanged = indexRoot(rootIds.get(rootA)!, new ProjectFilter(rootA));
  assert(unchanged.changed === 0, "persistent index skips unchanged files after restart");
  assert(findDefinition("shared", rootA).length === 1, "persistent definitions survive restart");

  const preservedTimes = fs.statSync(aSource);
  fs.writeFileSync(aSource, fs.readFileSync(aSource, "utf-8").replace("return 1", "return 3"));
  fs.utimesSync(aSource, preservedTimes.atime, preservedTimes.mtime);
  closeDb();
  openDb(database);
  rootIds = syncRoots([rootA, rootB]);
  const sameStampChange = indexRoot(rootIds.get(rootA)!, new ProjectFilter(rootA));
  assert(sameStampChange.changed === 1, "content hash detects same-size, same-mtime changes");
  closeDb();

  console.log("\nDaemon protocol...");
  const environment = {
    ...process.env,
    TRACE_PATH: `${rootA}${path.delimiter}${rootB}`,
    TRACE_DB: database,
    TRACE_SOCKET: socket,
  };
  const server = new TraceServer(environment);
  await server.start();
  try {
    const outline = await requestTrace(socket, { op: "outline", scope: childA });
    assert(outline.op === "outline", "daemon accepts an indexed subdirectory scope");

    const definition = await requestTrace(socket, {
      op: "def",
      name: "shared",
      scope: rootB,
    });
    assert(
      definition.op === "def" && definition.definitions.length === 1,
      "daemon query stays within explicit root",
    );

    const emptyOutline = await requestTrace(socket, {
      op: "outline",
      scope: path.join(rootA, "empty.py"),
    });
    assert(
      emptyOutline.op === "outline" && emptyOutline.symbols.length === 0,
      "indexed file with no symbols is a valid empty result",
    );

    await rejects(
      () => requestTrace(socket, { op: "outline", scope: ignoredFile }),
      /file is not indexed/,
      "ignored file fails as an unindexed scope",
    );
    await rejects(
      () => requestTrace(socket, { op: "outline", scope: temporary }),
      /outside TRACE_PATH/,
      "scope outside configured roots fails",
    );

    const added = path.join(rootA, "src", "added.ts");
    write(rootA, "src/added.ts", "export function watchedSymbol() {}\n");
    await eventually(async () => {
      const response = await requestTrace(socket, {
        op: "def",
        name: "watchedSymbol",
        scope: rootA,
      });
      return response.op === "def" && response.definitions.length === 1;
    }, "watcher indexes added source files");

    fs.unlinkSync(added);
    await eventually(async () => {
      const response = await requestTrace(socket, {
        op: "def",
        name: "watchedSymbol",
        scope: rootA,
      });
      return response.op === "def" && response.definitions.length === 0;
    }, "watcher removes deleted source files");
  } finally {
    await server.close();
  }

  await rejects(
    () => requestTrace(socket, { op: "outline", scope: rootA }),
    /ENOENT|ECONNREFUSED/,
    "daemon unavailability is a hard client error",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
