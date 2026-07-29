import * as fs from "node:fs";
import * as path from "node:path";
import { closeDb, findCallers, findDefinition, getOutline, openDb } from "./db.ts";
import { isPathMissing } from "./fs-errors.ts";
import { closeIndexer, initializeIndexer, reconcileDirectory, reconcileFile } from "./indexer.ts";
import { closeLanguages } from "./languages.ts";
import { SourceFilter } from "./source-filter.ts";

const filter = new SourceFilter();

export async function initializeTrace(database: string): Promise<void> {
  await initializeIndexer();
  fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
  openDb(database);
}

export function closeTrace(): void {
  closeDb();
  closeIndexer();
  closeLanguages();
}

function reconcileScope(requested: string): {
  scope: string;
  includeEnvironments: boolean;
} {
  const scope = path.resolve(requested);
  let stat: ReturnType<typeof fs.statSync>;
  try {
    stat = fs.statSync(scope);
  } catch (error) {
    if (!isPathMissing(error)) throw error;
    throw new Error(`scope does not exist: ${requested}`);
  }
  const isFile = stat.isFile();
  const isDirectory = stat.isDirectory();
  if (!isFile && !isDirectory) {
    throw new Error(`scope is not a file or directory: ${scope}`);
  }

  filter.invalidate();
  const includeEnvironments = filter.isEnvironmentPath(scope);
  if (isFile) {
    if (!reconcileFile(filter, scope)) {
      throw new Error(`file is not accepted source: ${scope}`);
    }
  } else {
    reconcileDirectory(filter, scope);
  }
  return { scope, includeEnvironments };
}

export function getDefinitions(name: string, requestedScope: string) {
  const { scope, includeEnvironments } = reconcileScope(requestedScope);
  return findDefinition(name, scope, includeEnvironments);
}

export function getCallers(name: string, requestedScope: string) {
  const { scope, includeEnvironments } = reconcileScope(requestedScope);
  return findCallers(name, scope, includeEnvironments);
}

export function getSymbols(requestedScope: string) {
  const { scope, includeEnvironments } = reconcileScope(requestedScope);
  return getOutline(scope, includeEnvironments);
}
