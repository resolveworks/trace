import type { CallSite, Definition, DirSymbol } from "./db.ts";

export type TraceRequest =
  | { op: "ping"; scope: string }
  | { op: "def"; scope: string; name: string }
  | { op: "callers"; scope: string; name: string }
  | { op: "outline"; scope: string };

export type TraceResult =
  | { op: "ping" }
  | { op: "def"; definitions: Definition[] }
  | { op: "callers"; callers: CallSite[] }
  | { op: "outline"; symbols: DirSymbol[] };

export type TraceResponse = { ok: true; result: TraceResult } | { ok: false; error: string };
