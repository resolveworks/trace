import * as fs from "node:fs";
import * as path from "node:path";
import type { Stats } from "node:fs";
import ignore from "ignore";
import { byExtension } from "./languages.ts";

type Rules = ReturnType<typeof ignore>;

export const ENV_DIRS: ReadonlySet<string> = new Set(["node_modules", ".venv"]);

/** Shared source and .gitignore filter for the initial walk and Chokidar. */
export class ProjectFilter {
  readonly root: string;
  private readonly cache = new Map<string, Rules | null>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  includesFile(filePath: string): boolean {
    return this.isSupported(filePath) && !this.isIgnored(filePath, false);
  }

  includesDirectory(dirPath: string): boolean {
    return !this.isIgnored(dirPath, true);
  }

  isSupported(filePath: string): boolean {
    return byExtension.has(path.extname(filePath).toLowerCase());
  }

  readonly watcherIgnored = (filePath: string, stats?: Stats): boolean => {
    if (!stats) return false;
    // Chokidar passes lstat results: resolve symlinks to classify the target.
    if (stats.isSymbolicLink()) {
      try {
        stats = fs.statSync(filePath);
      } catch {
        return true; // dangling symlink: nothing to watch
      }
    }
    return stats.isDirectory() ? !this.includesDirectory(filePath) : !this.includesFile(filePath);
  };

  private isIgnored(filePath: string, isDirectory: boolean): boolean {
    const absolute = path.resolve(this.root, filePath);
    const relative = path.relative(this.root, absolute);
    if (relative === "") return false;
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) return true;

    const parts = relative.split(path.sep);
    // .git is tooling; physical .pnpm stores are reached through their logical
    // symlink paths instead, so packages are indexed and watched exactly once.
    if (parts.includes(".git") || parts.includes(".pnpm")) return true;
    if (parts.some((part) => ENV_DIRS.has(part))) return false;

    const active: { directory: string; rules: Rules }[] = [];
    let directory = this.root;
    this.addRules(directory, active);

    for (let index = 0; index < parts.length; index++) {
      const current = path.join(directory, parts[index]);
      const currentIsDirectory = index < parts.length - 1 || isDirectory;
      if (this.matches(current, currentIsDirectory, active)) return true;
      if (index < parts.length - 1) {
        directory = current;
        this.addRules(directory, active);
      }
    }
    return false;
  }

  private addRules(directory: string, active: { directory: string; rules: Rules }[]): void {
    let rules = this.cache.get(directory);
    if (rules === undefined) {
      const file = path.join(directory, ".gitignore");
      rules = fs.existsSync(file) ? ignore().add(fs.readFileSync(file, "utf-8")) : null;
      this.cache.set(directory, rules);
    }
    if (rules) active.push({ directory, rules });
  }

  private matches(
    filePath: string,
    isDirectory: boolean,
    active: { directory: string; rules: Rules }[],
  ): boolean {
    let ignored = false;
    for (const { directory, rules } of active) {
      let relative = path.relative(directory, filePath).replace(/\\/g, "/");
      if (isDirectory) relative += "/";
      const result = rules.test(relative);
      if (result.ignored || result.unignored) ignored = result.ignored;
    }
    return ignored;
  }
}
