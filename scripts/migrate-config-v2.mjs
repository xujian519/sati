#!/usr/bin/env node
/**
 * Migrate ~/.pilotdeck/pilotdeck.yaml to the V2 minimal format.
 *
 * What it does:
 *   1. Strips capabilities / multimodal / displayName from each model
 *      (the built-in catalog now supplies these automatically)
 *   2. Strips protocol / url if they match the catalog defaults
 *   3. Removes empty headers: {}
 *   4. Backs up the original file to pilotdeck.yaml.bak
 *
 * Usage:
 *   node scripts/migrate-config-v2.mjs
 *   node scripts/migrate-config-v2.mjs /path/to/pilotdeck.yaml
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";

const CATALOG_DEFAULTS = {
  anthropic:  { protocol: "anthropic", url: "https://api.anthropic.com" },
  openai:     { protocol: "openai",    url: "https://api.openai.com/v1" },
  deepseek:   { protocol: "openai",    url: "https://api.deepseek.com/v1" },
  google:     { protocol: "openai",    url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  openrouter: { protocol: "openai",    url: "https://openrouter.ai/api/v1" },
  yeysai:     { protocol: "openai",    url: "https://yeysai.com/v1" },
  minimax:    { protocol: "openai",    url: "https://api.minimaxi.com/v1" },
  moonshot:   { protocol: "openai",    url: "https://api.moonshot.cn/v1" },
};

const configPath = process.argv[2] || join(homedir(), ".pilotdeck", "pilotdeck.yaml");

if (!existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}

const raw = readFileSync(configPath, "utf8");
const config = parse(raw);

if (!config || typeof config !== "object") {
  console.error("Config is empty or not an object.");
  process.exit(1);
}

let changed = false;

if (config.model?.providers && typeof config.model.providers === "object") {
  for (const [providerId, provider] of Object.entries(config.model.providers)) {
    if (!provider || typeof provider !== "object") continue;

    const catalog = CATALOG_DEFAULTS[providerId];
    if (catalog) {
      if (provider.protocol === catalog.protocol) {
        delete provider.protocol;
        changed = true;
      }
      if (provider.url === catalog.url) {
        delete provider.url;
        changed = true;
      }
    }

    if (provider.headers && typeof provider.headers === "object" && Object.keys(provider.headers).length === 0) {
      delete provider.headers;
      changed = true;
    }

    if (provider.timeoutMs === 120000) {
      delete provider.timeoutMs;
      changed = true;
    }

    if (provider.models && typeof provider.models === "object") {
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (!model || typeof model !== "object") continue;

        for (const key of ["capabilities", "multimodal", "displayName"]) {
          if (key in model) {
            delete model[key];
            changed = true;
          }
        }

        if (Object.keys(model).length === 0) {
          provider.models[modelId] = null;
        }
      }
    }
  }
}

if (!config.schemaVersion) {
  config.schemaVersion = 1;
  changed = true;
}

if (!changed) {
  console.log("Config is already in V2 format. Nothing to do.");
  process.exit(0);
}

const backupPath = configPath + ".bak";
copyFileSync(configPath, backupPath);
console.log(`Backup saved to: ${backupPath}`);

const output =
  "# PilotDeck configuration — v2 minimal format\n" +
  "# Capabilities and multimodal are auto-filled from the built-in catalog.\n\n" +
  stringify(config, { indent: 2, lineWidth: 0, nullStr: "" });

writeFileSync(configPath, output, "utf8");
console.log(`Migrated: ${configPath}`);
console.log();

const lines = output.split("\n").length;
const oldLines = raw.split("\n").length;
console.log(`${oldLines} lines → ${lines} lines`);
