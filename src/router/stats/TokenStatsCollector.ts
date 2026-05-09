import type { CanonicalUsage } from "../../model/index.js";
import type { RouterStatsConfig } from "../config/schema.js";
import type { RouterDecision } from "../protocol/decision.js";

export type RouterStatsRecord = {
  sessionId: string;
  scenarioType: RouterDecision["scenarioType"];
  resolvedFrom: RouterDecision["resolvedFrom"];
  provider: string;
  model: string;
  usage: CanonicalUsage;
  startedAt: string;
  endedAt: string;
};

export type RouterStatsAggregate = {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  perScenario: Record<string, number>;
  perModel: Record<string, number>;
};

export class TokenStatsCollector {
  private readonly enabled: boolean;
  private records: RouterStatsRecord[] = [];
  private aggregate: RouterStatsAggregate = createAggregate();

  constructor(config: RouterStatsConfig | undefined) {
    this.enabled = config?.enabled ?? false;
  }

  observe(record: RouterStatsRecord): void {
    if (!this.enabled) {
      return;
    }
    this.records.push(record);
    this.aggregate.totalRequests += 1;
    this.aggregate.totalInputTokens += record.usage.inputTokens ?? 0;
    this.aggregate.totalOutputTokens += record.usage.outputTokens ?? 0;
    this.aggregate.perScenario[record.scenarioType] =
      (this.aggregate.perScenario[record.scenarioType] ?? 0) + 1;
    const modelKey = `${record.provider}/${record.model}`;
    this.aggregate.perModel[modelKey] = (this.aggregate.perModel[modelKey] ?? 0) + 1;
  }

  snapshot(): RouterStatsAggregate {
    return {
      ...this.aggregate,
      perScenario: { ...this.aggregate.perScenario },
      perModel: { ...this.aggregate.perModel },
    };
  }

  recent(limit = 50): RouterStatsRecord[] {
    return this.records.slice(-limit);
  }

  clear(): void {
    this.records = [];
    this.aggregate = createAggregate();
  }
}

function createAggregate(): RouterStatsAggregate {
  return {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    perScenario: {},
    perModel: {},
  };
}
