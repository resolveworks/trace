import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as path from "node:path";
import { ENV_DIRS } from "./project-filter.ts";

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
  database.exec(`
    CREATE TABLE IF NOT EXISTS roots (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      language TEXT NOT NULL,
      UNIQUE(hash, language)
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      content_id INTEGER NOT NULL REFERENCES contents(id)
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY,
      content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_files_root ON files(root_id);
    CREATE INDEX IF NOT EXISTS idx_files_content ON files(content_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_content ON symbols(content_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);
    CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);
    CREATE INDEX IF NOT EXISTS idx_calls_content ON calls(content_id);
    CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);
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

    deleteOrphanContents();

    const rows = database.prepare("SELECT id, path FROM roots").all() as {
      id: number;
      path: string;
    }[];
    return new Map(rows.map((row) => [row.path, row.id]));
  });
  return sync();
}

export function getIndexedFiles(rootId: number): Map<string, string> {
  const rows = requireDb()
    .prepare(
      "SELECT f.path, c.hash FROM files f JOIN contents c ON c.id = f.content_id WHERE f.root_id = ?",
    )
    .all(rootId) as { path: string; hash: string }[];
  return new Map(rows.map((row) => [row.path, row.hash]));
}

export function replaceFile(
  rootId: number,
  file: string,
  hash: string,
  language: string,
  extract: (contentId: number) => void,
): void {
  const database = requireDb();
  database.transaction(() => {
    const previous = database.prepare("SELECT content_id FROM files WHERE path = ?").get(file) as
      | { content_id: number }
      | undefined;
    let content = database
      .prepare("SELECT id FROM contents WHERE hash = ? AND language = ?")
      .get(hash, language) as { id: number } | undefined;

    if (!content) {
      const result = database
        .prepare("INSERT INTO contents(hash, language) VALUES (?, ?)")
        .run(hash, language);
      content = { id: Number(result.lastInsertRowid) };
      extract(content.id);
    }

    database
      .prepare(
        `INSERT INTO files(root_id, path, content_id) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET root_id = excluded.root_id, content_id = excluded.content_id`,
      )
      .run(rootId, file, content.id);
    if (previous && previous.content_id !== content.id) deleteOrphanContents();
  })();
}

export function deleteOrphanContents(): void {
  requireDb()
    .prepare(
      "DELETE FROM contents WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.content_id = contents.id)",
    )
    .run();
}

export function deleteFile(file: string, collectOrphans = true): void {
  const database = requireDb();
  database.transaction(() => {
    database.prepare("DELETE FROM files WHERE path = ?").run(file);
    if (collectOrphans) deleteOrphanContents();
  })();
}

export function isIndexedFile(file: string): boolean {
  return requireDb().prepare("SELECT 1 FROM files WHERE path = ?").get(file) !== undefined;
}

export function hasIndexedFileUnder(directory: string): boolean {
  const excludeEnvironments = scopeIncludesEnvironment(directory)
    ? ""
    : ` AND ${EXCLUDE_ENVIRONMENTS}`;
  return (
    requireDb()
      .prepare(`SELECT 1 FROM files f WHERE f.path GLOB ? || '/*'${excludeEnvironments} LIMIT 1`)
      .get(directory) !== undefined
  );
}

export function insertSymbol(
  contentId: number,
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
  parentId: number | null = null,
): number {
  const result = requireDb()
    .prepare(
      "INSERT INTO symbols (content_id, name, kind, start_line, end_line, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(contentId, name, kind, startLine, endLine, parentId);
  return Number(result.lastInsertRowid);
}

export function updateSymbolParent(id: number, parentId: number): void {
  requireDb().prepare("UPDATE symbols SET parent_id = ? WHERE id = ?").run(parentId, id);
}

export function insertCall(
  contentId: number,
  callerId: number | null,
  calleeName: string,
  line: number,
  endLine: number,
): void {
  requireDb()
    .prepare(
      "INSERT INTO calls (content_id, caller_id, callee_name, line, end_line) VALUES (?, ?, ?, ?, ?)",
    )
    .run(contentId, callerId, calleeName, line, endLine);
}

const IN_SCOPE = "(f.path = ? OR f.path GLOB ? || '/*')";
const EXCLUDE_ENVIRONMENTS = [...ENV_DIRS]
  .map((name) => `f.path NOT GLOB '*/${name}/*'`)
  .join(" AND ");

function scopeIncludesEnvironment(scope: string): boolean {
  return scope.split(path.sep).some((segment) => ENV_DIRS.has(segment));
}

function environmentFilter(scope: string): string {
  return scopeIncludesEnvironment(scope) ? "" : ` AND ${EXCLUDE_ENVIRONMENTS}`;
}

export function findDefinition(name: string, scope: string): Definition[] {
  const rows = requireDb()
    .prepare(
      `SELECT s.id, s.name, s.kind, f.path AS file, s.start_line, s.end_line, s.parent_id,
              p.name AS parent_name, p.kind AS parent_kind
       FROM symbols s
       JOIN files f ON f.content_id = s.content_id
       LEFT JOIN symbols p ON s.parent_id = p.id
       WHERE s.name = ? AND ${IN_SCOPE}${environmentFilter(scope)}
       ORDER BY length(f.path), f.path, s.start_line`,
    )
    .all(name, scope, scope) as Record<string, unknown>[];
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
       JOIN files f ON f.content_id = c.content_id
       LEFT JOIN symbols s ON c.caller_id = s.id
       WHERE c.callee_name = ? AND ${IN_SCOPE}${environmentFilter(scope)}
       ORDER BY length(f.path), f.path, c.line`,
    )
    .all(name, scope, scope) as Record<string, unknown>[];
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
       JOIN files f ON f.content_id = s.content_id
       WHERE ${IN_SCOPE}${environmentFilter(scope)}
       ORDER BY f.path, s.start_line`,
    )
    .all(scope, scope) as Record<string, unknown>[];
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
