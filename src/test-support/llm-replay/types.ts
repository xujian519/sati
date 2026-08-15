/**
 * Shared record and error vocabulary for the LLM replay test seam (phase 4, T1).
 *
 * The recorder captures canonical model streams with provider `raw` payloads
 * stripped, so every persisted value is lossless JSON. The replay runtime
 * serves those streams back into a real router/agent-loop assembly without an
 * API key. Overrides are addressed by record index, never by key, so fixture
 * authors edit a human-readable manifest instead of a hash.
 */
import type { CanonicalModelEvent } from "../../model/index.js";

/** One recorded model stream: the stable request key plus every event it yielded. */
export type ReplayRecord = {
  /** 0-based position of this record in the fixture; overrides target it. */
  index: number;
  /** Stable content key computed by {@link replayRequestKey}; replay matches requests through it. */
  key: string;
  provider: string;
  model: string;
  /** Tool names present in the request, for human-readable manifests and failure messages. */
  toolNames: string[];
  /** Truncated user-role text of the request, for fixture review. */
  userTexts: string[];
  /** The full canonical event stream; provider `raw` payloads stripped. */
  events: CanonicalModelEvent[];
};

/** Manifest entry: the record summary without its event payload. */
export type ReplayManifestRecord = Omit<ReplayRecord, "events"> & {
  eventCount: number;
};

/** Human-readable fixture index written beside records.jsonl by the recorder. */
export type ReplayManifest = {
  formatVersion: 1;
  records: ReplayManifestRecord[];
};

/** How a replayed stream may be forced to misbehave. */
export type ReplayOverrideMode = "throw" | "hang";

/** One injected failure addressed to a recorded stream by its manifest index. */
export type ReplayOverride = {
  record: number;
  mode: ReplayOverrideMode;
  /** Required for "throw": the error message the replayed stream raises. */
  message?: string;
};

/** Shape of the sidecar file replay.override.json next to records.jsonl. */
export type ReplayOverrideFile = {
  overrides?: ReplayOverride[];
};

/** Stable failure codes thrown by the replay seam; consumers branch on code, never message. */
export type ReplayErrorCode = "NO_REPLAY_RECORD" | "FIXTURE_INVALID" | "OVERRIDE_INVALID";

/** Structured failure of the replay seam itself (fixture problems, not replayed failures). */
export class ReplayError extends Error {
  readonly code: ReplayErrorCode;

  constructor(code: ReplayErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReplayError";
    this.code = code;
  }
}

/** Narrow a caught value to a replay-seam failure. */
export function isReplayError(error: unknown): error is ReplayError {
  return error instanceof ReplayError;
}
