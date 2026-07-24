import { Type, type Static } from "typebox";
import type { CallSite, Definition, DirSymbol } from "./db.ts";

export const TraceRequestSchema = Type.Union([
  Type.Object({ op: Type.Literal("def"), scope: Type.String(), name: Type.String() }),
  Type.Object({ op: Type.Literal("callers"), scope: Type.String(), name: Type.String() }),
  Type.Object({ op: Type.Literal("outline"), scope: Type.String() }),
]);

export type TraceRequest = Static<typeof TraceRequestSchema>;

export type TraceResult =
  | { op: "def"; definitions: Definition[] }
  | { op: "callers"; callers: CallSite[] }
  | { op: "outline"; symbols: DirSymbol[] };

export type TraceResponse = { ok: true; result: TraceResult } | { ok: false; error: string };
