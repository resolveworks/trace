import type { CallSite, Definition, DirSymbol } from "./db.ts";

export type TraceRequest =
  | { id: number; op: "ping"; scope: string }
  | { id: number; op: "def"; scope: string; name: string }
  | { id: number; op: "callers"; scope: string; name: string }
  | { id: number; op: "outline"; scope: string };

export type TraceResult =
  | { op: "ping" }
  | { op: "def"; definitions: Definition[] }
  | { op: "callers"; callers: CallSite[] }
  | { op: "outline"; symbols: DirSymbol[] };

export type TraceResponse =
  | { id: number; ok: true; result: TraceResult }
  | { id: number; ok: false; error: string };
