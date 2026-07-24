import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface Symbol {
  id: number;
  name: string;
  kind: string;
  file: string;
  start_line: number;
  end_line: number;
  parent_id: number | null;
}

export interface Definition extends Symbol {
  parent_name: string | null;
  parent_kind: string | null;
}

export interface CallSite {
  caller_name: string | null;
  caller_kind: string | null;
  callee_name: string;
  file: string;
  line: number;
  end_line: number;
}

export interface OutlineSymbol {
  id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  parent_id: number | null;
}

export interface DirSymbol extends OutlineSymbol {
  file: string;
}

export interface FileStamp {
  hash: string;
}

let db: DatabaseType | null = null;

function requireDb(): DatabaseType {
  if (!db) throw new Error("trace database is not open");
  return db;
}

export function openDb(file: string): DatabaseType {
  if (db) throw new Error("trace database is already open");
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  return db;
}

export function closeDb(): void {
  requireDb().close();
  db = null;
}

function createSchema(database: DatabaseType): void {
  const version = database.pragma("user_version", { simple: true }) as number;
  if (version === 1) return;
  if (version !== 0) throw new Error(`unsupported trace database schema version ${version}`);

  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  if (tables.length > 0) throw new Error("trace database has an unversioned schema");

  database.exec(`
    CREATE TABLE roots (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE
    );

    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL
    );

    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE
    );

    CREATE TABLE calls (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      caller_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
      callee_name TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL
    );

    CREATE INDEX idx_files_root ON files(root_id);
    CREATE INDEX idx_symbols_name ON symbols(name);
    CREATE INDEX idx_symbols_file ON symbols(file_id);
    CREATE INDEX idx_calls_callee ON calls(callee_name);
    CREATE INDEX idx_calls_file ON calls(file_id);

    PRAGMA user_version = 1;
  `);
}

export function syncRoots(paths: string[]): Map<string, number> {
  const database = requireDb();
  const sync = database.transaction(() => {
    const wanted = new Set(paths);
    const existing = database.prepare("SELECT id, path FROM roots").all() as {
      id: number;
      path: string;
    }[];
    const remove = database.prepare("DELETE FROM roots WHERE id = ?");
    for (const root of existing) {
      if (!wanted.has(root.path)) remove.run(root.id);
    }

    const insert = database.prepare("INSERT OR IGNORE INTO roots(path) VALUES (?)");
    for (const root of paths) insert.run(root);

    const rows = database.prepare("SELECT id, path FROM roots").all() as {
      id: number;
      path: string;
    }[];
    return new Map(rows.map((row) => [row.path, row.id]));
  });
  return sync();
}

export function getIndexedFiles(rootId: number): Map<string, FileStamp> {
  const rows = requireDb()
    .prepare("SELECT path, hash FROM files WHERE root_id = ?")
    .all(rootId) as { path: string; hash: string }[];
  return new Map(rows.map((row) => [row.path, { hash: row.hash }]));
}

export function replaceFile(
  rootId: number,
  file: string,
  stamp: FileStamp,
  extract: (fileId: number) => void,
): void {
  const database = requireDb();
  database.transaction(() => {
    database.prepare("DELETE FROM files WHERE path = ?").run(file);
    const result = database
      .prepare("INSERT INTO files(root_id, path, hash) VALUES (?, ?, ?)")
      .run(rootId, file, stamp.hash);
    extract(Number(result.lastInsertRowid));
  })();
}

export function deleteFile(file: string): void {
  requireDb().prepare("DELETE FROM files WHERE path = ?").run(file);
}

export function isIndexedFile(file: string): boolean {
  return requireDb().prepare("SELECT 1 FROM files WHERE path = ?").get(file) !== undefined;
}

export function hasIndexedFileUnder(directory: string): boolean {
  return (
    requireDb()
      .prepare("SELECT 1 FROM files f WHERE substr(f.path, 1, length(?) + 1) = ? || '/' LIMIT 1")
      .get(directory, directory) !== undefined
  );
}

export function insertSymbol(
  fileId: number,
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
  parentId: number | null = null,
): number {
  const result = requireDb()
    .prepare(
      "INSERT INTO symbols (file_id, name, kind, start_line, end_line, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(fileId, name, kind, startLine, endLine, parentId);
  return Number(result.lastInsertRowid);
}

export function updateSymbolParent(id: number, parentId: number): void {
  requireDb().prepare("UPDATE symbols SET parent_id = ? WHERE id = ?").run(parentId, id);
}

export function insertCall(
  fileId: number,
  callerId: number | null,
  calleeName: string,
  line: number,
  endLine: number,
): void {
  requireDb()
    .prepare(
      "INSERT INTO calls (file_id, caller_id, callee_name, line, end_line) VALUES (?, ?, ?, ?, ?)",
    )
    .run(fileId, callerId, calleeName, line, endLine);
}

const IN_SCOPE = "(f.path = ? OR substr(f.path, 1, length(?) + 1) = ? || '/')";

export function findDefinition(name: string, scope: string): Definition[] {
  const rows = requireDb()
    .prepare(
      `SELECT s.id, s.name, s.kind, f.path AS file, s.start_line, s.end_line, s.parent_id,
              p.name AS parent_name, p.kind AS parent_kind
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       LEFT JOIN symbols p ON s.parent_id = p.id
       WHERE s.name = ? AND ${IN_SCOPE}
       ORDER BY length(f.path), f.path, s.start_line`,
    )
    .all(name, scope, scope, scope) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as number,
    name: row.name as string,
    kind: row.kind as string,
    file: row.file as string,
    start_line: row.start_line as number,
    end_line: row.end_line as number,
    parent_id: (row.parent_id as number | null) ?? null,
    parent_name: (row.parent_name as string | null) ?? null,
    parent_kind: (row.parent_kind as string | null) ?? null,
  }));
}

export function findCallers(name: string, scope: string): CallSite[] {
  const rows = requireDb()
    .prepare(
      `SELECT s.name AS caller_name, s.kind AS caller_kind, c.callee_name,
              f.path AS file, c.line, c.end_line
       FROM calls c
       JOIN files f ON c.file_id = f.id
       LEFT JOIN symbols s ON c.caller_id = s.id
       WHERE c.callee_name = ? AND ${IN_SCOPE}
       ORDER BY length(f.path), f.path, c.line`,
    )
    .all(name, scope, scope, scope) as Record<string, unknown>[];
  return rows.map((row) => ({
    caller_name: (row.caller_name as string | null) ?? null,
    caller_kind: (row.caller_kind as string | null) ?? null,
    callee_name: row.callee_name as string,
    file: row.file as string,
    line: row.line as number,
    end_line: row.end_line as number,
  }));
}

export function getOutline(scope: string): DirSymbol[] {
  const rows = requireDb()
    .prepare(
      `SELECT f.path AS file, s.id, s.name, s.kind, s.start_line, s.end_line, s.parent_id
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE ${IN_SCOPE}
       ORDER BY f.path, s.start_line`,
    )
    .all(scope, scope, scope) as Record<string, unknown>[];
  return rows.map((row) => ({
    file: row.file as string,
    id: row.id as number,
    name: row.name as string,
    kind: row.kind as string,
    start_line: row.start_line as number,
    end_line: row.end_line as number,
    parent_id: (row.parent_id as number | null) ?? null,
  }));
}
