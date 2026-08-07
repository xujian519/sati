/**
 * 品牌环境变量访问层（Brand Env Access Layer）。
 *
 * 职责：集中封装品牌环境变量（`SATI_*`）的读取。公共代码一律经本模块访问，
 * 禁止直接引用 `process.env.SATI_*` / `env.SATI_*`，品牌前缀只允许出现在本文件。
 *
 * 设计（对齐 PilotDeck 上游合并策略，见 docs/pilotdeck-merge-plan.md）：
 * - 品牌键（`SATI_X`）优先读取，用户现有配置不变，对外契约零迁移；
 * - 中性键（`ENV_KEY` 中声明的键名）兜底读取——上游 PilotDeck 代码中性化后
 *   （改读同名中性键）本层自动兼容，合并冲突收敛到本文件；
 * - `APP_HOME` 作为 `SATI_HOME` 的中性键，避开系统环境变量 `HOME`。
 *
 * 专利区环境变量（`SATI_KNOWLEDGE_*` / `SATI_RULES_DIR` 等）位于 Sati 独有模块
 * （src/knowledge、src/rule），不与上游共享，保持原样，不在本层收敛。
 */

export type EnvLike = Record<string, string | undefined>;

/** 中性键名：公共代码引用此表，不出现品牌前缀。 */
export const ENV_KEY = {
  /** Sati 数据主目录（品牌键 SATI_HOME，默认 ~/.sati）。 */
  HOME: "APP_HOME",
  /** sati.yaml 配置文件路径（SATI_CONFIG_PATH）。 */
  CONFIG_PATH: "CONFIG_PATH",
  /** Gateway 监听端口（SATI_GATEWAY_PORT）。 */
  GATEWAY_PORT: "GATEWAY_PORT",
  /** 全局 HTTP 代理（SATI_PROXY）。 */
  PROXY: "PROXY",
  /** 调试：转储模型请求（SATI_DUMP_REQUEST）。 */
  DUMP_REQUEST: "DUMP_REQUEST",
  /** MCP 工具调用超时毫秒（SATI_MCP_TOOL_TIMEOUT_MS）。 */
  MCP_TOOL_TIMEOUT_MS: "MCP_TOOL_TIMEOUT_MS",
  /** 托管指令目录（SATI_MANAGED_CONFIG）。 */
  MANAGED_CONFIG: "MANAGED_CONFIG",
  /** 内置 skills 目录覆盖（SATI_BUNDLED_SKILLS_DIR）。 */
  BUNDLED_SKILLS_DIR: "BUNDLED_SKILLS_DIR",
  /** 单次输出最大 token（SATI_MAX_OUTPUT_TOKENS）。 */
  MAX_OUTPUT_TOKENS: "MAX_OUTPUT_TOKENS",
  /** 浏览器动作超时毫秒（SATI_BROWSER_TIMEOUT_ACTION_MS）。 */
  BROWSER_TIMEOUT_ACTION_MS: "BROWSER_TIMEOUT_ACTION_MS",
  /** 浏览器动作超时毫秒（SATI_BROWSER_ACTION_TIMEOUT_MS，旧键）。 */
  BROWSER_ACTION_TIMEOUT_MS: "BROWSER_ACTION_TIMEOUT_MS",
  /** 浏览器导航超时毫秒（SATI_BROWSER_TIMEOUT_NAVIGATION_MS）。 */
  BROWSER_TIMEOUT_NAVIGATION_MS: "BROWSER_TIMEOUT_NAVIGATION_MS",
  /** 浏览器导航超时毫秒（SATI_BROWSER_NAVIGATION_TIMEOUT_MS，旧键）。 */
  BROWSER_NAVIGATION_TIMEOUT_MS: "BROWSER_NAVIGATION_TIMEOUT_MS",
  /** 浏览器代理服务器（SATI_BROWSER_PROXY_SERVER）。 */
  BROWSER_PROXY_SERVER: "BROWSER_PROXY_SERVER",
  /** 浏览器代理取自环境（SATI_BROWSER_PROXY_FROM_ENV）。 */
  BROWSER_PROXY_FROM_ENV: "BROWSER_PROXY_FROM_ENV",
  /** 浏览器代理绕过列表（SATI_BROWSER_PROXY_BYPASS）。 */
  BROWSER_PROXY_BYPASS: "BROWSER_PROXY_BYPASS",
  /** Git SHA（SATI_GIT_SHA，telemetry）。 */
  GIT_SHA: "GIT_SHA",
  /** 应用版本（SATI_VERSION，telemetry）。 */
  VERSION: "VERSION",
  /** 网关记忆诊断开关（SATI_MEMORY_DIAGNOSTICS）。 */
  MEMORY_DIAGNOSTICS: "MEMORY_DIAGNOSTICS",
} as const;

/** 品牌前缀：品牌键 = `${BRAND_PREFIX}${中性键}`，仅本文件允许出现。 */
const BRAND_PREFIX = "SATI_";

/**
 * 中性键 ≠ 品牌键去前缀的特例映射。
 * 目前唯一例外：`APP_HOME`（中性键）→ `SATI_HOME`（品牌键），
 * 中性键取 `APP_HOME` 以避开系统环境变量 `HOME`。
 */
const BRAND_KEY_OVERRIDES: Record<string, string> = {
  [ENV_KEY.HOME]: "SATI_HOME",
};

/**
 * 读取品牌环境变量：品牌键（如 `SATI_HOME`）优先，中性键（如 `APP_HOME`）兜底。
 * `env` 可为 undefined（如工具上下文未携带环境变量），此时返回 undefined。
 */
export function brandEnv(env: EnvLike | undefined, key: string): string | undefined {
  if (!env) return undefined;
  const brandKey = BRAND_KEY_OVERRIDES[key] ?? `${BRAND_PREFIX}${key}`;
  return env[brandKey] ?? env[key];
}
