import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { getPolitConfigFilePath, getPolitProjectConfigFilePath, resolvePolitHome } from "../paths.js";
import { classifyConfigChanges, diffConfigSnapshots } from "./classifyChanges.js";
import { loadPolitConfig } from "./loadPolitConfig.js";
import {
  PolitConfigError,
  type PolitConfigDiagnostic,
  type PolitConfigLoadOptions,
  type PolitConfigReloadEvent,
  type PolitConfigSnapshot,
} from "./types.js";

export type PolitConfigListener = (event: PolitConfigReloadEvent) => void;

export type PolitConfigStore = {
  getSnapshot(): PolitConfigSnapshot;
  getDiagnostics(): PolitConfigDiagnostic[];
  reload(reason?: string): Promise<PolitConfigSnapshot>;
  subscribe(listener: PolitConfigListener): () => void;
  startWatching(options?: { debounceMs?: number }): () => void;
};

export async function createPolitConfigStore(
  options: PolitConfigLoadOptions = {},
): Promise<PolitConfigStore> {
  const initialSnapshot = loadPolitConfig(options);
  return new DefaultPolitConfigStore(initialSnapshot, options);
}

class DefaultPolitConfigStore implements PolitConfigStore {
  private currentSnapshot: PolitConfigSnapshot;
  private lastReloadDiagnostics: PolitConfigDiagnostic[] = [];
  private readonly listeners = new Set<PolitConfigListener>();
  private reloading: Promise<PolitConfigSnapshot> | undefined;
  private nextVersion: number;

  constructor(
    initialSnapshot: PolitConfigSnapshot,
    private readonly options: PolitConfigLoadOptions,
  ) {
    this.currentSnapshot = initialSnapshot;
    this.nextVersion = initialSnapshot.version + 1;
  }

  getSnapshot(): PolitConfigSnapshot {
    return this.currentSnapshot;
  }

  getDiagnostics(): PolitConfigDiagnostic[] {
    return [...this.currentSnapshot.diagnostics, ...this.lastReloadDiagnostics];
  }

  async reload(_reason = "manual"): Promise<PolitConfigSnapshot> {
    if (this.reloading) {
      return this.reloading;
    }

    this.reloading = Promise.resolve()
      .then(() => {
        const previousSnapshot = this.currentSnapshot;
        const nextSnapshot = loadPolitConfig({
          ...this.options,
          version: this.nextVersion,
        });
        const changedPaths = diffConfigSnapshots(previousSnapshot, nextSnapshot);
        const changeClasses = classifyConfigChanges(changedPaths);

        this.currentSnapshot = nextSnapshot;
        this.nextVersion = nextSnapshot.version + 1;
        this.lastReloadDiagnostics = [];
        this.publish({
          previousSnapshot,
          nextSnapshot,
          changedPaths,
          changeClasses,
        });

        return nextSnapshot;
      })
      .catch((error: unknown) => {
        if (error instanceof PolitConfigError) {
          this.lastReloadDiagnostics = error.diagnostics;
        }
        throw error;
      })
      .finally(() => {
        this.reloading = undefined;
      });

    return this.reloading;
  }

  subscribe(listener: PolitConfigListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startWatching(options: { debounceMs?: number } = {}): () => void {
    const debounceMs = options.debounceMs ?? 250;
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;

    const scheduleReload = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void this.reload("watch").catch(() => {
          // Reload diagnostics are retained on the store; watchers must not crash the runtime.
        });
      }, debounceMs);
    };

    for (const path of this.getWatchedPaths()) {
      const watchedPath = existsSync(path) ? path : dirname(path);
      try {
        watchers.push(watch(watchedPath, scheduleReload));
      } catch {
        // Watcher support is best effort. Manual reload remains available.
      }
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    };
  }

  private publish(event: PolitConfigReloadEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers cannot block or break snapshot publication.
      }
    }
  }

  private getWatchedPaths(): string[] {
    const env = this.options.env ?? process.env;
    const politHome = resolvePolitHome(env);
    const paths = [getPolitConfigFilePath(politHome)];
    if (this.options.projectRoot) {
      paths.push(getPolitProjectConfigFilePath(this.options.projectRoot));
    }
    return paths;
  }
}
