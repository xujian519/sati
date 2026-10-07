import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.SATI_CONFIG_PATH;
  delete process.env.SATI_HOME;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function configYaml(marker) {
  return `schemaVersion: 1\ncustomEnv:\n  WATCHER_MARKER: ${marker}\n`;
}

/**
 * fs.watch 的投递时机由 OS 调度，并发跑测试时首次写入可能落在 debounce 之外。
 * 轮询重写（每次 mtime 变化都会再产生一次事件）而不是写一次就死等，避免留下 flaky 用例。
 */
async function writeUntilObserved(writeTarget, events) {
  await vi.waitFor(
    () => {
      writeFileSync(writeTarget, configYaml("after"), "utf8");
      expect(events.some(event => String(event.raw ?? "").includes("after"))).toBe(true);
    },
    { timeout: 10000, interval: 250 },
  );
}

/** 软链配置：软链与它指向的真实文件刻意放在不同目录。 */
function useSymlinkedConfig() {
  const dir = mkdtempSync(join(tmpdir(), "sati-watcher-"));
  tempDirs.push(dir);
  const targetDir = join(dir, "store");
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, "real-config.yaml");
  writeFileSync(targetPath, configYaml("before"), "utf8");
  const configPath = join(dir, "sati.yaml");
  symlinkSync(targetPath, configPath);
  process.env.SATI_CONFIG_PATH = configPath;
  return { configPath, targetPath };
}

async function startWatcher() {
  const events = [];
  vi.doMock("./satiConfigReloader.js", () => ({
    reloadSatiConfig: vi.fn(async () => ({ reloaded: true })),
  }));
  const { startSatiConfigWatcher, stopSatiConfigWatcher } = await import("./satiConfigWatcher.js");
  await startSatiConfigWatcher({ onEvent: event => events.push(event) });
  return { events, stopSatiConfigWatcher };
}

describe("satiConfigWatcher", () => {
  it("notices an external edit to the symlink target, not just the symlink dir", async () => {
    const { targetPath } = useSymlinkedConfig();
    const { events, stopSatiConfigWatcher } = await startWatcher();

    try {
      // 外部编辑器改的是目标文件——只 watch 软链所在目录时这里不会产生任何事件。
      await writeUntilObserved(targetPath, events);
    } finally {
      stopSatiConfigWatcher();
    }
  });

  it("still notices an external edit when the config is not a symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-watcher-plain-"));
    tempDirs.push(dir);
    const configPath = join(dir, "sati.yaml");
    writeFileSync(configPath, configYaml("before"), "utf8");
    process.env.SATI_CONFIG_PATH = configPath;
    const { events, stopSatiConfigWatcher } = await startWatcher();

    try {
      await writeUntilObserved(configPath, events);
    } finally {
      stopSatiConfigWatcher();
    }
  });
});
