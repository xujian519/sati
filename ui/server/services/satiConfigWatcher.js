import { logger } from "../utils/consoleLogger.js";
import { SERVER_TIMEOUTS } from "../utils/timeouts.js";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import {
  configToYaml,
  getSatiConfigPath,
  maskSecrets,
  rawYamlToMaskedString,
  readSatiConfigFile,
  validateSatiConfig,
} from "./satiConfig.js";
import { reloadSatiConfig } from "./satiConfigReloader.js";
import { resolveConfigWritePath } from "./satiConfigFileIo.js";

// Watches ~/.sati/sati.yaml for external edits (vim, Cursor, other IDEs)
// and triggers the same reload path the UI uses on save, so *any* edit takes
// effect live. When the UI itself writes the file it calls
// suppressNextWatchEvent() first to avoid a redundant second reload.

const watchers = [];
let debounceTimer = null;
let suppressCount = 0;
let lastSignature = "";
let onEventHandler = null;

function signatureForFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    // 文件尚不存在是常态（首次写盘前），签名记为 missing
    return "missing";
  }
}

export function suppressNextWatchEvent() {
  suppressCount += 1;
  setTimeout(() => {
    suppressCount = Math.max(0, suppressCount - 1);
  }, SERVER_TIMEOUTS.CONFIG_WATCH_SUPPRESS_WINDOW_MS);
}

async function handleChange(configPath) {
  if (suppressCount > 0) return;
  const signature = signatureForFile(configPath);
  if (signature === lastSignature) return;
  lastSignature = signature;

  let record;
  try {
    record = readSatiConfigFile();
  } catch (error) {
    onEventHandler?.({
      source: "watcher",
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
      validation: {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (record.parseError) {
    onEventHandler?.({
      source: "watcher",
      path: record.configPath,
      raw: record.raw,
      config: maskSecrets(record.config),
      configDisabled: true,
      parseError: record.parseError,
      validation: {
        valid: false,
        errors: [`Invalid YAML: ${record.parseError}`],
        warnings: [],
      },
      reload: null,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const validation = validateSatiConfig(record.config);
  // Mirror serializeConfigResponse: emit the masked disk YAML so the
  // UI's hot-reload sees full router/gateway/adapters/etc. segments
  // when the file changes from any source (UI save, vim, external tool).
  const hasDiskYaml = record.rawYaml && typeof record.rawYaml === "object" && Object.keys(record.rawYaml).length > 0;
  const maskedRaw = hasDiskYaml ? rawYamlToMaskedString(record.rawYaml) : configToYaml(maskSecrets(record.config));

  if (!validation.valid) {
    onEventHandler?.({
      source: "watcher",
      path: record.configPath,
      raw: maskedRaw,
      config: maskSecrets(record.config),
      validation: { valid: false, errors: validation.errors, warnings: validation.warnings },
      reload: null,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  let reloadResult = null;
  try {
    reloadResult = await reloadSatiConfig(record.config);
  } catch (error) {
    onEventHandler?.({
      source: "watcher",
      path: record.configPath,
      raw: maskedRaw,
      config: maskSecrets(record.config),
      validation: { valid: true, errors: [], warnings: validation.warnings },
      reload: null,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  onEventHandler?.({
    source: "watcher",
    path: record.configPath,
    raw: maskedRaw,
    config: maskSecrets(record.config),
    validation: { valid: true, errors: [], warnings: validation.warnings },
    reload: reloadResult,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 需要 watch 的 (目录, 文件名) 组合。
 *
 * 配置是软链时（`~/.sati/sati.yaml` → 别处的真实文件），写入走的是 `resolveConfigWritePath`
 * 解析出的目标，读事件也必须跟到目标所在目录——只盯软链所在目录的话，外部编辑器改目标
 * 文件不会产生任何事件，热重载静默失效（写路径支持软链、读路径不跟，读写不对称）。
 * 软链本身也要留一个（它可能被替换指向别处）。
 */
async function collectWatchTargets(configPath) {
  const targets = [configPath];
  try {
    const resolved = await resolveConfigWritePath(configPath);
    if (resolved !== path.resolve(configPath)) targets.push(resolved);
  } catch {
    // 软链解析失败（循环软链等）→ 只盯软链本身，退回原行为。
  }
  return targets;
}

function scheduleChange(configPath) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void handleChange(configPath);
  }, SERVER_TIMEOUTS.CONFIG_WATCH_DEBOUNCE_MS);
}

export async function startSatiConfigWatcher({ onEvent } = {}) {
  stopSatiConfigWatcher();
  onEventHandler = typeof onEvent === "function" ? onEvent : null;

  const configPath = getSatiConfigPath();
  lastSignature = signatureForFile(configPath);

  const seen = new Set();
  const watchedDirs = new Set();
  for (const target of await collectWatchTargets(configPath)) {
    const configDir = path.dirname(target);
    const configBase = path.basename(target);
    const key = `${configDir}\u0000${configBase}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      await fsPromises.mkdir(configDir, { recursive: true });
      const current = fs.watch(configDir, { persistent: false }, (_eventType, filename) => {
        if (filename && filename !== configBase) return;
        scheduleChange(configPath);
      });
      current.on("error", error => {
        logger.warn("[sati-config-watcher] watch error:", error?.message || error);
      });
      watchers.push(current);
      watchedDirs.add(configDir);
    } catch (error) {
      logger.warn(`[sati-config-watcher] failed to watch ${configDir}:`, error?.message || error);
    }
  }

  if (watchers.length > 0) {
    logger.info(`[sati-config-watcher] watching ${[...watchedDirs].join(", ")}`);
  }
}

export function stopSatiConfigWatcher() {
  for (const current of watchers.splice(0)) {
    try {
      current.close();
    } catch {
      // noop
    }
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
