import type { CanonicalContentBlock, ModelRuntime } from "../../model/index.js";
import { createLogger } from "../../telemetry/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";

const logger = createLogger("session-title");

export const SESSION_TITLE_MAX_INPUT_CHARS = 1200;
export const SESSION_TITLE_MAX_OUTPUT_CHARS = 80;
export const SESSION_TITLE_TIMEOUT_MS = 30_000;

const SESSION_TITLE_SYSTEM_PROMPT_BASE = `Generate a concise title (3-7 words for Latin-script languages, 3-10 characters for CJK) that captures the main topic or goal of this session. The title should be clear enough that the user recognizes the session in a list. For Latin-script languages, use sentence case: capitalize only the first word and proper nouns.

Language requirement (highest priority): write the title in the same natural language as the user's input. Do not translate the input into a different language. If the input mixes languages, use the language of the user's main request, keeping product names and code identifiers unchanged. If the user's language cannot be determined, use the fallback language specified below.

Return JSON with a single "title" field.

Good examples (each title follows its input's language):
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "修复移动端登录按钮"}
{"title": "添加 OAuth 认证"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}
Bad (wrong language): {"title": "Fix mobile login button"} for the French input "Réparer le bouton de connexion mobile"

Do not output Markdown, code fences, explanations, analysis, thinking text, <think> tags, or extra fields.`;

/** CJK 统一表意文字（含中文/日文/韩文汉字），用于推断兜底语言（非 prompt 选择）。 */
const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

export function hasCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

/** 兜底语言（无法判断用户语言时使用）解析为 prompt 可读的说明行。 */
function resolveFallbackLanguageLine(systemLanguage: string | undefined, text: string): string {
  const effective = systemLanguage?.trim().toLowerCase();
  const useChinese = effective ? effective.startsWith("zh") || effective === "chinese" : hasCjk(text);
  return `Fallback language: ${useChinese ? "Chinese (中文)" : "English"}`;
}

/**
 * 构建标题生成提示词：单一 prompt 要求标题跟随用户输入语言（最高优先级），
 * 无法判断时使用兜底语言（显式 systemLanguage 优先，否则按输入是否含 CJK 推断）。
 */
export function buildTitleSystemPrompt(text: string, systemLanguage?: string): string {
  return `${SESSION_TITLE_SYSTEM_PROMPT_BASE}\n\n${resolveFallbackLanguageLine(systemLanguage, text)}`;
}

export type SessionTitleGeneratorInput = {
  text: string;
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
};

export type SessionTitleGenerator = (input: SessionTitleGeneratorInput) => Promise<string | null>;

export type CreateSessionTitleGeneratorOptions = {
  modelRuntime: Pick<ModelRuntime, "complete">;
  agentModel: PilotAgentModelSelection;
  timeoutMs?: number;
  /** 无法判断用户输入语言时的兜底语言（BCP-47 或英文名，如 "zh-CN"/"en"）。 */
  systemLanguage?: string;
};

export function createSessionTitleGenerator(options: CreateSessionTitleGeneratorOptions): SessionTitleGenerator {
  const timeoutMs = options.timeoutMs ?? SESSION_TITLE_TIMEOUT_MS;
  return async ({ text, sessionId, turnId, signal }) => {
    const prompt = normalizeSessionTitleInput(text);
    if (!prompt) {
      return null;
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

    try {
      const response = await options.modelRuntime.complete(
        {
          provider: options.agentModel.provider,
          model: options.agentModel.model,
          systemPrompt: buildTitleSystemPrompt(prompt, options.systemLanguage),
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          maxOutputTokens: 4096,
          temperature: 0,
          metadata: {
            purpose: "session_title_generation",
            sessionId,
            turnId,
          },
        },
        { signal: combinedSignal },
      );

      return parseGeneratedTitle(response.content);
    } catch (error) {
      logSessionTitleFailure("provider_error", error);
      return null;
    }
  };
}

export function normalizeSessionTitleInput(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > SESSION_TITLE_MAX_INPUT_CHARS
    ? normalized.slice(0, SESSION_TITLE_MAX_INPUT_CHARS)
    : normalized;
}

export function parseGeneratedTitle(content: CanonicalContentBlock[]): string | null {
  const text = content
    .filter(block => block.type === "text")
    .map(block => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!text) {
    logSessionTitleFailure("empty_content");
    return null;
  }

  // 1) 标准 JSON（容忍 ```json 围栏）
  const stripped = stripJsonFence(text);
  let jsonSucceeded = false;
  try {
    const parsed: unknown = JSON.parse(stripped);
    const title = readTopLevelTitle(parsed);
    if (title !== null) {
      return sanitizeGeneratedTitle(title);
    }
    // 合法 JSON 但缺顶层 title：不再用正则兜底，避免误提取嵌套字段
    // （如 {"foo": {"title": "x"}}、[{"title": "x"}]——嵌套/数组一律不取）。
    jsonSucceeded = true;
  } catch {
    // JSON 解析失败，落入下面的宽松兜底
  }

  // 2) 宽松正则：从任意文本中提取 title 字段
  //    覆盖单引号 JSON、文本包裹 JSON、JSON 语法不完整等模型常见输出。
  if (!jsonSucceeded) {
    const titleMatch = TITLE_FIELD_RE.exec(text);
    if (titleMatch) {
      return sanitizeGeneratedTitle(titleMatch[1]);
    }
  }

  // 3) 纯文本兜底：模型直接把标题写在文本里（未按 JSON 返回）。
  //    排除形似 JSON 的输出，避免把错误的结构化响应误当标题。
  if (!jsonSucceeded && !looksLikeJson(stripped)) {
    return sanitizeGeneratedTitle(text);
  }

  logSessionTitleFailure("missing_title");
  return null;
}

/** 读取 JSON 顶层 `title` 字符串字段；非对象/缺字段/非字符串一律返回 null。 */
function readTopLevelTitle(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const title = (value as Record<string, unknown>).title;
  return typeof title === "string" ? title : null;
}

/** 匹配 `title: "..."` 字段（容忍单/双引号、中文冒号、前后多余内容）。 */
const TITLE_FIELD_RE = /["']?title["']?\s*[:：]\s*["']([^"'\n]*)["']/i;

/** 形似 JSON 对象/数组的文本（去除围栏后以 `{` 或 `[` 开头）。 */
function looksLikeJson(text: string): boolean {
  return /^\s*[{[]/.test(text);
}

function stripJsonFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  return (match?.[1] ?? text).trim();
}

function sanitizeGeneratedTitle(title: string): string | null {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    logSessionTitleFailure("missing_title");
    return null;
  }
  return normalized.length > SESSION_TITLE_MAX_OUTPUT_CHARS
    ? normalized.slice(0, SESSION_TITLE_MAX_OUTPUT_CHARS)
    : normalized;
}

function logSessionTitleFailure(reason: string, error?: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const suffix = message ? `: ${message.slice(0, 200)}` : "";
  logger.debug(`generation skipped (${reason})${suffix}`);
}
