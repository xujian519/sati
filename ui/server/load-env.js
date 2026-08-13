import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { applyConfigToProcessEnv, getSatiConfigPath, readSatiConfigFile } from "./services/satiConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "../..");

// EDGECLAW_API_BASE_URL / EDGECLAW_API_KEY / EDGECLAW_MODEL used to be
// required here, but no code in ui/ actually consumes those variables —
// chat execution goes through sati-bridge.js → src/gateway, which
// reads ~/.sati/sati.yaml directly. The sanity check has been
// retired; ui/server boots even when the config file is missing.

/**
 * legacy(pre-rebrand): 兼容 PilotDeck 旧环境变量，升级用户数据迁移用。
 * Pre-rebrand env compatibility: map explicit PILOTDECK_* / PILOT_HOME
 * settings onto their SATI_* counterparts when the new names are not set.
 * Without this, upgrading users silently lose their config path, home
 * directory and port; an explicit `PILOTDECK_DISABLE_LOCAL_AUTH=0` (login
 * required) would also be ignored, silently reopening a protected UI.
 */
function applyLegacyEnvCompat() {
  const legacyToModern = {
    PILOTDECK_CONFIG_PATH: "SATI_CONFIG_PATH",
    PILOTDECK_DISABLE_LOCAL_AUTH: "SATI_DISABLE_LOCAL_AUTH",
    PILOTDECK_PORT: "SATI_PORT",
    // 重命名前文档声明过这两个变量（README_SOURCE_INSTALL 旧版）；升级用户的
    // shell 里残留的端口钉扎若不映射，网关会回落到默认端口，外部集成
    // （webhook 回调、防火墙规则）静默失效。
    PILOTDECK_GATEWAY_PORT: "SATI_GATEWAY_PORT",
    PILOTDECK_GATEWAY_URL: "SATI_GATEWAY_URL",
    PILOT_HOME: "SATI_HOME",
  };
  for (const [legacy, modern] of Object.entries(legacyToModern)) {
    if (process.env[legacy] && process.env[modern] === undefined) {
      process.env[modern] = process.env[legacy];
      console.warn(`[COMPAT] Legacy env var ${legacy} mapped to ${modern}`);
    }
  }
}

function applyDerivedRuntimeEnv() {
  const { config, rawYaml } = readSatiConfigFile();
  // Pass the raw (pre-normalization) YAML so runtime env overrides only
  // apply to values the config explicitly declares (e.g. DATABASE_PATH),
  // leaving CLI/env-provided values untouched.
  applyConfigToProcessEnv(config, rawYaml);
}

export function getRepoRootDir() {
  return REPO_ROOT;
}

export function getSatiConfigFilePath() {
  return getSatiConfigPath();
}

export function hasSatiConfigFile() {
  return fs.existsSync(getSatiConfigPath());
}

// Stub for the deprecated boot-time sanity check. Kept as a named export
// so existing callers (e.g. ui/server/index.js) don't need a coordinated
// removal; the function is now a no-op that returns the empty list of
// missing keys.
export function assertRequiredSatiEnv() {
  return [];
}

export function loadRootSatiEnv() {
  applyLegacyEnvCompat();
  applyDerivedRuntimeEnv();

  if (!process.env.DATABASE_PATH) {
    process.env.DATABASE_PATH = path.join(process.env.SATI_HOME || path.join(os.homedir(), ".sati"), "auth.db");
  }

  return hasSatiConfigFile();
}

loadRootSatiEnv();
