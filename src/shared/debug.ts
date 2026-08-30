/**
 * Debug 输出门控：Node 中 console.debug 是 console.log 的别名（同样写
 * stdout），直接调用无法真正降噪（桌面端日志镜像 stdout/stderr）。统一经
 * 此 helper 输出，仅当 SATI_DEBUG=1|true 时打印；默认关闭以削减
 * desktop.server.log / CLI 的常规噪音。
 */
function isDebugLoggingEnabled(): boolean {
  return process.env.SATI_DEBUG === "1" || process.env.SATI_DEBUG === "true";
}

export function debugLog(message: string, ...args: unknown[]): void {
  if (!isDebugLoggingEnabled()) return;
  console.log(message, ...args);
}
