export type { PolitDeckLifecycleHookEvent } from "./protocol/events.js";
export type {
  PolitDeckHookEffect,
  PolitDeckHookPermissionBehavior,
  PolitDeckLifecycleError,
  PolitDeckPermissionRequestResult,
} from "./protocol/effects.js";
export type { LifecycleDispatchInput, LifecycleDispatchResult } from "./protocol/payloads.js";
export { emptyLifecycleDispatchResult } from "./protocol/payloads.js";
export { PolitDeckLifecycleRuntimeError } from "./protocol/errors.js";
export { LifecycleRuntime, NullLifecycleRuntime } from "./runtime/LifecycleRuntime.js";
export type { LifecycleObserver } from "./runtime/LifecycleObserver.js";
