import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import {
  configToYaml,
  getEdgeClawConfigPath,
  maskSecrets,
  readEdgeClawConfigFile,
  validateEdgeClawConfig,
} from './edgeclawConfig.js';
import { reloadEdgeClawConfig } from './edgeclawConfigReloader.js';

// Watches the unified ~/.edgeclaw/config.yaml for external edits (vim, Cursor, other IDEs)
// and triggers the same reload path the UI uses on save, so *any* edit takes effect live.
// When the UI itself writes the file it calls suppressNextWatchEvent() first to avoid a
// redundant second reload.

let watcher = null;
let debounceTimer = null;
let suppressCount = 0;
let lastSignature = '';
let onEventHandler = null;

function signatureForFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

export function suppressNextWatchEvent() {
  // A single logical write may produce several fs.watch events (truncate + write + rename).
  // Suppress for a short grace window rather than counting events.
  suppressCount += 1;
  setTimeout(() => {
    suppressCount = Math.max(0, suppressCount - 1);
  }, 1500);
}

async function handleChange(configPath) {
  if (suppressCount > 0) return;
  const signature = signatureForFile(configPath);
  if (signature === lastSignature) return;
  lastSignature = signature;

  let record;
  try {
    record = readEdgeClawConfigFile();
  } catch (error) {
    onEventHandler?.({
      source: 'watcher',
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

  const validation = validateEdgeClawConfig(record.config);
  const maskedConfig = maskSecrets(record.config);

  if (!validation.valid) {
    onEventHandler?.({
      source: 'watcher',
      path: record.configPath,
      raw: configToYaml(maskedConfig),
      validation: { valid: false, errors: validation.errors, warnings: validation.warnings },
      reload: null,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  let reloadResult = null;
  try {
    reloadResult = await reloadEdgeClawConfig(record.config);
  } catch (error) {
    onEventHandler?.({
      source: 'watcher',
      path: record.configPath,
      raw: configToYaml(maskedConfig),
      validation: { valid: true, errors: [], warnings: validation.warnings },
      reload: null,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  onEventHandler?.({
    source: 'watcher',
    path: record.configPath,
    raw: configToYaml(maskedConfig),
    validation: { valid: true, errors: [], warnings: validation.warnings },
    reload: reloadResult,
    timestamp: new Date().toISOString(),
  });
}

export async function startEdgeClawConfigWatcher({ onEvent } = {}) {
  stopEdgeClawConfigWatcher();
  onEventHandler = typeof onEvent === 'function' ? onEvent : null;

  const configPath = getEdgeClawConfigPath();
  const configDir = path.dirname(configPath);
  const configBase = path.basename(configPath);

  try {
    await fsPromises.mkdir(configDir, { recursive: true });
  } catch (error) {
    console.warn('[edgeclaw-config-watcher] failed to ensure config dir:', error?.message || error);
    return;
  }

  lastSignature = signatureForFile(configPath);

  try {
    watcher = fs.watch(configDir, { persistent: false }, (eventType, filename) => {
      if (filename && filename !== configBase) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      // Debounce so editors doing multi-step saves (e.g. write to temp + rename)
      // produce a single reload.
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void handleChange(configPath);
      }, 250);
    });
    watcher.on('error', (error) => {
      console.warn('[edgeclaw-config-watcher] watch error:', error?.message || error);
    });
    console.log(`[edgeclaw-config-watcher] watching ${configPath}`);
  } catch (error) {
    console.warn('[edgeclaw-config-watcher] failed to start:', error?.message || error);
  }
}

export function stopEdgeClawConfigWatcher() {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // noop
    }
    watcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
