/**
 * 用户输入外发脱敏（W1，借鉴 GenOffice sanitizeAgentPayload）。
 *
 * 用户把含密钥的配置/日志粘贴进会话时，凭证不应原样进入远端模型 API。
 * 在 TurnRunner 入口（inputProcessor.accept 之前）对输入文本做三类替换，
 * 脱敏后的文本同时进入 transcript 与模型可见消息，维持「模型可见 = 已记录」。
 *
 * 正则刻意收窄防误伤：密钥需 ≥16 字符；URL 凭证仅匹配 userinfo 段
 * （scheme://user:pass@host），普通 "a:b@c" 散文不受影响。
 */
import type { AgentInput } from "../protocol/input.js";
import type { CanonicalContentBlock } from "../../model/index.js";

const API_KEY_RE = /\b(?:sk-|sk-ant-|xai-|AIza|ghp_|gho_|glpat_)[A-Za-z0-9_-]{16,}\b/g;
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;
const SECRET_ASSIGNMENT_RE = /(password|passwd|secret_key|private_key)(\s*[:=]\s*)["'][^"']+["']/gi;

export const REDACTED_API_KEY = "[REDACTED_API_KEY]";
export const REDACTED_CREDENTIALS = "[REDACTED_CREDENTIALS]";
export const REDACTED_SECURE_TOKEN = "[REDACTED_SECURE_TOKEN]";

export type SanitizeResult = {
  /** 脱敏后的输入（redacted=false 时原样返回） */
  input: AgentInput;
  /** 是否发生任一替换 */
  redacted: boolean;
};

/** 对单段文本执行三类凭证替换；redacted = 文本是否发生变化。 */
export function sanitizeOutgoingText(text: string): { text: string; redacted: boolean } {
  const out = text
    .replace(API_KEY_RE, REDACTED_API_KEY)
    .replace(URL_CREDENTIALS_RE, `$1:${REDACTED_CREDENTIALS}@`)
    .replace(SECRET_ASSIGNMENT_RE, `$1$2"${REDACTED_SECURE_TOKEN}"`);
  return { text: out, redacted: out !== text };
}

/**
 * 对 AgentInput 做外发脱敏：text 形态脱敏 text 字段；blocks 形态仅脱敏
 * text block（图片/工具块等二进制与结构化内容不触碰）。
 */
export function sanitizeAgentInput(input: AgentInput): SanitizeResult {
  if (input.type === "text") {
    const { text, redacted } = sanitizeOutgoingText(input.text);
    if (!redacted) return { input, redacted: false };
    return { input: { ...input, text }, redacted: true };
  }
  let redacted = false;
  const content: CanonicalContentBlock[] = input.content.map(block => {
    if (block.type !== "text") return block;
    const result = sanitizeOutgoingText(block.text);
    if (!result.redacted) return block;
    redacted = true;
    return { ...block, text: result.text };
  });
  if (!redacted) return { input, redacted: false };
  return { input: { ...input, content }, redacted: true };
}
