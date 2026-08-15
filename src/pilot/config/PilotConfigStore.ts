import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { getPilotConfigFilePath, resolvePilotHome } from "../paths.js";
import { classifyConfigChanges, diffConfigSnapshots } from "./classifyChanges.js";
import { loadPilotConfig } from "./loadPilotConfig.js";
import {
  PilotConfigError,
  type PilotConfigDiagnostic,
  type PilotConfigLoadOptions,
  type PilotConfigReloadEvent,
  type PilotConfigSnapshot,
} from "./types.js";

export type PilotConfigListener = (event: PilotConfigReloadEvent) => void;

/**
 * 最后一次成功加载的配置事实（阶段四 T7.2）：坏快照被拒绝后，服务继续使用
 * 这一代配置（endpoint 与 key 永不跨代配对）。
 */
export type LastGoodFacts = {
  version: number;
  loadedAt: string;
};

/** ISO 时间戳化的 LastGoodFacts（来自快照的 Date）。 */
function lastGoodFactsOf(snapshot: { version: number; loadedAt: Date }): LastGoodFacts {
  return { version: snapshot.version, loadedAt: snapshot.loadedAt.toISOString() };
}

export type PilotConfigStore = {
  getSnapshot(): PilotConfigSnapshot;
  getDiagnostics(): PilotConfigDiagnostic[];
  reload(reason?: string): Promise<PilotConfigSnapshot>;
  subscribe(listener: PilotConfigListener): () => void;
  startWatching(options?: { debounceMs?: number }): () => void;
  /** 最后一次成功加载的配置事实；从未成功加载时为 undefined。 */
  getLastGoodFacts(): LastGoodFacts | undefined;
  /** 连续失败的 reload 次数（持续坏配置告警用）。 */
  getConsecutiveFailures(): number;
};

export async function createPilotConfigStore(options: PilotConfigLoadOptions = {}): Promise<PilotConfigStore> {
  return createPilotConfigStoreSync(options);
}

export function createPilotConfigStoreSync(options: PilotConfigLoadOptions = {}): PilotConfigStore {
  const initialSnapshot = loadPilotConfig(options);
  return new DefaultPilotConfigStore(initialSnapshot, options);
}

class DefaultPilotConfigStore implements PilotConfigStore {
  private currentSnapshot: PilotConfigSnapshot;
  private lastReloadDiagnostics: PilotConfigDiagnostic[] = [];
  private readonly listeners = new Set<PilotConfigListener>();
  private reloading: Promise<PilotConfigSnapshot> | undefined;
  private nextVersion: number;
  // 阶段四 T7.2：last-good-facts 显式化——坏快照保留上一代配置继续服务，
  // 每次失败都告警（持续坏配置周期告警，而非 dsh 的一次性告警）。
  private lastGoodFacts: LastGoodFacts | undefined;
  private consecutiveFailures = 0;

  constructor(
    initialSnapshot: PilotConfigSnapshot,
    private readonly options: PilotConfigLoadOptions,
  ) {
    this.currentSnapshot = initialSnapshot;
    this.nextVersion = initialSnapshot.version + 1;
    // 初始加载即视为一代 last-good。
    this.lastGoodFacts = lastGoodFactsOf(initialSnapshot);
  }

  getSnapshot(): PilotConfigSnapshot {
    return this.currentSnapshot;
  }

  getDiagnostics(): PilotConfigDiagnostic[] {
    return [...this.currentSnapshot.diagnostics, ...this.lastReloadDiagnostics];
  }

  getLastGoodFacts(): LastGoodFacts | undefined {
    return this.lastGoodFacts;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  async reload(_reason = "manual"): Promise<PilotConfigSnapshot> {
    if (this.reloading) {
      return this.reloading;
    }

    this.reloading = Promise.resolve()
      .then(() => {
        const previousSnapshot = this.currentSnapshot;
        const nextSnapshot = loadPilotConfig({
          ...this.options,
          version: this.nextVersion,
        });
        const changedPaths = diffConfigSnapshots(previousSnapshot, nextSnapshot);
        const changeClasses = classifyConfigChanges(changedPaths);

        this.currentSnapshot = nextSnapshot;
        this.nextVersion = nextSnapshot.version + 1;
        this.lastReloadDiagnostics = [];
        this.lastGoodFacts = lastGoodFactsOf(nextSnapshot);
        this.consecutiveFailures = 0;
        this.publish({
          previousSnapshot,
          nextSnapshot,
          changedPaths,
          changeClasses,
        });

        return nextSnapshot;
      })
      .catch((error: unknown) => {
        this.consecutiveFailures += 1;
        if (error instanceof PilotConfigError) {
          this.lastReloadDiagnostics = error.diagnostics;
        }
        // 周期告警：每次失败的 reload 都告警并点名沿用中的 last-good 代。
        console.warn(
          `[sati] config reload failed (${this.consecutiveFailures}x in a row); keeping last good config (version ${this.lastGoodFacts?.version ?? "none"} from ${this.lastGoodFacts?.loadedAt ?? "-"})`,
        );
        throw error;
      })
      .finally(() => {
        this.reloading = undefined;
      });

    return this.reloading;
  }

  subscribe(listener: PilotConfigListener): () => void {
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

  private publish(event: PilotConfigReloadEvent): void {
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
    const pilotHome = resolvePilotHome(env);
    return [getPilotConfigFilePath(pilotHome)];
  }
}
