import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Types ──

export interface TokenBucket {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedCost: number;
}

export interface HourlyBucket {
  hour: string;
  byScenario: Record<string, TokenBucket>;
  byProvider: Record<string, TokenBucket>;
  byTier: Record<string, TokenBucket>;
  byRole: Record<string, TokenBucket>;
  total: TokenBucket;
}

export interface SessionTokenStats {
  sessionId: string;
  total: TokenBucket;
  byScenario: Record<string, TokenBucket>;
  byTier: Record<string, TokenBucket>;
  byRole: Record<string, TokenBucket>;
  byModel: Record<string, TokenBucket>;
  requestLog: RequestLogEntry[];
  firstSeenAt: number;
  lastActiveAt: number;
}

export interface TokenStatsData {
  lifetime: {
    total: TokenBucket;
    byScenario: Record<string, TokenBucket>;
    byProvider: Record<string, TokenBucket>;
    byTier: Record<string, TokenBucket>;
    byRole: Record<string, TokenBucket>;
  };
  hourly: HourlyBucket[];
  sessions: Record<string, SessionTokenStats>;
  startedAt: number;
  lastUpdatedAt: number;
}

export interface RequestLogEntry {
  ts: number;
  role: "main" | "sub";
  tier?: string;
  model: string;
  tokens: number;
  cost: number;
  query?: string;
}

export interface UsageEvent {
  sessionId: string;
  provider: string;
  model: string;
  scenarioType: string;
  tier?: string;
  isSubagent?: boolean;
  usage?: { input?: number; output?: number; cacheRead?: number };
  querySnippet?: string;
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

// ── Helpers ──

const MAX_HOURLY_BUCKETS = 72;
const MAX_SESSIONS = 200;
const DEFAULT_STATS_PATH = join(homedir(), ".claude-code-router", "token-stats.json");

function emptyBucket(): TokenBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requestCount: 0, estimatedCost: 0 };
}

function currentHourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

function emptyStats(): TokenStatsData {
  return {
    lifetime: {
      total: emptyBucket(),
      byScenario: {},
      byProvider: {},
      byTier: {},
      byRole: {},
    },
    hourly: [],
    sessions: {},
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
}

function addToBucket(bucket: TokenBucket, usage: UsageEvent["usage"], cost = 0): void {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.cacheReadTokens += cacheRead;
  bucket.totalTokens += input + output;
  bucket.requestCount += 1;
  bucket.estimatedCost += cost;
}

function ensureBucket(map: Record<string, TokenBucket>, key: string): TokenBucket {
  if (!map[key]) map[key] = emptyBucket();
  return map[key];
}

// ── Pricing ──

let modelPricingConfig: Record<string, ModelPricing> | null = null;

export function setModelPricing(pricing: Record<string, ModelPricing>): void {
  modelPricingConfig = pricing;
}

export function lookupPricing(model: string): ModelPricing {
  if (!modelPricingConfig) return { inputPer1M: 3, outputPer1M: 15 };

  if (modelPricingConfig[model]) {
    return {
      inputPer1M: modelPricingConfig[model].inputPer1M ?? 3,
      outputPer1M: modelPricingConfig[model].outputPer1M ?? 15,
    };
  }

  const lowerModel = model.toLowerCase();
  for (const [key, val] of Object.entries(modelPricingConfig)) {
    if (lowerModel.includes(key.toLowerCase())) {
      return { inputPer1M: val.inputPer1M ?? 3, outputPer1M: val.outputPer1M ?? 15 };
    }
  }

  return { inputPer1M: 3, outputPer1M: 15 };
}

function calculateCost(model: string, usage: UsageEvent["usage"]): number {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const p = lookupPricing(model);
  return (input * p.inputPer1M + output * p.outputPer1M) / 1_000_000;
}

// ── Collector ──

export class TokenStatsCollector {
  private data: TokenStatsData;
  private filePath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_STATS_PATH;
    this.data = emptyStats();
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TokenStatsData>;
      this.data = {
        lifetime: {
          total: { ...emptyBucket(), ...parsed.lifetime?.total },
          byScenario: parsed.lifetime?.byScenario ?? {},
          byProvider: parsed.lifetime?.byProvider ?? {},
          byTier: parsed.lifetime?.byTier ?? {},
          byRole: (parsed.lifetime as any)?.byRole ?? {},
        },
        hourly: Array.isArray(parsed.hourly) ? parsed.hourly : [],
        sessions: (parsed.sessions && typeof parsed.sessions === "object") ? parsed.sessions : {},
        startedAt: parsed.startedAt ?? Date.now(),
        lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
      };
    } catch {
      this.data = emptyStats();
    }
  }

  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.flush().catch(() => {});
    }, 300_000);
    if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      (this.flushTimer as NodeJS.Timeout).unref();
    }
  }

  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  record(event: UsageEvent): void {
    const now = Date.now();
    const cost = calculateCost(event.model, event.usage);

    const role = event.isSubagent ? "sub" : "main";

    // Lifetime totals
    addToBucket(this.data.lifetime.total, event.usage, cost);
    addToBucket(ensureBucket(this.data.lifetime.byScenario, event.scenarioType), event.usage, cost);
    addToBucket(ensureBucket(this.data.lifetime.byProvider, event.provider), event.usage, cost);
    addToBucket(ensureBucket(this.data.lifetime.byRole, role), event.usage, cost);
    if (event.tier) {
      addToBucket(ensureBucket(this.data.lifetime.byTier, event.tier), event.usage, cost);
    }

    // Hourly bucket
    const hourKey = currentHourKey();
    let hourly = this.data.hourly.find((h) => h.hour === hourKey);
    if (!hourly) {
      hourly = { hour: hourKey, byScenario: {}, byProvider: {}, byTier: {}, byRole: {}, total: emptyBucket() };
      this.data.hourly.push(hourly);
      if (this.data.hourly.length > MAX_HOURLY_BUCKETS) {
        this.data.hourly = this.data.hourly.slice(-MAX_HOURLY_BUCKETS);
      }
    }
    addToBucket(hourly.total, event.usage, cost);
    addToBucket(ensureBucket(hourly.byScenario, event.scenarioType), event.usage, cost);
    addToBucket(ensureBucket(hourly.byProvider, event.provider), event.usage, cost);
    addToBucket(ensureBucket(hourly.byRole, role), event.usage, cost);
    if (event.tier) {
      addToBucket(ensureBucket(hourly.byTier, event.tier), event.usage, cost);
    }

    // Session-level tracking
    if (event.sessionId) {
      let sess = this.data.sessions[event.sessionId];
      if (!sess) {
        sess = {
          sessionId: event.sessionId,
          total: emptyBucket(),
          byScenario: {},
          byTier: {},
          byRole: {},
          byModel: {},
          requestLog: [],
          firstSeenAt: now,
          lastActiveAt: now,
        };
        this.data.sessions[event.sessionId] = sess;
      }
      if (!sess.byRole) sess.byRole = {};
      if (!sess.byModel) sess.byModel = {};
      sess.lastActiveAt = now;
      addToBucket(sess.total, event.usage, cost);
      addToBucket(ensureBucket(sess.byScenario, event.scenarioType), event.usage, cost);
      addToBucket(ensureBucket(sess.byRole, role), event.usage, cost);
      addToBucket(ensureBucket(sess.byModel, event.model), event.usage, cost);
      if (event.tier) {
        addToBucket(ensureBucket(sess.byTier, event.tier), event.usage, cost);
      }

      if (!sess.requestLog) sess.requestLog = [];
      const totalTokens = (event.usage?.input ?? 0) + (event.usage?.output ?? 0) + (event.usage?.cacheRead ?? 0);
      sess.requestLog.push({
        ts: now,
        role,
        tier: event.tier,
        model: event.model,
        tokens: totalTokens,
        cost,
        query: event.querySnippet,
      });
      if (sess.requestLog.length > 100) sess.requestLog = sess.requestLog.slice(-100);

      this.evictOldSessions();
    }

    this.data.lastUpdatedAt = now;
    this.dirty = true;
  }

  private evictOldSessions(): void {
    const keys = Object.keys(this.data.sessions);
    if (keys.length <= MAX_SESSIONS) return;
    const sorted = keys.sort(
      (a, b) => this.data.sessions[a].lastActiveAt - this.data.sessions[b].lastActiveAt,
    );
    const toRemove = sorted.slice(0, keys.length - MAX_SESSIONS);
    for (const k of toRemove) delete this.data.sessions[k];
  }

  getStats(): TokenStatsData {
    return this.data;
  }

  getSummary() {
    return {
      lifetime: this.data.lifetime,
      lastUpdatedAt: this.data.lastUpdatedAt,
      startedAt: this.data.startedAt,
    };
  }

  getHourly(): HourlyBucket[] {
    return this.data.hourly;
  }

  getSessionStats(): SessionTokenStats[] {
    return Object.values(this.data.sessions).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
  }

  async reset(): Promise<void> {
    this.data = emptyStats();
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Non-critical
    }
  }
}

// ── Singleton ──

let globalStatsCollector: TokenStatsCollector | null = null;

export function setGlobalStatsCollector(collector: TokenStatsCollector): void {
  globalStatsCollector = collector;
}

export function getGlobalStatsCollector(): TokenStatsCollector | null {
  return globalStatsCollector;
}
