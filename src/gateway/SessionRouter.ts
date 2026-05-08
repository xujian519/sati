import type { AgentSession } from "../agent/index.js";
import type { GatewaySessionInfo, ListSessionsInput, ListSessionsResult } from "./protocol/types.js";

export type GatewaySessionContext = {
  sessionKey: string;
  projectKey?: string;
  channelKey: string;
};

export type GatewaySessionFactory = (context: GatewaySessionContext) => AgentSession | Promise<AgentSession>;

export type SessionRouterOptions = {
  createSession: GatewaySessionFactory;
  listSessions?: (input: ListSessionsInput) => Promise<ListSessionsResult>;
  idleSessionTimeoutMs?: number;
  now?: () => Date;
};

type SessionRecord = {
  session: AgentSession;
  lastUsedAt: number;
};

const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export class SessionRouter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly inFlightTurns = new Map<string, string>();
  private readonly idleSessionTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: SessionRouterOptions) {
    this.idleSessionTimeoutMs = options.idleSessionTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async getOrCreate(context: GatewaySessionContext): Promise<AgentSession> {
    this.sweepIdle();
    const cached = this.sessions.get(context.sessionKey);
    if (cached) {
      cached.lastUsedAt = this.nowMs();
      return cached.session;
    }

    const session = await this.options.createSession(context);
    this.sessions.set(context.sessionKey, {
      session,
      lastUsedAt: this.nowMs(),
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
    this.sessions.delete(sessionKey);
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
          summary: snapshot.messages
            .flatMap((message) => message.content)
            .find((block) => block.type === "text")
            ?.text ?? sessionKey,
          lastModified: record.lastUsedAt,
        };
      }),
    };
  }

  sessionCount(): number {
    this.sweepIdle();
    return this.sessions.size;
  }

  private sweepIdle(): void {
    const now = this.nowMs();
    for (const [sessionKey, record] of this.sessions) {
      if (this.inFlightTurns.has(sessionKey)) {
        continue;
      }
      if (now - record.lastUsedAt > this.idleSessionTimeoutMs) {
        this.sessions.delete(sessionKey);
      }
    }
  }

  private nowMs(): number {
    return this.now().getTime();
  }
}
