import type { CanonicalMessage } from "../../model/index.js";
import type { SatiHookEvent } from "../../extension/hooks/protocol/events.js";
import type { SatiHookBaseInput } from "../../extension/hooks/protocol/input.js";
import type { SatiHookEffect, SatiLifecycleError } from "./effects.js";

export type LifecycleDispatchInput = {
  event: SatiHookEvent;
  baseInput: SatiHookBaseInput;
  payload?: Record<string, unknown>;
  matchQuery?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export type LifecycleDispatchResult = {
  effects: SatiHookEffect[];
  messages: CanonicalMessage[];
  events: unknown[];
  blockingErrors: SatiLifecycleError[];
  nonBlockingErrors: SatiLifecycleError[];
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
