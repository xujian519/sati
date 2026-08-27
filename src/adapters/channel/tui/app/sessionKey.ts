/**
 * TUI 缺省会话键。独立于 TuiChannel/TuiApp 的叶子模块：
 * 两个方向都需要它，放这里避免 channel ↔ app 形成值循环依赖。
 */
export function defaultTuiSessionKey(projectKey = process.cwd()): string {
  return `tui:project=${projectKey}:default`;
}
