import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { isPathMissing } from "./fs-errors.ts";
import { byExtension } from "./languages.ts";

type Rules = ReturnType<typeof ignore>;

export const ENV_DIRS: ReadonlySet<string> = new Set(["node_modules", ".venv"]);
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([".git", ".pnpm", ".pnpm-store"]);

/** Central lexical path policy for reconciliation and queries. */
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

  isEnvironmentPath(filePath: string): boolean {
    return this.relativeParts(filePath)?.some((part) => ENV_DIRS.has(part)) ?? false;
  }

  isSupported(filePath: string): boolean {
    return byExtension.has(path.extname(filePath).toLowerCase());
  }

  /** Drop cached .gitignore rules before reconciling a query scope. */
  invalidate(): void {
    this.cache.clear();
  }

  private isIgnored(filePath: string, isDirectory: boolean): boolean {
    const parts = this.relativeParts(filePath);
    if (!parts) return true;
    if (parts.length === 0) return false;

    // Exclusions are based on the logical route and win inside environments.
    // A package physically stored under .pnpm remains accepted through a
    // logical node_modules/pkg symlink that contains no excluded segment.
    if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
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

  private relativeParts(filePath: string): string[] | null {
    const absolute = path.resolve(this.root, filePath);
    const relative = path.relative(this.root, absolute);
    if (relative === "") return [];
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
    return relative.split(path.sep);
  }

  private addRules(directory: string, active: { directory: string; rules: Rules }[]): void {
    let rules = this.cache.get(directory);
    if (rules === undefined) {
      try {
        const file = path.join(directory, ".gitignore");
        rules = fs.lstatSync(file).isFile() ? ignore().add(fs.readFileSync(file, "utf-8")) : null;
      } catch (error) {
        if (!isPathMissing(error)) throw error;
        rules = null;
      }
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
