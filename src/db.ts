import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface Symbol {
  id: number;
  name: string;
  kind: string; // function_declaration, method_definition, class_declaration, etc.
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
}

let db: DatabaseType | null = null;

export function openDb(): DatabaseType {
  if (db) return db;
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      parent_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id INTEGER,
      callee_name TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      FOREIGN KEY (caller_id) REFERENCES symbols(id)
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
    CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);
    CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(file);
  `);
}

export function clearAll(): void {
  if (!db) return;
  db.exec("DELETE FROM symbols; DELETE FROM calls;");
}

export function deleteByFile(file: string): void {
  if (!db) return;
  db.prepare("DELETE FROM calls WHERE file = ?").run(file);
  db.prepare("DELETE FROM symbols WHERE file = ?").run(file);
}

export function insertSymbol(
  name: string,
  kind: string,
  file: string,
  startLine: number,
  endLine: number,
  parentId: number | null = null,
): number {
  if (!db) throw new Error("Database not open");
  const stmt = db.prepare(
    "INSERT INTO symbols (name, kind, file, start_line, end_line, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const result = stmt.run(name, kind, file, startLine, endLine, parentId);
  return Number(result.lastInsertRowid);
}

export function updateSymbolParent(id: number, parentId: number): void {
  if (!db) throw new Error("Database not open");
  const stmt = db.prepare("UPDATE symbols SET parent_id = ? WHERE id = ?");
  stmt.run(parentId, id);
}

export function insertCall(
  callerId: number | null,
  calleeName: string,
  file: string,
  line: number,
): void {
  if (!db) throw new Error("Database not open");
  const stmt = db.prepare(
    "INSERT INTO calls (caller_id, callee_name, file, line) VALUES (?, ?, ?, ?)",
  );
  stmt.run(callerId, calleeName, file, line);
}

// --- Query functions ---

export function findDefinition(name: string, file?: string): Definition[] {
  if (!db) return [];
  let sql = `SELECT s.*, p.name AS parent_name, p.kind AS parent_kind
       FROM symbols s
       LEFT JOIN symbols p ON s.parent_id = p.id
       WHERE s.name = ?`;
  const args: (string | null)[] = [name];
  if (file) {
    sql += " AND s.file = ?";
    args.push(file);
  }
  sql += " ORDER BY LENGTH(s.file) ASC, s.start_line ASC";
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
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

export function findCallers(name: string): CallSite[] {
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT s.name AS caller_name, s.kind AS caller_kind, c.callee_name, c.file, c.line
       FROM calls c
       LEFT JOIN symbols s ON c.caller_id = s.id
       WHERE c.callee_name = ?
       ORDER BY LENGTH(c.file) ASC, c.line ASC`,
    )
    .all(name) as Record<string, unknown>[];
  return rows.map((r) => ({
    caller_name: (r.caller_name as string) ?? null,
    caller_kind: (r.caller_kind as string) ?? null,
    callee_name: r.callee_name as string,
    file: r.file as string,
    line: r.line as number,
  }));
}

export interface OutlineSymbol {
  id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  parent_id: number | null;
}

export function getOutline(file: string, deep = false): OutlineSymbol[] {
  if (!db) return [];
  let sql = "SELECT id, name, kind, start_line, end_line, parent_id FROM symbols WHERE file = ?";
  if (!deep) {
    sql += " AND parent_id IS NULL";
  }
  sql += " ORDER BY start_line";
  const rows = db.prepare(sql).all(file) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    kind: r.kind as string,
    start_line: r.start_line as number,
    end_line: r.end_line as number,
    parent_id: (r.parent_id as number | null) ?? null,
  }));
}

export interface DirSymbol extends OutlineSymbol {
  file: string;
}

/** List all symbols from indexed files under a directory prefix. */
export function getDirOutline(dir: string, deep = false): DirSymbol[] {
  if (!db) return [];
  const prefix = dir ? `${dir}/` : "";
  let sql = `SELECT file, id, name, kind, start_line, end_line, parent_id
       FROM symbols
       WHERE file LIKE (? || '%')`;
  if (!deep) {
    sql += " AND parent_id IS NULL";
  }
  sql += " ORDER BY file, start_line";
  const rows = db.prepare(sql).all(prefix) as Record<string, unknown>[];
  return rows.map((r) => ({
    file: r.file as string,
    id: r.id as number,
    name: r.name as string,
    kind: r.kind as string,
    start_line: r.start_line as number,
    end_line: r.end_line as number,
    parent_id: (r.parent_id as number | null) ?? null,
  }));
}
