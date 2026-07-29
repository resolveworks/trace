import * as fs from "node:fs";
import * as path from "node:path";
import { isPathMissing } from "./fs-errors.ts";
import type { ProjectFilter } from "./project-filter.ts";
import { walkDirectories, type DirectoryTarget } from "./traverse.ts";

/** Collapse editor save bursts and rename pairs into one path reconciliation. */
const FILE_EVENT_DELAY_MS = 50;

export interface DirectoryWatcherCallbacks {
  onFileChanged(file: string): void;
  onFileRemoved(file: string): void;
  onStructural(reason: string): void;
}

interface WatchedDirectory extends DirectoryTarget {
  watcher: fs.FSWatcher;
}

/** One non-recursive fs.watch per included first-party logical directory. */
export class DirectoryWatcher {
  private readonly filter: ProjectFilter;
  private readonly callbacks: DirectoryWatcherCallbacks;
  private watchers = new Map<string, WatchedDirectory>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly invalidated = new Set<string>();
  private closed = false;

  constructor(filter: ProjectFilter, callbacks: DirectoryWatcherCallbacks) {
    this.filter = filter;
    this.callbacks = callbacks;
  }

  /**
   * Reconcile the watch topology atomically. Existing watches are reused;
   * newly opened watches are discarded if the walk cannot complete.
   */
  refresh(): void {
    if (this.closed) throw new Error(`watcher is closed: ${this.filter.root}`);

    const next = new Map<string, WatchedDirectory>();
    const created: fs.FSWatcher[] = [];
    try {
      walkDirectories(
        this.filter,
        this.filter.root,
        (directory, target) => {
          const existing = this.watchers.get(directory);
          if (
            !this.invalidated.has(directory) &&
            existing?.device === target.device &&
            existing.inode === target.inode
          ) {
            next.set(directory, existing);
            return;
          }
          const watcher = this.watchDirectory(directory);
          created.push(watcher);
          next.set(directory, { ...target, watcher });
        },
        "watch",
      );
    } catch (error) {
      for (const watcher of created) watcher.close();
      throw error;
    }

    for (const [directory, watched] of this.watchers) {
      if (next.get(directory)?.watcher !== watched.watcher) watched.watcher.close();
    }
    this.watchers = next;
    this.invalidated.clear();
  }

  watchedDirectories(): number {
    return this.watchers.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.invalidated.clear();
    for (const watched of this.watchers.values()) watched.watcher.close();
    this.watchers.clear();
  }

  private watchDirectory(directory: string): fs.FSWatcher {
    return fs.watch(directory, (_eventType, filename) => this.onEvent(directory, filename));
  }

  private onEvent(directory: string, filename: string | null): void {
    if (this.closed) return;
    if (filename === null) {
      this.callbacks.onStructural(`fs.watch event without a filename in ${directory}`);
      return;
    }

    const target = path.join(directory, filename);
    const existing = this.pending.get(target);
    if (existing) clearTimeout(existing);
    this.pending.set(
      target,
      setTimeout(() => {
        this.pending.delete(target);
        this.reconcilePath(target);
      }, FILE_EVENT_DELAY_MS),
    );
  }

  /** Classify an event by the current state of the path, not its event type. */
  private reconcilePath(target: string): void {
    if (this.closed) return;

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (!isPathMissing(error)) throw error;
      this.reconcileAbsent(target);
      return;
    }

    if (path.basename(target) === ".gitignore") {
      this.filter.invalidate();
      this.callbacks.onStructural(".gitignore changed");
      return;
    }

    if (stat.isSymbolicLink()) {
      try {
        stat = fs.statSync(target);
      } catch (error) {
        if (!isPathMissing(error)) throw error;
        this.reconcileAbsent(target);
        return;
      }
      if (!stat.isDirectory()) {
        if (this.watchers.has(target)) {
          this.invalidate(target, `watched directory replaced: ${target}`);
        } else if (this.filter.isSupported(target)) {
          this.callbacks.onFileRemoved(target);
        }
        return;
      }
    }

    if (stat.isDirectory()) {
      if (this.filter.includesDirectory(target)) {
        this.invalidate(target, `directory appeared: ${target}`);
      }
      return;
    }
    if (this.watchers.has(target)) {
      this.invalidate(target, `watched directory replaced: ${target}`);
      return;
    }
    if (!stat.isFile() || !this.filter.isSupported(target)) return;
    if (this.filter.includesFile(target)) {
      this.callbacks.onFileChanged(target);
    } else {
      this.callbacks.onFileRemoved(target);
    }
  }

  private invalidate(directory: string, reason: string): void {
    this.invalidated.add(directory);
    this.callbacks.onStructural(reason);
  }

  private reconcileAbsent(target: string): void {
    if (path.basename(target) === ".gitignore") {
      this.filter.invalidate();
      this.callbacks.onStructural(".gitignore deleted");
      return;
    }
    if (this.watchers.has(target)) {
      this.invalidate(target, `watched directory removed: ${target}`);
    } else if (this.filter.isSupported(target)) {
      this.callbacks.onFileRemoved(target);
    }
  }
}
