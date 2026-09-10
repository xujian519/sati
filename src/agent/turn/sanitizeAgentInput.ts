/**
 * 用户输入外发脱敏（W1，借鉴 GenOffice sanitizeAgentPayload）。
 *
 * 用户把含密钥的配置/日志粘贴进会话时，凭证不应原样进入远端模型 API。
 * 在 TurnRunner 入口（inputProcessor.accept 之前）对输入文本做三类替换，
 * 脱敏后的文本同时进入 transcript 与模型可见消息，维持「模型可见 = 已记录」。
 *
 * 替换规则本身在 `src/shared/credentialRedaction.ts`（router 的错误落盘同用）。
 */
import type { AgentInput } from "../protocol/input.js";
import type { CanonicalContentBlock } from "../../model/index.js";
import { sanitizeOutgoingText } from "../../shared/credentialRedaction.js";

export {
  REDACTED_API_KEY,
  REDACTED_CREDENTIALS,
  REDACTED_SECURE_TOKEN,
  sanitizeOutgoingText,
} from "../../shared/credentialRedaction.js";

export type SanitizeResult = {
  /** 脱敏后的输入（redacted=false 时原样返回） */
  input: AgentInput;
  /** 是否发生任一替换 */
  redacted: boolean;
};

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
