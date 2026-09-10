import type { AgentSession } from "../agent/index.js";
import type { CanonicalMessage } from "../model/protocol/canonical.js";
import type { GatewaySessionInfo, ListSessionsInput, ListSessionsResult } from "./protocol/types.js";

export type GatewaySessionContext = {
  sessionKey: string;
  projectKey?: string;
  channelKey: string;
  /** Per-session model route override (M4, team member wake): applied to the session config at creation. */
  modelRoute?: { provider: string; model: string };
};

export type GatewaySessionFactory = (context: GatewaySessionContext) => AgentSession | Promise<AgentSession>;
export type GatewaySessionRecreator = (
  context: GatewaySessionContext,
  previousSession: AgentSession,
) => AgentSession | Promise<AgentSession>;

export type SessionRouterOptions = {
  createSession: GatewaySessionFactory;
  recreateSession?: GatewaySessionRecreator;
  listSessions?: (input: ListSessionsInput) => Promise<ListSessionsResult>;
  idleSessionTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  now?: () => Date;
  /**
   * Called (fire-and-forget) when a session is evicted from the router —
   * idle sweep, explicit close, or dirty-recreate. Use this to clean up
   * per-session resources (e.g. per-session MCP runtimes / browser processes).
   */
  onSessionEvict?: (sessionKey: string) => void;
  onSessionIdleEvict?: (sessionKey: string, record: SessionEvictionSnapshot) => void;
};

type SessionRecord = {
  session: AgentSession;
  lastUsedAt: number;
  context: GatewaySessionContext;
  dirtyReason?: string;
};

export type SessionEvictionSnapshot = {
  sessionKey: string;
  lastUsedAt: number;
  context: GatewaySessionContext;
  messageCount?: number;
};

const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

export class SessionRouter {
  private readonly sessions = new Map<string, SessionRecord>();
  /** 正在排空的会话（关闭/驱逐 → 写入器落盘完成），供 close/getOrCreate 等待（上游 #568）。 */
  private readonly closingSessions = new Map<string, Promise<void>>();
  /** sessionKey → 其排空会话所属 projectKey（closeProject 据此聚合 drain 中的会话）。 */
  private readonly closingProjects = new Map<string, string | undefined>();
  /** projectKey → 代数；项目被关闭时 +1，用于发现"创建/重建期间项目被关"的竞态。 */
  private readonly projectGenerations = new Map<string, number>();
  /** 已暂停的项目（删除中）：拒绝新会话创建/重建，直到 resumeProject。 */
  private readonly pausedProjects = new Set<string>();
  /** 进行中的会话创建（项目关闭时需一并等待并 dispose，避免关闭后泄漏运行时）。 */
  private readonly creatingSessions = new Map<Promise<AgentSession>, GatewaySessionContext>();
  private readonly inFlightTurns = new Map<string, string>();
  private readonly idleSessionTimeoutMs: number;
  private readonly idleSweepIntervalMs: number;
  private readonly now: () => Date;
  private readonly idleSweepTimer?: ReturnType<typeof setInterval>;
  private isShutdown = false;

  constructor(private readonly options: SessionRouterOptions) {
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS;
    this.idleSweepIntervalMs = options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    if (this.idleSweepIntervalMs > 0) {
      this.idleSweepTimer = setInterval(() => this.sweepIdle(), this.idleSweepIntervalMs);
      this.idleSweepTimer.unref?.();
    }
  }

  async getOrCreate(context: GatewaySessionContext): Promise<AgentSession> {
    this.assertProjectOpen(context.projectKey);
    // 记下创建发生时的项目代数：创建/重建期间项目被关闭（代数 +1）时，
    // 本次创建的结果必须作废，否则会在已删除的项目里复活运行时。
    const generation = this.projectGenerations.get(context.projectKey ?? "");
    this.sweepIdle();
    const closing = this.closingSessions.get(context.sessionKey);
    if (closing) await closing;
    const cached = this.sessions.get(context.sessionKey);
    if (cached) {
      cached.context = mergeSessionContext(cached.context, context);
      if (cached.dirtyReason && this.options.recreateSession) {
        await this.emitSessionEvict(context.sessionKey, cached, "dirty_recreate");
        const recreated = await this.createTrackedSession(cached.context, () =>
          this.options.recreateSession!(cached.context, cached.session),
        );
        if (generation !== this.projectGenerations.get(context.projectKey ?? "")) {
          await recreated.dispose?.();
          throw new Error("Project was closed while recreating the session.");
        }
        cached.session = recreated;
        cached.dirtyReason = undefined;
      }
      cached.lastUsedAt = this.nowMs();
      return cached.session;
    }

    const session = await this.createTrackedSession(context, () => this.options.createSession(context));
    if (generation !== this.projectGenerations.get(context.projectKey ?? "")) {
      await session.dispose?.();
      throw new Error("Project was closed while creating the session.");
    }
    this.sessions.set(context.sessionKey, {
      session,
      lastUsedAt: this.nowMs(),
      context,
    });
    return session;
  }

  private assertProjectOpen(projectKey?: string): void {
    if (projectKey && this.pausedProjects.has(projectKey)) throw new Error("Project is being deleted.");
  }

  private async createTrackedSession(
    context: GatewaySessionContext,
    create: () => AgentSession | Promise<AgentSession>,
  ): Promise<AgentSession> {
    this.assertProjectOpen(context.projectKey);
    const pending = Promise.resolve(create());
    this.creatingSessions.set(pending, context);
    try {
      const session = await pending;
      if (context.projectKey && this.pausedProjects.has(context.projectKey)) {
        await session.dispose?.();
        throw new Error("Project is being deleted.");
      }
      return session;
    } finally {
      this.creatingSessions.delete(pending);
    }
  }

  /**
   * 暂停创建并排空该项目自己的运行时写入器（不扫描历史）。
   * 返回被关闭的已缓存会话 sessionKey 列表。
   */
  async closeProject(projectKey: string): Promise<string[]> {
    this.pausedProjects.add(projectKey);
    this.projectGenerations.set(projectKey, (this.projectGenerations.get(projectKey) ?? 0) + 1);
    const keys = [...this.sessions]
      .filter(([, record]) => record.context.projectKey === projectKey)
      .map(([key]) => key);
    const creating = [...this.creatingSessions]
      .filter(([, context]) => context.projectKey === projectKey)
      .map(([pending]) => pending);
    const draining = [...this.closingSessions]
      .filter(([key]) => this.closingProjects.get(key) === projectKey)
      .map(([, pending]) => pending);
    await Promise.all([
      ...keys.map(key => this.close(key)),
      ...draining,
      ...creating.map(async pending => {
        const session = await pending.catch(() => null);
        await session?.dispose?.();
      }),
    ]);
    return keys;
  }

  resumeProject(projectKey: string): void {
    this.pausedProjects.delete(projectKey);
  }

  beginTurn(sessionKey: string, runId: string): boolean {
    this.sweepIdle();
    if (this.inFlightTurns.has(sessionKey)) {
      return false;
    }
    this.inFlightTurns.set(sessionKey, runId);
    return true;
  }

  /**
   * Mid-turn steering：取当前有 in-flight turn 的已缓存会话。只查不建——
   * beginTurn 后、submitTurn pump 完成 getOrCreate 前的极小窗口内返回
   * undefined（调用方按 no_active_turn 拒绝，客户端重试即可）。
   */
  getActiveSession(sessionKey: string): AgentSession | undefined {
    if (!this.inFlightTurns.has(sessionKey)) return undefined;
    return this.sessions.get(sessionKey)?.session;
  }

  endTurn(sessionKey: string, runId?: string): void {
    const record = this.sessions.get(sessionKey);
    const inFlightRunId = this.inFlightTurns.get(sessionKey);
    if (!runId || inFlightRunId === runId) {
      this.inFlightTurns.delete(sessionKey);
    }
    if (record) {
      record.lastUsedAt = this.nowMs();
    }
  }

  async abort(sessionKey: string, reason?: string): Promise<void> {
    const record = this.sessions.get(sessionKey);
    record?.session.abort(reason);
    if (record) {
      record.lastUsedAt = this.nowMs();
    }
  }

  async close(sessionKey: string): Promise<void> {
    const record = this.sessions.get(sessionKey);
    if (record && this.sessions.delete(sessionKey)) {
      await this.emitSessionEvict(sessionKey, record, "closed");
    } else {
      // 空闲逐出或另一次 close 可能已在排空这个写入器：等待它，别抢跑。
      await this.closingSessions.get(sessionKey);
    }
  }

  /**
   * 读取已存在会话（不创建）：供审批等不驱动 turn 的操作定位会话。
   * 会话不存在（从未创建或已被空闲回收）时返回 undefined。
   */
  get(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey)?.session;
  }

  markAllDirty(reason = "runtime_changed"): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      record.dirtyReason = reason;
      count += 1;
    }
    return count;
  }

  markProjectDirty(projectKey: string, reason = "runtime_changed"): number {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.context.projectKey !== projectKey) {
        continue;
      }
      record.dirtyReason = reason;
      count += 1;
    }
    return count;
  }

  async list(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    if (this.options.listSessions) {
      return this.options.listSessions(input);
    }

    return {
      sessions: [...this.sessions.entries()].map(([sessionKey, record]): GatewaySessionInfo => {
        const snapshot = record.session.snapshot();
        return {
          sessionId: snapshot.sessionId,
          sessionKey,
          summary: firstTextSummary(snapshot.messages) ?? sessionKey,
          lastModified: record.lastUsedAt,
        };
      }),
    };
  }

  sessionCount(): number {
    this.sweepIdle();
    return this.sessions.size;
  }

  cachedSessionCount(): number {
    return this.sessions.size;
  }

  /** True when the given session has a turn currently in flight. */
  hasInFlightTurn(sessionKey: string): boolean {
    return this.inFlightTurns.has(sessionKey);
  }

  snapshotSession(sessionKey: string): ReturnType<AgentSession["snapshot"]> | undefined {
    return this.sessions.get(sessionKey)?.session.snapshot();
  }

  shutdown(): void {
    if (this.isShutdown) return;
    this.isShutdown = true;
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
    }
    for (const [sessionKey, record] of this.sessions) {
      void this.emitSessionEvict(sessionKey, record, "shutdown").catch(() => undefined);
    }
    this.sessions.clear();
    this.inFlightTurns.clear();
  }

  /**
   * Returns true when at least one *user* turn (not always-on / cron) is
   * in flight for the given project.  Used by the Always-On scheduler to
   * implement the `agent_busy` gate.
   */
  hasActiveUserTurn(projectKey: string): boolean {
    for (const [sessionKey] of this.inFlightTurns) {
      if (sessionKey.startsWith("always-on/")) continue;
      if (sessionKey.startsWith("cron:")) continue;
      const record = this.sessions.get(sessionKey);
      if (record?.context.projectKey === projectKey) return true;
    }
    return false;
  }

  private sweepIdle(): void {
    if (this.isShutdown) return;
    const now = this.nowMs();
    for (const [sessionKey, record] of this.sessions) {
      if (this.inFlightTurns.has(sessionKey)) {
        continue;
      }
      if (now - record.lastUsedAt > this.idleSessionTimeoutMs) {
        this.sessions.delete(sessionKey);
        void this.emitSessionEvict(sessionKey, record, "idle").catch(() => undefined);
      }
    }
  }

  private emitSessionEvict(
    sessionKey: string,
    record: SessionRecord,
    reason: "idle" | "closed" | "dirty_recreate" | "shutdown",
  ): Promise<void> {
    // 先 dispose（中止在跑 turn + 关闭转录写入器）再回调驱逐钩子：钩子清理
    // MCP/browser 等资源时，迟到写入已经不可能发生（上游 #568）。
    const disposed = (record.session.dispose?.() ?? Promise.resolve()).finally(() => {
      // 仅当本条目仍是当前排空 promise 时清理（被后续 close 覆盖时不误删）。
      if (this.closingSessions.get(sessionKey) === disposed) {
        this.closingSessions.delete(sessionKey);
        this.closingProjects.delete(sessionKey);
      }
    });
    this.closingSessions.set(sessionKey, disposed);
    this.closingProjects.set(sessionKey, record.context.projectKey);
    this.options.onSessionEvict?.(sessionKey);
    if (reason === "idle") {
      this.options.onSessionIdleEvict?.(sessionKey, snapshotEvictedSession(sessionKey, record));
    }
    return disposed;
  }

  private nowMs(): number {
    return this.now().getTime();
  }
}

/**
 * 会话摘要 = 首条 text 消息。早停扫描：不展开全部 content 块（原 flatMap().find()
 * 会先物化全部消息的 content 数组，长会话 O(总块数)）。首条消息通常即文本 → O(1)。
 */
function firstTextSummary(messages: CanonicalMessage[]): string | undefined {
  for (const message of messages) {
    const text = message.content.find(block => block.type === "text")?.text;
    if (text !== undefined) return text;
  }
  return undefined;
}

function snapshotEvictedSession(sessionKey: string, record: SessionRecord): SessionEvictionSnapshot {
  let messageCount: number | undefined;
  try {
    messageCount = record.session.snapshot().messages.length;
  } catch {
    // 快照失败（会话已关闭等）按无消息处理，驱逐记录不因此中断。
    messageCount = undefined;
  }
  return {
    sessionKey,
    lastUsedAt: record.lastUsedAt,
    context: { ...record.context },
    ...(messageCount !== undefined ? { messageCount } : {}),
  };
}

function mergeSessionContext(current: GatewaySessionContext, next: GatewaySessionContext): GatewaySessionContext {
  return {
    sessionKey: next.sessionKey,
    channelKey: next.channelKey || current.channelKey,
    projectKey: current.projectKey ?? next.projectKey,
    // 锚点说明（质量评审 M4）：modelRoute 保留会话创建时的路由——模型在会话创建时
    // 生效，后续唤醒复用缓存会话（创建后不可再改）；channelKey 用 next 是因会话归属
    // 不可漂移。两者锚点方向不同是有意的。
    modelRoute: current.modelRoute ?? next.modelRoute,
  };
}
