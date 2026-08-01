export type { SatiLifecycleHookEvent } from "./protocol/events.js";
export type {
  SatiHookEffect,
  SatiHookPermissionBehavior,
  SatiLifecycleError,
  SatiPermissionRequestResult,
} from "./protocol/effects.js";
export type { LifecycleDispatchInput, LifecycleDispatchResult } from "./protocol/payloads.js";
export { emptyLifecycleDispatchResult } from "./protocol/payloads.js";
export { SatiLifecycleRuntimeError } from "./protocol/errors.js";
export { LifecycleRuntime, NullLifecycleRuntime } from "./runtime/LifecycleRuntime.js";
export type { LifecycleObserver } from "./runtime/LifecycleObserver.js";
