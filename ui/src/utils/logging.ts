/**
 * 前端统一日志出口（C39 收束目标）。纯转发，行为与裸 console 一致：
 *   - info  → console.log（stdout）
 *   - warn  → console.warn（stderr）
 *   - error → console.error（stderr）
 *
 * 刻意不引入第三方日志库；仅把散落在 ui/src 的裸 `console.*` 收束到
 * 单一治理面。
 */
export function logInfo(message: string, ...args: unknown[]): void {
  console.log(message, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  console.warn(message, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
  console.error(message, ...args);
}
