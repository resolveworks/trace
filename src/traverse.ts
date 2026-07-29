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
  realpath: string;
  device: bigint;
  inode: bigint;
}

/**
 * Walk the included directories under dir in deterministic readdir order,
 * following directory symlinks by their logical paths. Physical `.pnpm`
 * stores and `.git` are excluded by the filter; `node_modules` and `.venv`
 * are included despite `.gitignore`. A shared realpath set guards against
 * symlink cycles and duplicate physical targets: the first logical path to
 * reach a target wins.
 *
 * `onDirectory` fires for each included directory before its entries are
 * read, so watchers can be established on a parent before its children are
 * scanned and no entry created during the walk is missed.
 */
export function walkDirectories(
  filter: ProjectFilter,
  dir = filter.root,
  onDirectory?: (directory: string, target: DirectoryTarget) => void,
): DirectoryListing[] {
  const rootStat = fs.statSync(dir, { bigint: true });
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${dir}`);
  const rootTarget = {
    realpath: fs.realpathSync(dir),
    device: rootStat.dev,
    inode: rootStat.ino,
  };
  const listings: DirectoryListing[] = [];
  const visited = new Set<string>([rootTarget.realpath]);

  const visit = (current: string, target: DirectoryTarget): void => {
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

      if (isDirectory && filter.includesDirectory(file)) {
        try {
          directoryStat ??= fs.statSync(file, { bigint: true });
          if (!directoryStat.isDirectory()) continue;
          const realpath = fs.realpathSync(file);
          if (visited.has(realpath)) continue;
          visited.add(realpath);
          visit(file, {
            realpath,
            device: directoryStat.dev,
            inode: directoryStat.ino,
          });
        } catch (error) {
          if (isPathMissing(error)) continue;
          throw error;
        }
      } else if (isFile && filter.includesFile(file)) {
        files.push(file);
      }
    }
  };

  visit(dir, rootTarget);
  return listings;
}
