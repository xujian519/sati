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
    this.sweepIdle();
    const cached = this.sessions.get(context.sessionKey);
    if (cached) {
      cached.context = mergeSessionContext(cached.context, context);
      if (cached.dirtyReason && this.options.recreateSession) {
        this.emitSessionEvict(context.sessionKey, cached, "dirty_recreate");
        cached.session = await this.options.recreateSession(cached.context, cached.session);
        cached.dirtyReason = undefined;
      }
      cached.lastUsedAt = this.nowMs();
      return cached.session;
    }

    const session = await this.options.createSession(context);
    this.sessions.set(context.sessionKey, {
      session,
      lastUsedAt: this.nowMs(),
      context,
    });
    return session;
  }

  beginTurn(sessionKey: string, runId: string): boolean {
    this.sweepIdle();
    if (this.inFlightTurns.has(sessionKey)) {
      return false;
    }
    this.inFlightTurns.set(sessionKey, runId);
    return true;
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
      this.emitSessionEvict(sessionKey, record, "closed");
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
      this.emitSessionEvict(sessionKey, record, "shutdown");
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
        this.emitSessionEvict(sessionKey, record, "idle");
      }
    }
  }

  private emitSessionEvict(
    sessionKey: string,
    record: SessionRecord,
    reason: "idle" | "closed" | "dirty_recreate" | "shutdown",
  ): void {
    this.options.onSessionEvict?.(sessionKey);
    if (reason === "idle") {
      this.options.onSessionIdleEvict?.(sessionKey, snapshotEvictedSession(sessionKey, record));
    }
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
