/**
 * Environment hooks wiring the replay seam into the product runtime (phase 4, T1).
 *
 * SATI_LLM_REPLAY_RECORD_ROOT wraps the gateway model runtime with the
 * recorder, so a real session run records its streams for later playback.
 * SATI_LLM_REPLAY_ROOT wraps it with the replay runtime, so a real product
 * assembly replays a fixture without an API key (CI smoke runs, E2E). Setting
 * both is a configuration error and fails loud.
 */
import type { ModelRuntime } from "../../model/index.js";
import { createRecordingModelRuntime } from "./record.js";
import { createReplayModelRuntime } from "./replay.js";

/** Environment variable naming the fixture directory the runtime records into. */
export const REPLAY_RECORD_ROOT_ENV = "SATI_LLM_REPLAY_RECORD_ROOT";
/** Environment variable naming the fixture directory the runtime replays from. */
export const REPLAY_ROOT_ENV = "SATI_LLM_REPLAY_ROOT";

/**
 * Apply the replay-seam environment hooks to a runtime, if any are set.
 *
 * @param runtime - the production runtime to wrap.
 * @param env - process environment to read; defaults to process.env.
 * @returns the wrapped runtime, or the input unchanged when neither hook is set.
 */
export function applyReplayEnvHooks(runtime: ModelRuntime, env: NodeJS.ProcessEnv = process.env): ModelRuntime {
  const recordRoot = env[REPLAY_RECORD_ROOT_ENV];
  const replayRoot = env[REPLAY_ROOT_ENV];
  if (recordRoot !== undefined && replayRoot !== undefined) {
    throw new Error(
      "set only one of " +
        REPLAY_RECORD_ROOT_ENV +
        " and " +
        REPLAY_ROOT_ENV +
        "; recording and replaying together is unsupported",
    );
  }
  if (recordRoot !== undefined) {
    return createRecordingModelRuntime(runtime, recordRoot);
  }
  if (replayRoot !== undefined) {
    return createReplayModelRuntime(replayRoot, runtime);
  }
  return runtime;
}
