/**
 * ui/server 统一日志入口（C39 收束目标）。
 *
 * 纯转发至对应 console 通道，不加前缀、不改变输出文本：
 *   - info  → console.log（stdout）
 *   - warn  → console.warn（stderr）
 *   - error → console.error（stderr）
 *
 * 刻意不引入第三方日志库、不做落盘；仅把散落的裸 `console.*` 收束到
 * 单一治理面（与服务端行为保持一致）。ui/server 不导入 src/telemetry
 * （见 scripts/check-ui-server-boundary.mjs 白名单），故在此建本地入口。
 */
export const logger = {
  info(message, ...args) {
    console.log(message, ...args);
  },
  warn(message, ...args) {
    console.warn(message, ...args);
  },
  error(message, ...args) {
    console.error(message, ...args);
  },
};
