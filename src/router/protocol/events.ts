import type { CanonicalModelError } from "../../model/index.js";
import type { RouterDecision, RouterScenarioType } from "./decision.js";

export type RouterDecisionEvent = {
  type: "politdeck_router_decision";
  sessionId: string;
  turnId?: string;
  decision: RouterDecision;
};

export type RouterFallbackEvent = {
  type: "politdeck_router_fallback";
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
  type: "politdeck_router_zero_usage_retry";
  sessionId: string;
  turnId?: string;
  attempt: number;
  provider: string;
  model: string;
};

export type RouterTokenSaverFailedEvent = {
  type: "politdeck_router_token_saver_failed";
  sessionId: string;
  turnId?: string;
  reason: "timeout" | "model_error" | "parse_error";
  fallbackTier: string;
};

export type RouterCustomFailedEvent = {
  type: "politdeck_router_custom_failed";
  sessionId: string;
  turnId?: string;
  extensionId: string;
  reason: string;
};

export type RouterExecuteFailedEvent = {
  type: "politdeck_router_execute_failed";
  sessionId: string;
  turnId?: string;
  scenarioType: RouterScenarioType;
  provider: string;
  model: string;
  error: CanonicalModelError;
};

export type RouterEvent =
  | RouterDecisionEvent
  | RouterFallbackEvent
  | RouterZeroUsageRetryEvent
  | RouterTokenSaverFailedEvent
  | RouterCustomFailedEvent
  | RouterExecuteFailedEvent;

export type RouterEventBus = {
  emit(event: RouterEvent): void;
};
