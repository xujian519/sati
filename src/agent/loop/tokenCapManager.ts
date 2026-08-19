/**
 * AgentLoop token caps 状态管理（从 AgentLoop.ts 拆出，轮次 2）。
 *
 * 封装 transientTokenCaps（每 turn 的临时 token 上限）与模型 token 限额
 * 查询。无 AgentLoop 依赖，可独立测试。
 */

import type { CanonicalModelRequest } from "../../model/index.js";

/** 单条 transient cap 记录（provider/model 维度）。 */
export type TransientTokenCap = {
  maxContextTokens?: number;
  requestedMaxOutputTokens?: number;
  attemptMaxOutputTokens?: number;
  hardMaxOutputTokens?: number;
};

/** AgentLoop config 中参与 token 计算的字段。 */
export type TokenCapConfig = {
  provider: string;
  model: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /** Marks the agent as a subagent. When set with subagentModel, parent config caps are ignored. */
  isSubagent?: boolean;
  /** Optional default model/caps for forked subagents. Omitted means inherit this agent's model. */
  subagentModel?: {
    provider: string;
    model: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  };
};

/** AgentLoop dependencies 中提供模型 token 限额的查询函数。 */
export type TokenCapDependencies = {
  getModelTokenLimits?: (
    provider: string,
    model: string,
  ) => { maxContextTokens?: number; maxOutputTokens?: number } | undefined;
  getModelMaxContextTokens?: (provider: string, model: string) => number | undefined;
  getModelMaxOutputTokens?: (provider: string, model: string) => number | undefined;
};

export class TokenCapManager {
  private readonly transientTokenCaps = new Map<string, TransientTokenCap>();

  constructor(
    private readonly config: TokenCapConfig,
    private readonly dependencies: TokenCapDependencies,
  ) {}

  private tokenCapKey(provider: string, model: string): string {
    return `${provider}/${model}`;
  }

  getModelTokenLimits(
    provider: string,
    model: string,
  ): { maxContextTokens?: number; maxOutputTokens?: number } | undefined {
    const combined = this.dependencies.getModelTokenLimits?.(provider, model);
    if (combined) return combined;
    const maxContextTokens = this.dependencies.getModelMaxContextTokens?.(provider, model);
    const maxOutputTokens = this.dependencies.getModelMaxOutputTokens?.(provider, model);
    if (maxContextTokens === undefined && maxOutputTokens === undefined) return undefined;
    return { maxContextTokens, maxOutputTokens };
  }

  currentMaxContextTokens(provider: string, model: string): number {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model))?.maxContextTokens;
    // getModelTokenLimits 内部已覆盖旧 API（getModelMaxContextTokens 兜底），
    // 只查一次避免新旧 API 双查询且优先级相反。
    return (
      transient ??
      this.getBaselineSubagentTokenLimits(provider, model)?.maxContextTokens ??
      this.currentConfigMaxContextTokens() ??
      this.getModelTokenLimits(provider, model)?.maxContextTokens ??
      1_000_000
    );
  }

  /** Pre-routing baseline: subagents with an explicit model override skip parent caps entirely. */
  preRoutingMaxContextTokens(): number {
    if (this.config.isSubagent && this.config.subagentModel) {
      return 1_000_000;
    }
    return this.currentMaxContextTokens(this.config.provider, this.config.model);
  }

  currentMaxOutputTokens(provider: string, model: string): number | undefined {
    const transient = this.transientTokenCaps.get(this.tokenCapKey(provider, model));
    const modelMaxOutputTokens = this.getModelTokenLimits(provider, model)?.maxOutputTokens;
    const requested =
      transient?.attemptMaxOutputTokens ??
      transient?.requestedMaxOutputTokens ??
      this.getBaselineSubagentTokenLimits(provider, model)?.maxOutputTokens ??
      this.currentConfigMaxOutputTokens();
    const candidates = [requested, transient?.hardMaxOutputTokens].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
    );
    if (
      candidates.length > 0 &&
      typeof modelMaxOutputTokens === "number" &&
      Number.isFinite(modelMaxOutputTokens) &&
      modelMaxOutputTokens > 0
    ) {
      candidates.push(modelMaxOutputTokens);
    }
    return candidates.length > 0 ? Math.min(...candidates.map(value => Math.floor(value))) : undefined;
  }

  private getBaselineSubagentTokenLimits(
    provider: string,
    model: string,
  ): { maxContextTokens?: number; maxOutputTokens?: number } | undefined {
    if (this.config.isSubagent !== true) {
      return undefined;
    }
    const baseline = this.config.subagentModel;
    if (!baseline || baseline.provider !== provider || baseline.model !== model) {
      return undefined;
    }
    return {
      maxContextTokens: baseline.maxContextTokens,
      maxOutputTokens: baseline.maxOutputTokens,
    };
  }

  private currentConfigMaxContextTokens(): number | undefined {
    if (this.config.isSubagent && this.config.subagentModel) {
      return undefined;
    }
    return this.config.maxContextTokens;
  }

  private currentConfigMaxOutputTokens(): number | undefined {
    if (this.config.isSubagent && this.config.subagentModel) {
      return undefined;
    }
    return this.config.maxOutputTokens;
  }

  getReservedOutputTokens(provider?: string, model?: string): number {
    if (provider && model) {
      return this.currentMaxOutputTokens(provider, model) ?? 0;
    }
    return this.currentMaxOutputTokens(this.config.provider, this.config.model) ?? 0;
  }

  setTransientTokenCap(provider: string, model: string, cap: TransientTokenCap): void {
    const key = this.tokenCapKey(provider, model);
    const previous = this.transientTokenCaps.get(key) ?? {};
    this.transientTokenCaps.set(key, { ...previous, ...cap });
  }

  clearAttemptOutputTokenCap(provider: string, model: string): void {
    const key = this.tokenCapKey(provider, model);
    const previous = this.transientTokenCaps.get(key);
    if (!previous || previous.attemptMaxOutputTokens === undefined) return;
    const { attemptMaxOutputTokens: _attemptMaxOutputTokens, ...rest } = previous;
    this.transientTokenCaps.set(key, rest);
  }

  /** 清除 turn 级临时 cap（requested/attempt），保留 session 级（maxContext/hardMax）。 */
  clearTurnScopedTokenCaps(): void {
    for (const [key, cap] of this.transientTokenCaps) {
      const {
        requestedMaxOutputTokens: _requestedMaxOutputTokens,
        attemptMaxOutputTokens: _attemptMaxOutputTokens,
        ...sessionCaps
      } = cap;
      if (sessionCaps.maxContextTokens === undefined && sessionCaps.hardMaxOutputTokens === undefined) {
        this.transientTokenCaps.delete(key);
      } else {
        this.transientTokenCaps.set(key, sessionCaps);
      }
    }
  }

  applyTokenCapsToRequest(request: CanonicalModelRequest, provider: string, model: string): CanonicalModelRequest {
    return {
      ...request,
      provider,
      model,
      maxOutputTokens: this.currentMaxOutputTokens(provider, model),
    };
  }
}
