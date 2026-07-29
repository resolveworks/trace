import * as fs from "node:fs";
import * as path from "node:path";
import { isPathMissing } from "./fs-errors.ts";
import type { ProjectFilter } from "./project-filter.ts";

/**
 * Find supported source files in deterministic order. Directory symlinks keep
 * their logical paths; physical identity prevents cycles only on the current
 * recursion branch, so independent aliases remain independently queryable.
 *
 * A project scope does not enter installed environments. A scope already
 * inside an environment does, making dependency indexing entirely on demand.
 */
export function walkSourceFiles(filter: ProjectFilter, dir: string): string[] {
  const includeEnvironments = filter.isEnvironmentPath(dir);
  if (dir !== filter.root && !mayEnter(filter, dir, includeEnvironments)) return [];

  const rootStat = fs.statSync(dir, { bigint: true });
  if (!rootStat.isDirectory()) {
    if (dir !== filter.root) return [];
    throw new Error(`not a directory: ${dir}`);
  }

  const files: string[] = [];
  const ancestors = new Set<string>();

  const visit = (current: string, stats: fs.BigIntStats): void => {
    const identity = `${stats.dev}:${stats.ino}`;
    if (ancestors.has(identity)) return;
    ancestors.add(identity);
    try {
      let entries: fs.Dirent[];
      try {
        entries = fs
          .readdirSync(current, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) {
        if (current !== dir && isPathMissing(error)) return;
        throw error;
      }

      for (const entry of entries) {
        const candidate = path.join(current, entry.name);
        let directoryStats: fs.BigIntStats | null = null;
        let isDirectory = entry.isDirectory();

        if (entry.isSymbolicLink()) {
          try {
            directoryStats = fs.statSync(candidate, { bigint: true });
            isDirectory = directoryStats.isDirectory();
          } catch (error) {
            if (isPathMissing(error)) continue;
            throw error;
          }
        }

        if (isDirectory && mayEnter(filter, candidate, includeEnvironments)) {
          try {
            directoryStats ??= fs.statSync(candidate, { bigint: true });
            if (directoryStats.isDirectory()) visit(candidate, directoryStats);
          } catch (error) {
            if (!isPathMissing(error)) throw error;
          }
        } else if (entry.isFile() && filter.includesFile(candidate)) {
          files.push(candidate);
        }
      }
    } finally {
      ancestors.delete(identity);
    }
  };

  visit(dir, rootStat);
  return files;
}

function mayEnter(filter: ProjectFilter, directory: string, includeEnvironments: boolean): boolean {
  return (
    filter.includesDirectory(directory) &&
    (includeEnvironments || !filter.isEnvironmentPath(directory))
  );
}
