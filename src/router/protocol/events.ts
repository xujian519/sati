import type { CanonicalModelError } from "../../model/index.js";
import type { RouterDecision, RouterScenarioType } from "./decision.js";

export type RouterDecisionEvent = {
  type: "sati_router_decision";
  sessionId: string;
  turnId?: string;
  decision: RouterDecision;
};

export type RouterFallbackEvent = {
  type: "sati_router_fallback";
  sessionId: string;
  turnId?: string;
  scenarioType: RouterScenarioType;
  attempt: number;
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  error: CanonicalModelError;
};

export type RouterZeroUsageRetryEvent = {
  type: "sati_router_zero_usage_retry";
  sessionId: string;
  turnId?: string;
  attempt: number;
  provider: string;
  model: string;
};

export type RouterTokenSaverFailedEvent = {
  type: "sati_router_token_saver_failed";
  sessionId: string;
  turnId?: string;
  reason: "timeout" | "model_error" | "parse_error";
  fallbackTier: string;
};

export type RouterCustomFailedEvent = {
  type: "sati_router_custom_failed";
  sessionId: string;
  turnId?: string;
  extensionId: string;
  reason: string;
};

export type RouterExecuteFailedEvent = {
  type: "sati_router_execute_failed";
  sessionId: string;
  turnId?: string;
  scenarioType: RouterScenarioType;
  provider: string;
  model: string;
  error: CanonicalModelError;
};

export type RouterTransientRetryEvent = {
  type: "sati_router_transient_retry";
  sessionId: string;
  turnId?: string;
  attempt: number;
  delayMs: number;
  provider: string;
  model: string;
  errorCode: string;
};

export type RouterRetryProgressEvent = {
  type: "sati_router_retry_progress";
  sessionId: string;
  turnId?: string;
  /** 阶段四 T4.2：稳定重试 id（同一请求内跨尝试稳定）。 */
  retryId?: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: "rate_limit" | "server_error" | "network_error" | "zero_usage" | "overloaded" | "continuation";
  provider: string;
  model: string;
};

export type RouterEvent =
  | RouterDecisionEvent
  | RouterFallbackEvent
  | RouterZeroUsageRetryEvent
  | RouterTokenSaverFailedEvent
  | RouterCustomFailedEvent
  | RouterExecuteFailedEvent
  | RouterTransientRetryEvent
  | RouterRetryProgressEvent;

export type RouterEventBus = {
  emit(event: RouterEvent): void;
  /** M4：同步落盘缓冲（dispose/退出收尾用）。可选——实现可不提供。 */
  flush?: () => void;
};
