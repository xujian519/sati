import type { CanonicalMessage } from "../../model/index.js";
import type { PolitDeckHookEvent } from "../../extension/hooks/protocol/events.js";
import type { PolitDeckHookBaseInput } from "../../extension/hooks/protocol/input.js";
import type { PolitDeckHookEffect, PolitDeckLifecycleError } from "./effects.js";

export type LifecycleDispatchInput = {
  event: PolitDeckHookEvent;
  baseInput: PolitDeckHookBaseInput;
  payload?: Record<string, unknown>;
  matchQuery?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export type LifecycleDispatchResult = {
  effects: PolitDeckHookEffect[];
  messages: CanonicalMessage[];
  events: unknown[];
  blockingErrors: PolitDeckLifecycleError[];
  nonBlockingErrors: PolitDeckLifecycleError[];
};

export function emptyLifecycleDispatchResult(): LifecycleDispatchResult {
  return {
    effects: [],
    messages: [],
    events: [],
    blockingErrors: [],
    nonBlockingErrors: [],
  };
}
