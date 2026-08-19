/**
 * 会话连接活跃追踪（M3）：gateway 内部状态，协议不动（无新方法/帧）。
 * 语义（容错优先）：unknown sessionKey（从未连接/纯 in-process/CLI）视为在线——
 * 无法判定的场景不阻塞成员工作；显式「见过连接且断开超过宽限窗」才判离线，
 * 且持续离线直到下次 touch 复位（known-offline 是持久知识，不做惰性删除，
 * 否则 key 翻回 unknown → 在线，isCaptainOnline 会出现离线→在线振荡）。
 * 宽限窗默认 60s：瞬断重连不误判离线。
 *
 * Map 有界性：sessionKey 是持久会话标识（通道会话/团队成员会话），非每请求键——
 * 自然有界，不会无限增长；不做 TTL 清理以保 known-offline 语义稳定。
 * M4 面板若需 TTL 展示再另行引入。
 */
export const SESSION_PRESENCE_GRACE_MS = 60_000;

type PresenceEntry = {
  /** 最近一次收到帧的时间戳（ms）；仅收到帧后存在（M4 面板展示最近活跃时间戳预留）。 */
  lastSeenAt?: number;
  /** 连接关闭时间戳（ms）；undefined = 当前有活跃连接。 */
  closedAt?: number;
};

export class SessionPresence {
  private readonly entries = new Map<string, PresenceEntry>();

  /** 连接收到任一帧：注册/刷新活跃。 */
  touch(sessionKey: string, now: number = Date.now()): void {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      this.entries.set(sessionKey, { lastSeenAt: now });
      return;
    }
    entry.lastSeenAt = now;
    entry.closedAt = undefined;
  }

  /** 连接关闭：记录关闭时刻（宽限窗内仍算在线，防瞬断误判）。重复 close 幂等，不后移 closedAt。 */
  close(sessionKey: string, now: number = Date.now()): void {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      // 未注册 key 先关后查：登记关闭时刻即可（未收到帧，不设 lastSeenAt）
      this.entries.set(sessionKey, { closedAt: now });
      return;
    }
    if (entry.closedAt === undefined) entry.closedAt = now;
  }

  /** 活跃判定：活跃连接 → true；关闭在宽限窗内 → true；unknown → true；关闭超窗 → false（持久，直到 touch 复位）。 */
  isActive(sessionKey: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) return true;
    if (entry.closedAt === undefined) return true;
    return now - entry.closedAt < SESSION_PRESENCE_GRACE_MS;
  }

  /** 当前活跃连接快照：含宽限窗内关闭会话（与 isActive 语义对齐，M4 面板预留）。 */
  activeSessions(now: number = Date.now()): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.closedAt === undefined || now - e.closedAt < SESSION_PRESENCE_GRACE_MS)
      .map(([k]) => k);
  }

  /** 清空全部记录（dispose 用）。 */
  clear(): void {
    this.entries.clear();
  }
}
