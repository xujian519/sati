/**
 * LLM replay test seam (phase 4, T1): record real model streams once, replay
 * them in tests without an API key.
 *
 * Recording: run the product with SATI_LLM_REPLAY_RECORD_ROOT=<dir> and
 * exercise a session; records.jsonl + manifest.json land in the directory.
 * Replay: build a replay runtime over the fixture and hand it to the router
 * (createRouterRuntime deps.modelRuntime); tests drive the same requests and
 * the recorded streams come back. Sidecar replay.override.json injects per-
 * record throw/hang failures; assertAllConsumed catches under-driven tests.
 */
export {
  REPLAY_MANIFEST_FILENAME,
  REPLAY_RECORDS_FILENAME,
  createRecordingModelRuntime,
} from "./record.js";
export {
  createReplayModelRuntime,
  type ReplayModelRuntime,
} from "./replay.js";
export { loadReplayOverrides } from "./overrides.js";
export {
  replayRequestKey,
  requestSummary,
  stableSerialize,
} from "./requestKey.js";
export {
  REPLAY_RECORD_ROOT_ENV,
  REPLAY_ROOT_ENV,
  applyReplayEnvHooks,
} from "./envHooks.js";
export {
  ReplayError,
  isReplayError,
  type ReplayErrorCode,
  type ReplayManifest,
  type ReplayManifestRecord,
  type ReplayOverride,
  type ReplayOverrideFile,
  type ReplayOverrideMode,
  type ReplayRecord,
} from "./types.js";
