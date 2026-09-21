/**
 * 提示词超窗（PTL）判据的唯一实现。
 *
 * 为什么放在 model 层：判据有两个消费者——agent 层的模型错误恢复
 * （`agent/loop/modelErrors.ts`）与 context 层的压缩（摘要请求自身超窗时反向重选）。
 * context 层不得反向依赖 agent 层，因此判据下沉到两层的共同底座。
 *
 * 入参只需要三个字段（而不是整个 `CanonicalModelError`）：摘要是从 provider 的
 * error 事件里直接取结构化错误的，结构上不必是完整对象。
 */
import {
  PROMPT_TOO_LONG_ANTHROPIC_PATTERN,
  PROMPT_TOO_LONG_OPENAI_PATTERN,
  REQUEST_TOO_LARGE_PATTERN,
} from "../protocol/errors.js";

export type PromptTooLongSignal = {
  /** 归一化后的错误码（`prompt_too_long` / `request_too_large` / …）。 */
  code?: string;
  message: string;
  /** provider 之外（如恢复链）标记的「可经压缩恢复」信号。 */
  recoverableViaCompact?: boolean;
};

export function isPromptTooLong(error: PromptTooLongSignal): boolean {
  if (error.code === "prompt_too_long" || error.recoverableViaCompact) {
    return true;
  }
  if (PROMPT_TOO_LONG_ANTHROPIC_PATTERN.test(error.message)) {
    return true;
  }
  if (PROMPT_TOO_LONG_OPENAI_PATTERN.test(error.message)) {
    return true;
  }
  if (REQUEST_TOO_LARGE_PATTERN.test(error.message)) {
    return true;
  }
  return false;
}
