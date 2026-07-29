import * as fs from "node:fs";
import * as path from "node:path";
import { isPathMissing } from "./fs-errors.ts";
import type { ProjectFilter } from "./project-filter.ts";

export interface DirectoryListing {
  /** Logical path of an included directory. */
  directory: string;
  /** Included source files directly inside the directory. */
  files: string[];
}

export interface DirectoryTarget {
  device: bigint;
  inode: bigint;
}

export type TraversalMode = "index" | "watch";

/**
 * Walk included directories in deterministic readdir order, following
 * directory symlinks through their logical paths. Index mode enters installed
 * environments; watch mode stops before them.
 *
 * Physical identity is only a cycle guard. An identity is suppressed while it
 * is already on the current recursion branch, then released so independent
 * logical aliases remain independently traversable.
 *
 * `onDirectory` fires before entries are read, allowing first-party watchers
 * to be established on each parent before its children are scanned.
 */
export function walkDirectories(
  filter: ProjectFilter,
  dir = filter.root,
  onDirectory?: (directory: string, target: DirectoryTarget) => void,
  mode: TraversalMode = "index",
): DirectoryListing[] {
  if (dir !== filter.root && !mayEnter(filter, dir, mode)) return [];

  const rootStat = fs.statSync(dir, { bigint: true });
  if (!rootStat.isDirectory()) {
    if (dir !== filter.root) return [];
    throw new Error(`not a directory: ${dir}`);
  }
  const rootTarget = { device: rootStat.dev, inode: rootStat.ino };
  const listings: DirectoryListing[] = [];
  const ancestors = new Set<string>();

  const visit = (current: string, target: DirectoryTarget): void => {
    const identity = `${target.device}:${target.inode}`;
    if (ancestors.has(identity)) return;
    ancestors.add(identity);
    try {
      onDirectory?.(current, target);
      const files: string[] = [];
      listings.push({ directory: current, files });

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
        const file = path.join(current, entry.name);
        let isDirectory = entry.isDirectory();
        const isFile = entry.isFile();
        let directoryStat: fs.BigIntStats | null = null;

        if (entry.isSymbolicLink()) {
          try {
            directoryStat = fs.statSync(file, { bigint: true });
            isDirectory = directoryStat.isDirectory();
          } catch (error) {
            if (isPathMissing(error)) continue;
            throw error;
          }
        }

        if (isDirectory && mayEnter(filter, file, mode)) {
          try {
            directoryStat ??= fs.statSync(file, { bigint: true });
            if (!directoryStat.isDirectory()) continue;
            visit(file, { device: directoryStat.dev, inode: directoryStat.ino });
          } catch (error) {
            if (isPathMissing(error)) continue;
            throw error;
          }
        } else if (isFile && filter.includesFile(file)) {
          files.push(file);
        }
      }
    } finally {
      ancestors.delete(identity);
    }
  };

  visit(dir, rootTarget);
  return listings;
}

function mayEnter(filter: ProjectFilter, directory: string, mode: TraversalMode): boolean {
  return mode === "index"
    ? filter.includesDirectory(directory)
    : filter.mayWatchDirectory(directory);
}
