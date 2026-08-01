/**
 * Lightweight ~/.sati/sati.yaml validator owned by the desktop shell.
 *
 * Supports two schema variants:
 *
 * NEW (schemaVersion: 1):
 *   model:
 *     providers:
 *       <providerName>:
 *         url: https://...
 *         apiKey: sk-xxx
 *   agent:
 *     model: <providerName>/<modelName>
 *
 * LEGACY (onboarding-generated):
 *   models:
 *     providers:
 *       <name>:
 *         baseUrl: https://...
 *         apiKey: sk-xxx
 *     entries:
 *       default:
 *         provider: <name>
 *         name: <modelName>
 *   agents:
 *     main:
 *       model: default
 */

import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";

export type ConfigValidationResult = { ok: true } | { ok: false; reason: string; missing: string[] };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 与服务器 satiConfig.js validateSatiConfig 保持一致：protocol 白名单。 */
const VALID_PROTOCOLS = new Set(["openai", "openai-responses", "anthropic", "google"]);

function validateNewSchema(parsed: Record<string, unknown>): ConfigValidationResult {
  const missing: string[] = [];

  const model = isRecord(parsed.model) ? parsed.model : {};
  const providers = isRecord(model.providers) ? model.providers : {};

  if (Object.keys(providers).length === 0) {
    missing.push("model.providers");
  }

  const agent = isRecord(parsed.agent) ? parsed.agent : {};
  const agentModel = nonEmptyString(agent.model) ? agent.model : "";

  if (!agentModel) {
    missing.push("agent.model");
  }

  if (agentModel && Object.keys(providers).length > 0) {
    const slashIdx = agentModel.indexOf("/");
    const providerName = slashIdx > 0 ? agentModel.slice(0, slashIdx) : agentModel;
    const provider = isRecord(providers[providerName]) ? providers[providerName] : null;

    if (!provider) {
      missing.push(`model.providers.${providerName}`);
    } else {
      // 与服务器对齐：protocol 必填且必须为白名单值。服务器端
      // （satiConfig.js validateProvider）先 toLowerCase 再校验，这里保持一致，
      // 否则 "OpenAI"/"ANTHROPIC" 等大小写配置会被桌面端误拒。
      if (!nonEmptyString(provider.protocol)) {
        missing.push(`model.providers.${providerName}.protocol`);
      } else if (!VALID_PROTOCOLS.has(String(provider.protocol).toLowerCase())) {
        missing.push(`model.providers.${providerName}.protocol（非法值 "${provider.protocol}"）`);
      }
      if (!nonEmptyString(provider.url)) {
        missing.push(`model.providers.${providerName}.url`);
      }
      // 与服务器对齐：ollama 豁免 apiKey（allowsMissingApiKey）
      if (!nonEmptyString(provider.apiKey) && providerName !== "ollama") {
        missing.push(`model.providers.${providerName}.apiKey`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `配置文件缺少以下字段：${missing.join(", ")}`,
      missing,
    };
  }
  return { ok: true };
}

/** 旧版 models/agents 复数格式：服务器已不再支持（'no more adapter layer'），一律判为无效并引导迁移。 */
function validateLegacySchema(): ConfigValidationResult {
  return {
    ok: false,
    reason:
      "检测到旧版 models/agents 配置格式，服务器已不再支持。请使用 schemaVersion:1 的新格式（model/providers/agent）。",
    missing: ["model", "agent"],
  };
}

export function validateSatiConfigFile(configPath: string): ConfigValidationResult {
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      reason: `配置文件不存在：${configPath}`,
      missing: ["sati.yaml"],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    return {
      ok: false,
      reason: `无法读取配置文件：${e instanceof Error ? e.message : String(e)}`,
      missing: ["sati.yaml"],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return {
      ok: false,
      reason: `配置文件 YAML 解析失败：${e instanceof Error ? e.message : String(e)}`,
      missing: ["sati.yaml"],
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "配置文件内容不是合法的 YAML 对象",
      missing: ["model", "agent"],
    };
  }

  // Detect schema variant: new uses `model` (singular), legacy uses `models` (plural)
  if (isRecord(parsed.model) || isRecord(parsed.agent)) {
    return validateNewSchema(parsed);
  }
  if (isRecord(parsed.models) || isRecord(parsed.agents)) {
    return validateLegacySchema();
  }

  return {
    ok: false,
    reason: "配置文件缺少 model/agent 或 models/agents 段",
    missing: ["model", "agent"],
  };
}
