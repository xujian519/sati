import { isThinkingModeId, type ThinkingModeId } from "../constants/thinkingModes";
import { safeLocalStorage } from "../utils/chatStorage";
import { isTemporarySessionId } from "../utils/sessionLauncher";

/**
 * 思维模式的会话级持久化：读取、归一化、写回。
 *
 * 从 `useChatComposerState.ts` 搬出（#646 B2.5），**被搬代码逐字未改**；
 * hook 只保留 state 与 effect 的调用位置。
 */

const storageKey = (sessionId: string) => `thinkingMode-${sessionId}`;

export function normalizeThinkingMode(nextMode: ThinkingModeId | string): ThinkingModeId {
  return isThinkingModeId(nextMode) ? nextMode : "default";
}

export function persistThinkingModeForSession(sessionId: string | null, mode: ThinkingModeId): void {
  if (sessionId && !isTemporarySessionId(sessionId)) {
    safeLocalStorage.setItem(storageKey(sessionId), mode);
  }
}

/**
 * 会话切换时的初始模式：已存值优先；新会话提交时留下的 pending 值次之。
 * pending 只在真正被采用时清空（已存值胜出时保留，供下一个新会话使用）。
 */
export function resolveThinkingModeForSession(
  sessionId: string | null,
  pendingModeRef: { current: ThinkingModeId | null },
): ThinkingModeId {
  if (!sessionId || isTemporarySessionId(sessionId)) {
    return "default";
  }
  const stored = safeLocalStorage.getItem(storageKey(sessionId));
  if (isThinkingModeId(stored)) {
    return stored;
  }
  if (pendingModeRef.current) {
    const pendingMode = pendingModeRef.current;
    pendingModeRef.current = null;
    safeLocalStorage.setItem(storageKey(sessionId), pendingMode);
    return pendingMode;
  }
  return "default";
}
