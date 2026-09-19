import { isRecord } from "../../model/config/schema.js";
import type {
  PilotConfigDiagnostic,
  PilotPaperSearchConfig,
  PilotToolGroupConfig,
  PilotToolsConfig,
  PilotWebSearchConfig,
  PilotWebSearchCustomAuth,
  PilotWebSearchCustomMethod,
  PilotWebSearchProvider,
} from "./types.js";

/**
 * Parse the optional `tools` section of `sati.yaml`.
 *
 *   tools:
 *     webSearch:
 *       enabled: true
 *       provider: glm                    # glm | tavily | custom
 *       apiKey: "..."
 *       endpoint: https://api.z.ai/api/paas/v4/web_search
 *     visibleDomains: [filesystem, shell] # 只保留这些域的工具（省略 = 不限）
 *     hiddenDomains: [patent]             # 隐藏这些域（优先于 visibleDomains）
 *     patentDomain: true                  # patent 域显式开关（缺省 = 按工作区自动判据）
 *     documentStyle: { enabled: false }   # 内置工具组，段缺失 = 保持注册
 *     kanban: { enabled: false }
 *     team: { enabled: false }
 *
 * Unknown fields produce non-fatal warnings so future additions don't break
 * older deployments. Returns `undefined` when no webSearch / paperSearch block
 * exists. Preserve a present but empty block: legacy configs use it to opt into
 * search with credentials supplied by the environment（上游 #588）。
 */
export function parseToolsConfig(
  rawTools: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotToolsConfig | undefined {
  if (rawTools === undefined) {
    return undefined;
  }
  if (!isRecord(rawTools)) {
    diagnostics.push({
      code: "TOOLS_CONFIG_INVALID",
      severity: "fatal",
      message: "tools config must be an object.",
      path: "tools",
      recoverable: false,
    });
    return undefined;
  }

  const webSearch = parseWebSearch(rawTools.webSearch, diagnostics);
  const paperSearch = parsePaperSearch(rawTools.paperSearch, diagnostics);
  const visibleDomains = parseDomainList(
    rawTools.visibleDomains,
    "tools.visibleDomains",
    "TOOLS_VISIBLE_DOMAINS_INVALID",
    diagnostics,
  );
  const hiddenDomains = parseDomainList(
    rawTools.hiddenDomains,
    "tools.hiddenDomains",
    "TOOLS_HIDDEN_DOMAINS_INVALID",
    diagnostics,
  );
  const patentDomain = parseBooleanField(
    rawTools.patentDomain,
    "tools.patentDomain",
    "TOOLS_PATENT_DOMAIN_INVALID",
    diagnostics,
  );
  const documentStyle = parseToolGroup(
    rawTools.documentStyle,
    "tools.documentStyle",
    "TOOLS_DOCUMENT_STYLE_INVALID",
    diagnostics,
  );
  const kanban = parseToolGroup(rawTools.kanban, "tools.kanban", "TOOLS_KANBAN_INVALID", diagnostics);
  const team = parseToolGroup(rawTools.team, "tools.team", "TOOLS_TEAM_INVALID", diagnostics);

  for (const key of Object.keys(rawTools)) {
    if (!TOOLS_KNOWN_FIELDS.includes(key as (typeof TOOLS_KNOWN_FIELDS)[number])) {
      diagnostics.push({
        code: "TOOLS_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools config field ${key}.`,
        path: `tools.${key}`,
        recoverable: true,
      });
    }
  }

  const result: PilotToolsConfig = {};
  if (webSearch) result.webSearch = webSearch;
  if (paperSearch) result.paperSearch = paperSearch;
  if (visibleDomains) result.visibleDomains = visibleDomains;
  if (hiddenDomains) result.hiddenDomains = hiddenDomains;
  if (patentDomain !== undefined) result.patentDomain = patentDomain;
  if (documentStyle) result.documentStyle = documentStyle;
  if (kanban) result.kanban = kanban;
  if (team) result.team = team;
  return Object.keys(result).length > 0 ? result : undefined;
}

const TOOLS_KNOWN_FIELDS = [
  "webSearch",
  "paperSearch",
  "visibleDomains",
  "hiddenDomains",
  "patentDomain",
  "documentStyle",
  "kanban",
  "team",
] as const;

/**
 * 域清单解析（`tools.visibleDomains` / `tools.hiddenDomains`）。
 * 空数组等同未配置（不裁剪），非字符串元素按 fatal 处理并整项丢弃。
 */
function parseDomainList(
  raw: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({
      code,
      severity: "fatal",
      message: `${path} must be an array of domain names.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      diagnostics.push({
        code,
        severity: "fatal",
        message: `${path} entries must be non-empty strings.`,
        path,
        recoverable: false,
      });
      return undefined;
    }
    values.push(entry.trim());
  }
  return values.length > 0 ? values : undefined;
}

/**
 * 内置工具组开关解析。段在场即保留（空块 = 默认开），只有显式 `enabled: false`
 * 表达关闭——与 `isBuiltinToolGroupEnabled` 的判据配套。
 */
function parseToolGroup(
  raw: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): PilotToolGroupConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({
      code,
      severity: "fatal",
      message: `${path} must be an object.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  const result: PilotToolGroupConfig = {};
  const enabled = parseEnabledFlag(raw, `${code}_ENABLED`, `${path}.enabled`, diagnostics);
  if (enabled !== undefined) result.enabled = enabled;
  for (const key of Object.keys(raw)) {
    if (key !== "enabled") {
      diagnostics.push({
        code: `${code}_UNKNOWN_FIELD`,
        severity: "warning",
        message: `Unknown ${path} field ${key}.`,
        path: `${path}.${key}`,
        recoverable: true,
      });
    }
  }
  return result;
}

/**
 * 三态布尔字段解析（缺省 = 未声明，与 `false` 严格区分）。
 * `tools.patentDomain` 用它：`undefined` 表示"交给工作区判据"，不是"关"。
 */
function parseBooleanField(
  raw: unknown,
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    diagnostics.push({
      code,
      severity: "fatal",
      message: `${path} must be a boolean.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  return raw;
}

/** Shared `enabled` boolean parser; emits a fatal diagnostic on non-boolean values. */
function parseEnabledFlag(
  raw: Record<string, unknown>,
  code: string,
  fieldPath: string,
  diagnostics: PilotConfigDiagnostic[],
): boolean | undefined {
  const value = raw.enabled;
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    diagnostics.push({
      code,
      severity: "fatal",
      message: `${fieldPath} must be a boolean.`,
      path: fieldPath,
      recoverable: false,
    });
    return undefined;
  }
  return value;
}

function parseWebSearch(raw: unknown, diagnostics: PilotConfigDiagnostic[]): PilotWebSearchConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_INVALID",
      severity: "fatal",
      message: "tools.webSearch must be an object.",
      path: "tools.webSearch",
      recoverable: false,
    });
    return undefined;
  }

  const result: PilotWebSearchConfig = {};

  const enabled = parseEnabledFlag(raw, "TOOLS_WEB_SEARCH_ENABLED_INVALID", "tools.webSearch.enabled", diagnostics);
  if (enabled !== undefined) result.enabled = enabled;

  if (raw.provider !== undefined) {
    if (raw.provider !== "glm" && raw.provider !== "tavily" && raw.provider !== "custom") {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_PROVIDER_INVALID",
        severity: "fatal",
        message: 'tools.webSearch.provider must be "glm", "tavily", or "custom".',
        path: "tools.webSearch.provider",
        recoverable: false,
      });
    } else {
      result.provider = raw.provider as PilotWebSearchProvider;
    }
  }

  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== "string" || raw.apiKey.trim().length === 0) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_API_KEY_INVALID",
        severity: "fatal",
        message: "tools.webSearch.apiKey must be a non-empty string.",
        path: "tools.webSearch.apiKey",
        recoverable: false,
      });
    } else {
      result.apiKey = raw.apiKey.trim();
    }
  }

  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint !== "string" || raw.endpoint.trim().length === 0) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_ENDPOINT_INVALID",
        severity: "fatal",
        message: "tools.webSearch.endpoint must be a non-empty URL string.",
        path: "tools.webSearch.endpoint",
        recoverable: false,
      });
    } else {
      result.endpoint = raw.endpoint.trim();
    }
  }

  const customProvider = parseCustomProvider(raw.customProvider, diagnostics);
  if (customProvider) {
    result.customProvider = customProvider;
  }

  // Soft-deprecate removed legacy fields. Emit warnings + ignore so existing
  // yamls don't break during migration to provider/apiKey/endpoint.
  if (raw.region !== undefined) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_REGION_DEPRECATED",
      severity: "warning",
      message: "tools.webSearch.region has been removed. Select tools.webSearch.provider instead.",
      path: "tools.webSearch.region",
      recoverable: true,
    });
  }
  if (raw.tavilyApiKey !== undefined) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_TAVILY_KEY_DEPRECATED",
      severity: "warning",
      message:
        "tools.webSearch.tavilyApiKey has been removed. Set tools.webSearch.provider: tavily and use tools.webSearch.apiKey.",
      path: "tools.webSearch.tavilyApiKey",
      recoverable: true,
    });
  }

  for (const key of Object.keys(raw)) {
    if (
      key !== "enabled" &&
      key !== "provider" &&
      key !== "apiKey" &&
      key !== "endpoint" &&
      key !== "customProvider" &&
      key !== "region" &&
      key !== "tavilyApiKey"
    ) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.webSearch field ${key}.`,
        path: `tools.webSearch.${key}`,
        recoverable: true,
      });
    }
  }

  // Presence is meaningful even if every legacy/unknown field was discarded
  // （上游 #588）：空块 = 遗留 opt-in，丢掉它就等于静默关掉这个功能。
  return result;
}

function parseCustomProvider(
  raw: unknown,
  diagnostics: PilotConfigDiagnostic[],
): NonNullable<PilotWebSearchConfig["customProvider"]> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_CUSTOM_PROVIDER_INVALID",
      severity: "fatal",
      message: "tools.webSearch.customProvider must be an object.",
      path: "tools.webSearch.customProvider",
      recoverable: false,
    });
    return undefined;
  }

  const result: NonNullable<PilotWebSearchConfig["customProvider"]> = {};
  const auth = parseEnumField<PilotWebSearchCustomAuth>(
    raw.auth,
    ["bearer", "bodyApiKey", "queryApiKey", "none"],
    "tools.webSearch.customProvider.auth",
    "TOOLS_WEB_SEARCH_CUSTOM_AUTH_INVALID",
    diagnostics,
  );
  if (auth) result.auth = auth;

  const method = parseEnumField<PilotWebSearchCustomMethod>(
    raw.method,
    ["GET", "POST"],
    "tools.webSearch.customProvider.method",
    "TOOLS_WEB_SEARCH_CUSTOM_METHOD_INVALID",
    diagnostics,
  );
  if (method) result.method = method;

  for (const field of [
    "name",
    "queryParam",
    "apiKeyParam",
    "resultsPath",
    "titleField",
    "urlField",
    "snippetField",
    "sourceField",
    "publishedAtField",
  ] as const) {
    const parsed = parseOptionalStringField(raw[field], `tools.webSearch.customProvider.${field}`, diagnostics);
    if (parsed !== undefined) {
      result[field] = parsed;
    }
  }

  for (const key of Object.keys(raw)) {
    if (
      key !== "auth" &&
      key !== "name" &&
      key !== "method" &&
      key !== "queryParam" &&
      key !== "apiKeyParam" &&
      key !== "resultsPath" &&
      key !== "titleField" &&
      key !== "urlField" &&
      key !== "snippetField" &&
      key !== "sourceField" &&
      key !== "publishedAtField"
    ) {
      diagnostics.push({
        code: "TOOLS_WEB_SEARCH_CUSTOM_PROVIDER_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.webSearch.customProvider field ${key}.`,
        path: `tools.webSearch.customProvider.${key}`,
        recoverable: true,
      });
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseEnumField<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  path: string,
  code: string,
  diagnostics: PilotConfigDiagnostic[],
): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    diagnostics.push({
      code,
      severity: "fatal",
      message: `${path} must be one of: ${allowed.join(", ")}.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  return raw as T;
}

function parseOptionalStringField(
  raw: unknown,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    diagnostics.push({
      code: "TOOLS_WEB_SEARCH_CUSTOM_STRING_INVALID",
      severity: "fatal",
      message: `${path} must be a non-empty string.`,
      path,
      recoverable: false,
    });
    return undefined;
  }
  return raw.trim();
}

const PAPER_SEARCH_KNOWN_FIELDS = [
  "enabled",
  "arxiv",
  "openalex",
  "semanticScholar",
  "crossref",
  "openalexMailto",
  "semanticScholarApiKey",
] as const;
const PAPER_SEARCH_BOOLEAN_FIELDS = ["arxiv", "openalex", "semanticScholar", "crossref"] as const;

function parsePaperSearch(raw: unknown, diagnostics: PilotConfigDiagnostic[]): PilotPaperSearchConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "TOOLS_PAPER_SEARCH_INVALID",
      severity: "fatal",
      message: "tools.paperSearch must be an object.",
      path: "tools.paperSearch",
      recoverable: false,
    });
    return undefined;
  }

  const result: PilotPaperSearchConfig = {};

  const enabled = parseEnabledFlag(raw, "TOOLS_PAPER_SEARCH_ENABLED_INVALID", "tools.paperSearch.enabled", diagnostics);
  if (enabled !== undefined) result.enabled = enabled;

  for (const key of PAPER_SEARCH_BOOLEAN_FIELDS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      diagnostics.push({
        code: "TOOLS_PAPER_SEARCH_CONNECTOR_INVALID",
        severity: "fatal",
        message: `tools.paperSearch.${key} must be a boolean.`,
        path: `tools.paperSearch.${key}`,
        recoverable: false,
      });
    } else {
      result[key] = value;
    }
  }

  if (raw.openalexMailto !== undefined) {
    if (typeof raw.openalexMailto !== "string" || raw.openalexMailto.trim().length === 0) {
      diagnostics.push({
        code: "TOOLS_PAPER_SEARCH_MAILTO_INVALID",
        severity: "fatal",
        message: "tools.paperSearch.openalexMailto must be a non-empty string.",
        path: "tools.paperSearch.openalexMailto",
        recoverable: false,
      });
    } else {
      result.openalexMailto = raw.openalexMailto.trim();
    }
  }

  if (raw.semanticScholarApiKey !== undefined) {
    if (typeof raw.semanticScholarApiKey !== "string" || raw.semanticScholarApiKey.trim().length === 0) {
      diagnostics.push({
        code: "TOOLS_PAPER_SEARCH_S2_KEY_INVALID",
        severity: "fatal",
        message: "tools.paperSearch.semanticScholarApiKey must be a non-empty string.",
        path: "tools.paperSearch.semanticScholarApiKey",
        recoverable: false,
      });
    } else {
      result.semanticScholarApiKey = raw.semanticScholarApiKey.trim();
    }
  }

  for (const key of Object.keys(raw)) {
    if (!PAPER_SEARCH_KNOWN_FIELDS.includes(key as (typeof PAPER_SEARCH_KNOWN_FIELDS)[number])) {
      diagnostics.push({
        code: "TOOLS_PAPER_SEARCH_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown tools.paperSearch field ${key}.`,
        path: `tools.paperSearch.${key}`,
        recoverable: true,
      });
    }
  }

  // Presence is meaningful even if every field was discarded（上游 #588 语义外延到 paperSearch）。
  return result;
}
