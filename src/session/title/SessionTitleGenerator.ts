import type { CanonicalContentBlock, ModelRuntime } from "../../model/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";

export const SESSION_TITLE_MAX_INPUT_CHARS = 1200;
export const SESSION_TITLE_MAX_OUTPUT_CHARS = 80;
export const SESSION_TITLE_TIMEOUT_MS = 30_000;

const SESSION_TITLE_SYSTEM_PROMPT_EN = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}

Do not output Markdown, code fences, explanations, analysis, thinking text, <think> tags, or extra fields.`;

const SESSION_TITLE_SYSTEM_PROMPT_ZH = `为本次会话生成一个简洁的标题（3-10 个字），概括会话的主要话题或目标。标题应足够清晰，让用户能在会话列表中一眼认出。

以 JSON 格式返回，只有一个 "title" 字段。

好例子：
{"title": "修复移动端登录按钮"}
{"title": "添加 OAuth 认证"}
{"title": "排查 CI 测试失败"}
{"title": "重构 API 客户端错误处理"}

太宽泛（不好）：{"title": "代码修改"}
太长（不好）：{"title": "调查并修复移动端登录按钮在手机上无法响应的问题"}
只描述动作而非主题（不好）：{"title": "帮我看看"}

不要输出 Markdown、代码块、解释、分析、思考文本、<think> 标签或多余字段。`;

/** CJK 统一表意文字（含中文/日文/韩文汉字），用于识别用户消息语言。 */
const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

export function hasCjk(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

/** 按输入文本语言选择标题生成提示词：包含中文字符时用中文，否则用英文。 */
export function buildTitleSystemPrompt(text: string): string {
  return hasCjk(text) ? SESSION_TITLE_SYSTEM_PROMPT_ZH : SESSION_TITLE_SYSTEM_PROMPT_EN;
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
          systemPrompt: buildTitleSystemPrompt(prompt),
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
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { title?: unknown }).title === "string") {
      return sanitizeGeneratedTitle((parsed as { title: string }).title);
    }
    // 合法 JSON 但缺顶层 title：不再用正则兜底，避免误提取嵌套字段（如 {"foo": {"title": "x"}}）。
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
  console.debug(`[session-title] generation skipped (${reason})${suffix}`);
}
