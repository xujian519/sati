/**
 * Replay side of the LLM replay seam (phase 4, T1).
 *
 * createReplayModelRuntime loads a recorded fixture and serves one stream per
 * matched request through a FIFO per stable request key, so a test replays the
 * exact sequence the recorder observed, including repeated identical requests.
 * The fixture is the source of truth: an unmatched request fails loud
 * (NO_REPLAY_RECORD) instead of being answered by the real network, and
 * assertAllConsumed catches tests that drive fewer streams than they recorded.
 *
 * Capability queries delegate to the base runtime, so router modality and
 * context-window checks keep working exactly as they do in production.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
  ModelRuntimeOptions,
} from "../../model/index.js";
import { loadReplayOverrides } from "./overrides.js";
import { REPLAY_RECORDS_FILENAME } from "./record.js";
import { replayRequestKey, requestSummary } from "./requestKey.js";
import { ReplayError, type ReplayRecord } from "./types.js";

/** ModelRuntime plus the consumption assertions replay tests need. */
export type ReplayModelRuntime = ModelRuntime & {
  /** Throw when any recorded stream was never consumed by the test. */
  assertAllConsumed(): void;
  /** Indices of recorded streams the test never drove. */
  unconsumedRecords(): number[];
};

/**
 * Build a replay runtime over a fixture directory.
 *
 * @param fixtureDir - directory with records.jsonl and the optional override sidecar.
 * @param base - runtime answering capability/catalog queries; also backs complete().
 * @returns the replay runtime; load errors throw ReplayError(FIXTURE_INVALID).
 */
export function createReplayModelRuntime(fixtureDir: string, base: ModelRuntime): ReplayModelRuntime {
  const records = loadRecords(fixtureDir);
  const byKey = new Map<string, number[]>();
  for (const record of records) {
    const queue = byKey.get(record.key) ?? [];
    queue.push(record.index);
    byKey.set(record.key, queue);
  }
  const byIndex = new Map(records.map(record => [record.index, record] as const));
  const overrides = loadReplayOverrides(fixtureDir, records.length);
  const consumed = new Set<number>();

  /** Record indices the test has not driven yet. */
  function unconsumedIndices(): number[] {
    return records.map(record => record.index).filter(index => !consumed.has(index));
  }

  async function* replayStream(
    request: CanonicalModelRequest,
    options: ModelRuntimeOptions | undefined,
  ): AsyncGenerator<CanonicalModelEvent> {
    const key = replayRequestKey(request);
    const queue = byKey.get(key);
    const index = queue?.shift();
    if (index === undefined) {
      const summary = requestSummary(request);
      throw new ReplayError(
        "NO_REPLAY_RECORD",
        "no recorded stream matches this request (provider " +
          request.provider +
          ", model " +
          request.model +
          ", tools [" +
          summary.toolNames.join(", ") +
          "]); record a fresh fixture or update the test to drive the recorded requests",
      );
    }
    consumed.add(index);
    const record = byIndex.get(index);
    if (record === undefined) {
      throw new ReplayError("FIXTURE_INVALID", "record index " + index + " missing from fixture");
    }
    const override = overrides.get(index);
    if (override?.mode === "throw") {
      throw new Error(override.message ?? "replay override: injected failure");
    }
    if (override?.mode === "hang") {
      await hangUntilAborted(options?.signal);
      return;
    }
    yield* record.events;
  }

  return {
    stream: replayStream,
    complete: (request, options) => base.complete(request, options),
    getCapabilities: (providerId, modelId) => base.getCapabilities(providerId, modelId),
    getMultimodal: (providerId, modelId) => base.getMultimodal(providerId, modelId),
    getProviderProtocol: providerId => base.getProviderProtocol(providerId),
    getProviderBaseUrl: providerId => base.getProviderBaseUrl(providerId),
    assertAllConsumed() {
      const unconsumed = unconsumedIndices();
      if (unconsumed.length > 0) {
        throw new ReplayError(
          "NO_REPLAY_RECORD",
          "the test never drove " + unconsumed.length + " recorded stream(s): " + unconsumed.join(", "),
        );
      }
    },
    unconsumedRecords: unconsumedIndices,
  };
}

/** Parse and validate records.jsonl into indexed records. */
function loadRecords(fixtureDir: string): ReplayRecord[] {
  let text: string;
  try {
    text = readFileSync(join(fixtureDir, REPLAY_RECORDS_FILENAME), "utf8");
  } catch (error) {
    throw new ReplayError("FIXTURE_INVALID", "cannot read " + REPLAY_RECORDS_FILENAME + " from " + fixtureDir, {
      cause: error,
    });
  }
  const records: ReplayRecord[] = [];
  let lineNumber = 0;
  for (const line of text.split("\n")) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ReplayError("FIXTURE_INVALID", "invalid JSON at " + REPLAY_RECORDS_FILENAME + " line " + lineNumber, {
        cause: error,
      });
    }
    const record = validateRecord(parsed, lineNumber);
    if (records.some(existing => existing.index === record.index)) {
      throw new ReplayError(
        "FIXTURE_INVALID",
        "duplicate record index " + record.index + " in " + REPLAY_RECORDS_FILENAME,
      );
    }
    records.push(record);
  }
  if (records.length === 0) {
    throw new ReplayError("FIXTURE_INVALID", "fixture " + fixtureDir + " holds no records");
  }
  return records;
}

/** Structural validation for one parsed JSONL line. */
function validateRecord(value: unknown, lineNumber: number): ReplayRecord {
  const where = REPLAY_RECORDS_FILENAME + " line " + lineNumber + ": ";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReplayError("FIXTURE_INVALID", where + "record must be a JSON object");
  }
  const record = value as Partial<ReplayRecord>;
  if (typeof record.index !== "number" || !Number.isInteger(record.index)) {
    throw new ReplayError("FIXTURE_INVALID", where + "record.index must be an integer");
  }
  if (typeof record.key !== "string" || record.key.length === 0) {
    throw new ReplayError("FIXTURE_INVALID", where + "record.key must be a non-empty string");
  }
  if (typeof record.provider !== "string" || typeof record.model !== "string") {
    throw new ReplayError("FIXTURE_INVALID", where + "record.provider/model must be strings");
  }
  if (!Array.isArray(record.events)) {
    throw new ReplayError("FIXTURE_INVALID", where + "record.events must be an array");
  }
  return record as ReplayRecord;
}

/** Suspend the stream until the caller's signal aborts, then reject with its reason. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return Promise.reject(
      new ReplayError("OVERRIDE_INVALID", "a 'hang' override requires the caller to pass an abort signal"),
    );
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? abortError());
  }
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? abortError()), { once: true });
  });
}

/** Abort reason used when the signal carries none. */
function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
