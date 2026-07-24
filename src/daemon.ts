import { TraceServer } from "./server.ts";

const server = new TraceServer();
await server.start();

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
