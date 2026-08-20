/**
 * 团队面板心跳（M4 Web 下线判定）：每 30s 把当前活跃浏览器会话 key 汇总上报
 * gateway panel_heartbeat（gateway SessionPresence.panelTouch）。浏览器全关 →
 * 心跳表停更 → gateway 侧最后心跳 + 60s 宽限窗后 isCaptainOnline 判离线（fail-open
 * 修复：CLI/TUI 直连路径不受影响——直连 touch 独立维护）。
 *
 * 接线：ui/server/index.js 启动时调用，传入活跃表读取函数与上报函数；
 * 返回 stop 函数（timer.unref 已保证不阻塞进程退出，可不清扫）。
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * @param {{ getBrowserActiveKeys: () => string[], heartbeat: (keys: string[]) => Promise<unknown> }} deps
 * @returns {() => void} stop 函数
 */
export function startTeamPresenceHeartbeat({ getBrowserActiveKeys, heartbeat }) {
  const timer = setInterval(async () => {
    try {
      const keys = getBrowserActiveKeys();
      if (keys.length > 0) await heartbeat(keys);
    } catch (error) {
      console.warn("[sati] panel heartbeat failed", error);
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
