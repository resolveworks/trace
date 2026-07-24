import * as net from "node:net";
import type { TraceRequest, TraceResponse, TraceResult } from "./protocol.ts";

export function requestTrace(socketPath: string, request: TraceRequest): Promise<TraceResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf-8");
    let input = "";

    socket.once("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      try {
        const response = JSON.parse(input.slice(0, newline)) as TraceResponse;
        if (!response.ok) throw new Error(response.error);
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("close", () => {
      if (!input.includes("\n")) reject(new Error("trace daemon closed without a response"));
    });
  });
}
