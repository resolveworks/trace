import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export interface Symbol {
  id: number;
  name: string;
  kind: string; // function_declaration, method_definition, class_declaration, etc.
  file: string;
  start_line: number;
  end_line: number;
  body: string;
}

export interface CallSite {
  caller_name: string;
  caller_kind: string;
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
      body TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id INTEGER NOT NULL,
      caller_name TEXT NOT NULL,
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

export function insertSymbol(
  name: string,
  kind: string,
  file: string,
  startLine: number,
  endLine: number,
  body: string,
): number {
  if (!db) throw new Error("Database not open");
  const stmt = db.prepare(
    "INSERT INTO symbols (name, kind, file, start_line, end_line, body) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const result = stmt.run(name, kind, file, startLine, endLine, body);
  return Number(result.lastInsertRowid);
}

export function insertCall(
  callerId: number,
  callerName: string,
  calleeName: string,
  file: string,
  line: number,
): void {
  if (!db) throw new Error("Database not open");
  const stmt = db.prepare(
    "INSERT INTO calls (caller_id, caller_name, callee_name, file, line) VALUES (?, ?, ?, ?, ?)",
  );
  stmt.run(callerId, callerName, calleeName, file, line);
}

// --- Query functions ---

export function findDefinition(name: string): Symbol | null {
  if (!db) return null;
  const row = db.prepare("SELECT * FROM symbols WHERE name = ? LIMIT 1").get(name) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    name: row.name as string,
    kind: row.kind as string,
    file: row.file as string,
    start_line: row.start_line as number,
    end_line: row.end_line as number,
    body: row.body as string,
  };
}

export function findCallers(name: string): CallSite[] {
  if (!db) return [];
  const rows = db.prepare("SELECT * FROM calls WHERE callee_name = ?").all(name) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    caller_name: r.caller_name as string,
    caller_kind: r.caller_kind as string,
    callee_name: r.callee_name as string,
    file: r.file as string,
    line: r.line as number,
  }));
}

export function getOutline(file: string): { name: string; kind: string; start_line: number; end_line: number }[] {
  if (!db) return [];
  const rows = db
    .prepare("SELECT name, kind, start_line, end_line FROM symbols WHERE file = ? ORDER BY start_line")
    .all(file) as Record<string, unknown>[];
  return rows.map((r) => ({
    name: r.name as string,
    kind: r.kind as string,
    start_line: r.start_line as number,
    end_line: r.end_line as number,
  }));
}
