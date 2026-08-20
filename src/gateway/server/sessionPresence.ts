/**
 * 会话连接活跃追踪（M3）：gateway 内部状态，协议不动（无新方法/帧）。
 * 语义（容错优先）：unknown sessionKey（从未连接/纯 in-process/CLI）视为在线——
 * 无法判定的场景不阻塞成员工作；显式「见过连接且断开超过宽限窗」才判离线，
 * 且持续离线直到下次 touch 复位（known-offline 是持久知识，不做惰性删除，
 * 否则 key 翻回 unknown → 在线，isCaptainOnline 会出现离线→在线振荡）。
 * 宽限窗默认 60s：瞬断重连不误判离线。
 * M4：面板心跳（panelTouch）维持 Web 下线判定——浏览器关闭不触发 gateway onClose，
 * 以心跳停更 + 宽限窗判定 Web 下线。直连帧（touch）同步刷新面板时间线（S1 评审）：
 * 「CLI 直连 + 面板关闭」共用 key 时直连帧即活跃信号，面板停更不误杀仍在操作的会话；
 * 全静默（无帧且无心跳）超宽限窗才判离线。panelTouch 只刷新面板时间线，不清 closedAt
 * （面板心跳不是直连——直连维度仍以 touch/close 为准）。
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
  /** 面板心跳最后时间戳（ms）；undefined = 无面板信号（M4 Web 下线判定）。 */
  panelSeenAt?: number;
};

export class SessionPresence {
  private readonly entries = new Map<string, PresenceEntry>();

  /** 连接收到任一帧：注册/刷新活跃。直连帧即活跃信号（S1 评审），同步刷新面板时间线。 */
  touch(sessionKey: string, now: number = Date.now()): void {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      this.entries.set(sessionKey, { lastSeenAt: now, panelSeenAt: now });
      return;
    }
    entry.lastSeenAt = now;
    entry.closedAt = undefined;
    // 帧到 = 用户活着：面板权威判定（isActive 分支）以最近帧/心跳为准，
    // 消灭「CLI 直连 + 面板关闭」共用 key 的误杀（面板停更不掩盖直连活动）。
    entry.panelSeenAt = now;
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

  /**
   * 面板心跳（M4）：浏览器经 ui/server relay 周期上报活跃会话；面板关闭 = 心跳停 →
   * 超宽限窗离线。只复位离线判定（known-offline → 在线），不清 closedAt（面板心跳
   * 不是直连——直连维度仍以 touch/close 为准；touch 会同步刷新面板时间线，反向不成立）。
   */
  panelTouch(sessionKey: string, now: number = Date.now()): void {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      this.entries.set(sessionKey, { panelSeenAt: now });
      return;
    }
    entry.panelSeenAt = now;
  }

  /**
   * 活跃判定：unknown → true；直连活跃 → 面板心跳宽限窗内（有面板信号时）→ true；
   * 直连关闭宽限窗内 → true；面板心跳宽限窗内 → true（M4 Web 下线判定）；
   * 全超窗 → false（持久，直到 touch/panelTouch 复位）。
   *
   * M4 关键语义：经 ui/server relay 的 Web 会话只有共享连接（永不关闭），
   * closedAt 恒为 undefined——若直连活跃直接短路为 true，面板停更永远无法判离线
   * （M3 I1 fail-open 复现）。故「直连活跃 + 有面板信号」的条目以面板时间线为准。
   * S1 评审融合：touch（直连帧）同步刷新面板时间线，直连活跃会话的面板信号恒新鲜
   * （CLI 帧到 = 用户活着，面板关闭不误杀）；纯面板会话由 panelTouch 刷新；
   * 全静默（无帧且无心跳）超宽限窗 → 离线。纯直连「从未见过任何帧/心跳」仅存在于
   * unknown key（→ true 容错），一旦见过帧即纳入统一活跃语义。
   */
  isActive(sessionKey: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) return true;
    const directActive = entry.closedAt === undefined || now - entry.closedAt < SESSION_PRESENCE_GRACE_MS;
    if (directActive) {
      // 无面板信号 = 仅 close 登记的 key（未见任何帧/心跳），直连即在线；
      // 有面板信号 = 活跃语义统一（S1：touch/panelTouch 都刷新面板时间线），
      // 停更超宽限窗 → 离线（Web 经 relay 会话 closedAt 恒 undefined，以此判 Web 下线）。
      if (entry.panelSeenAt === undefined) return true;
      return now - entry.panelSeenAt < SESSION_PRESENCE_GRACE_MS;
    }
    // 直连已离线：面板心跳独立宽限窗仍可维持在线（浏览器打开中）
    return entry.panelSeenAt !== undefined && now - entry.panelSeenAt < SESSION_PRESENCE_GRACE_MS;
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
