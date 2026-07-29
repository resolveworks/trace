import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";

export interface Definition {
  name: string;
  node_type: string;
  file: string;
  start_line: number;
  end_line: number;
  parent_name: string | null;
}

export interface CallSite {
  caller_name: string | null;
  caller_node_type: string | null;
  file: string;
  line: number;
  end_line: number;
}

export interface OutlineSymbol {
  id: number;
  name: string;
  node_type: string;
  start_line: number;
  end_line: number;
  parent_id: number | null;
}

export interface DirSymbol extends OutlineSymbol {
  file: string;
}

/**
 * Freshness hint for one path: a stat match means the file is skipped without
 * being read. Archive tools can preserve mtimes, so this is only a cache —
 * content identity is the hash, never the stat.
 */
export interface FileStat {
  size: bigint;
  mtimeNs: bigint;
}

export function sameStat(a: FileStat, b: FileStat): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs;
}

let db: DatabaseType | null = null;
let statements: Statements | null = null;

const IS_DESCENDANT = "f.path >= ? AND f.path < ?";
const IN_SCOPE = `(f.path = ? OR (${IS_DESCENDANT}))`;

function requireDb(): DatabaseType {
  if (!db) throw new Error("trace database is not open");
  return db;
}

function requireStatements(): Statements {
  if (!statements) throw new Error("trace database is not open");
  return statements;
}

/** Hot-path statements, prepared once when the database opens. */
interface Statements {
  cachedFileStatsUnder: Statement;
  cachedNonEnvironmentFileStatsUnder: Statement;
  cachedFileStat: Statement;
  fileContent: Statement;
  contentByHash: Statement;
  insertContent: Statement;
  upsertFile: Statement;
  deleteOrphans: Statement;
  deleteFile: Statement;
  insertSymbol: Statement;
  updateParent: Statement;
  insertCall: Statement;
}

function prepareStatements(database: DatabaseType): Statements {
  return {
    cachedFileStatsUnder: database.prepare(
      `SELECT f.path, f.size, f.mtime_ns FROM files f WHERE ${IS_DESCENDANT}`,
    ),
    cachedNonEnvironmentFileStatsUnder: database.prepare(
      `SELECT f.path, f.size, f.mtime_ns FROM files f
       WHERE ${IS_DESCENDANT}${environmentFilter(false)}`,
    ),
    cachedFileStat: database.prepare("SELECT size, mtime_ns FROM files WHERE path = ?"),
    fileContent: database.prepare("SELECT content_id FROM files WHERE path = ?"),
    contentByHash: database.prepare("SELECT id FROM contents WHERE hash = ? AND language = ?"),
    insertContent: database.prepare("INSERT INTO contents(hash, language) VALUES (?, ?)"),
    upsertFile: database.prepare(
      `INSERT INTO files(path, content_id, size, mtime_ns, is_environment) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET content_id = excluded.content_id,
         size = excluded.size, mtime_ns = excluded.mtime_ns,
         is_environment = excluded.is_environment`,
    ),
    deleteOrphans: database.prepare(
      "DELETE FROM contents WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.content_id = contents.id)",
    ),
    deleteFile: database.prepare("DELETE FROM files WHERE path = ?"),
    insertSymbol: database.prepare(
      "INSERT INTO symbols (content_id, name, node_type, start_line, end_line, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    updateParent: database.prepare("UPDATE symbols SET parent_id = ? WHERE id = ?"),
    insertCall: database.prepare(
      "INSERT INTO calls (content_id, caller_id, callee_name, line, end_line) VALUES (?, ?, ?, ?, ?)",
    ),
  };
}

export function openDb(file: string): void {
  if (db) throw new Error("trace database is already open");
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  statements = prepareStatements(db);
}

export function closeDb(): void {
  requireDb().close();
  db = null;
  statements = null;
}

function createSchema(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      language TEXT NOT NULL,
      UNIQUE(hash, language)
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      content_id INTEGER NOT NULL REFERENCES contents(id),
      size INTEGER NOT NULL,
      mtime_ns INTEGER NOT NULL,
      is_environment INTEGER NOT NULL CHECK (is_environment IN (0, 1))
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY,
      content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      node_type TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
      caller_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
      callee_name TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_content ON files(content_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_content ON symbols(content_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);
    CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);
    CREATE INDEX IF NOT EXISTS idx_calls_content ON calls(content_id);
    CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);
  `);
}

export function getFileStatsInScope(
  scope: string,
  includeEnvironments: boolean,
): Map<string, FileStat> {
  const statements = requireStatements();
  const statement = includeEnvironments
    ? statements.cachedFileStatsUnder
    : statements.cachedNonEnvironmentFileStatsUnder;
  const rows = statement.safeIntegers(true).all(...descendantRange(scope)) as {
    path: string;
    size: bigint;
    mtime_ns: bigint;
  }[];
  const files = new Map(rows.map((row) => [row.path, { size: row.size, mtimeNs: row.mtime_ns }]));
  const exact = statements.cachedFileStat.safeIntegers(true).get(scope) as
    | { size: bigint; mtime_ns: bigint }
    | undefined;
  if (exact) files.set(scope, { size: exact.size, mtimeNs: exact.mtime_ns });
  return files;
}

export function replaceFile(
  file: string,
  stat: FileStat,
  hash: string,
  language: string,
  isEnvironment: boolean,
  extract: (contentId: number) => void,
): void {
  const database = requireDb();
  const stmts = requireStatements();
  database.transaction(() => {
    const previous = stmts.fileContent.get(file) as { content_id: number } | undefined;
    let content = stmts.contentByHash.get(hash, language) as { id: number } | undefined;

    if (!content) {
      const result = stmts.insertContent.run(hash, language);
      content = { id: Number(result.lastInsertRowid) };
      extract(content.id);
    }

    stmts.upsertFile.run(file, content.id, stat.size, stat.mtimeNs, Number(isEnvironment));
    if (previous && previous.content_id !== content.id) deleteOrphanContents();
  })();
}

function deleteOrphanContents(): void {
  requireStatements().deleteOrphans.run();
}

export function deleteFiles(files: string[]): void {
  if (files.length === 0) return;
  const database = requireDb();
  const remove = requireStatements().deleteFile;
  database.transaction(() => {
    for (const file of files) remove.run(file);
    deleteOrphanContents();
  })();
}

export function insertSymbol(
  contentId: number,
  name: string,
  nodeType: string,
  startLine: number,
  endLine: number,
  parentId: number | null = null,
): number {
  const result = requireStatements().insertSymbol.run(
    contentId,
    name,
    nodeType,
    startLine,
    endLine,
    parentId,
  );
  return Number(result.lastInsertRowid);
}

export function updateSymbolParent(id: number, parentId: number): void {
  requireStatements().updateParent.run(parentId, id);
}

export function insertCall(
  contentId: number,
  callerId: number | null,
  calleeName: string,
  line: number,
  endLine: number,
): void {
  requireStatements().insertCall.run(contentId, callerId, calleeName, line, endLine);
}

function environmentFilter(includeEnvironments: boolean): string {
  return includeEnvironments ? "" : " AND f.is_environment = 0";
}

function descendantRange(scope: string): [string, string] {
  const prefix = scope.endsWith("/") ? scope : `${scope}/`;
  // "0" is the immediate ASCII successor to the trailing slash.
  return [prefix, `${prefix.slice(0, -1)}0`];
}

function scopeParameters(scope: string): [string, string, string] {
  return [scope, ...descendantRange(scope)];
}

function scopedFilesQuery(includeEnvironments: boolean): string {
  const filter = environmentFilter(includeEnvironments);
  return `
    SELECT f.path, f.content_id FROM files f
    WHERE f.path = ?${filter}
    UNION ALL
    SELECT f.path, f.content_id FROM files f
    WHERE ${IS_DESCENDANT}${filter}`;
}

export function findDefinition(
  name: string,
  scope: string,
  includeEnvironments: boolean,
): Definition[] {
  const rows = requireDb()
    .prepare(
      `SELECT s.name, s.node_type, f.path AS file, s.start_line, s.end_line,
              p.name AS parent_name
       FROM symbols s
       JOIN files f ON f.content_id = s.content_id
       LEFT JOIN symbols p ON s.parent_id = p.id
       WHERE s.name = ? AND ${IN_SCOPE}${environmentFilter(includeEnvironments)}
       ORDER BY length(f.path), f.path, s.start_line`,
    )
    .all(name, ...scopeParameters(scope)) as Record<string, unknown>[];
  return rows.map((row) => ({
    name: row.name as string,
    node_type: row.node_type as string,
    file: row.file as string,
    start_line: row.start_line as number,
    end_line: row.end_line as number,
    parent_name: (row.parent_name as string | null) ?? null,
  }));
}

export function findCallers(name: string, scope: string, includeEnvironments: boolean): CallSite[] {
  const rows = requireDb()
    .prepare(
      `SELECT s.name AS caller_name, s.node_type AS caller_node_type,
              f.path AS file, c.line, c.end_line
       FROM calls c
       JOIN files f ON f.content_id = c.content_id
       LEFT JOIN symbols s ON c.caller_id = s.id
       WHERE c.callee_name = ? AND ${IN_SCOPE}${environmentFilter(includeEnvironments)}
       ORDER BY length(f.path), f.path, c.line`,
    )
    .all(name, ...scopeParameters(scope)) as Record<string, unknown>[];
  return rows.map((row) => ({
    caller_name: (row.caller_name as string | null) ?? null,
    caller_node_type: (row.caller_node_type as string | null) ?? null,
    file: row.file as string,
    line: row.line as number,
    end_line: row.end_line as number,
  }));
}

export function getOutline(scope: string, includeEnvironments: boolean): DirSymbol[] {
  const rows = requireDb()
    .prepare(
      `WITH f AS (${scopedFilesQuery(includeEnvironments)})
       SELECT f.path AS file, s.id, s.name, s.node_type, s.start_line, s.end_line, s.parent_id
       FROM f
       JOIN symbols s ON s.content_id = f.content_id
       ORDER BY f.path, s.start_line`,
    )
    .all(...scopeParameters(scope)) as Record<string, unknown>[];
  return rows.map((row) => ({
    file: row.file as string,
    id: row.id as number,
    name: row.name as string,
    node_type: row.node_type as string,
    start_line: row.start_line as number,
    end_line: row.end_line as number,
    parent_id: (row.parent_id as number | null) ?? null,
  }));
}
