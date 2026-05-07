import { LRUCache } from "lru-cache";

interface SessionState {
  stickyTier: string;
  stickyModel: string;
  isOrchestrating: boolean;
  lastUpdated: number;
}

const sessions = new LRUCache<string, SessionState>({
  max: 500,
  ttl: 3600_000,
});

export function getSessionState(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

export function updateSessionState(
  sessionId: string,
  tier: string,
  model: string,
): void {
  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    stickyTier: tier,
    stickyModel: model,
    isOrchestrating: existing?.isOrchestrating ?? false,
    lastUpdated: Date.now(),
  });
}

export function setOrchestrating(sessionId: string, value: boolean): void {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.isOrchestrating = value;
    existing.lastUpdated = Date.now();
    sessions.set(sessionId, existing);
  } else {
    sessions.set(sessionId, {
      stickyTier: "",
      stickyModel: "",
      isOrchestrating: value,
      lastUpdated: Date.now(),
    });
  }
}

export function isOrchestrating(sessionId: string): boolean {
  return sessions.get(sessionId)?.isOrchestrating ?? false;
}
