/**
 * Recording side of the LLM replay seam (phase 4, T1).
 *
 * createRecordingModelRuntime wraps a real ModelRuntime and appends one JSONL
 * record per stream call: the stable request key, a human-readable summary,
 * and every canonical event the stream yielded (raw payloads stripped). The
 * companion manifest.json is rewritten atomically (temp file + rename) so a
 * crash never leaves a torn manifest beside a valid records.jsonl.
 *
 * Recording is live: run the product with SATI_LLM_REPLAY_RECORD_ROOT set
 * (see envHooks.ts), exercise a real session, then commit the fixture
 * directory. Records are appended in stream completion order, which is the
 * order the replay runtime consumes them for repeated identical requests.
 */
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanonicalModelEvent, ModelRuntime } from "../../model/index.js";
import { replayRequestKey, requestSummary, stableSerialize } from "./requestKey.js";
import type { ReplayManifest, ReplayManifestRecord, ReplayRecord } from "./types.js";

/** Name of the JSONL file holding recorded streams. */
export const REPLAY_RECORDS_FILENAME = "records.jsonl";
/** Name of the human-readable index rewritten beside records.jsonl. */
export const REPLAY_MANIFEST_FILENAME = "manifest.json";

/**
 * Wrap a model runtime so every stream call is recorded to a fixture directory.
 * complete/capability calls pass through untouched (the agent loop drives
 * streaming); a stream that throws still records the events it produced.
 *
 * @param inner - the real runtime to observe.
 * @param outDir - directory receiving records.jsonl and manifest.json.
 * @returns a runtime with identical behavior plus the recording side effect.
 */
export function createRecordingModelRuntime(inner: ModelRuntime, outDir: string): ModelRuntime {
  const recordsPath = join(outDir, REPLAY_RECORDS_FILENAME);
  const manifestPath = join(outDir, REPLAY_MANIFEST_FILENAME);
  const manifest: ReplayManifest = { formatVersion: 1, records: [] };
  let nextIndex = 0;
  let writeChain: Promise<void> = Promise.resolve();

  async function persistRecord(record: ReplayRecord): Promise<void> {
    const manifestRecord: ReplayManifestRecord = {
      index: record.index,
      key: record.key,
      provider: record.provider,
      model: record.model,
      toolNames: record.toolNames,
      userTexts: record.userTexts,
      eventCount: record.events.length,
    };
    manifest.records.push(manifestRecord);
    const tempManifestPath = manifestPath + ".tmp";
    await mkdir(outDir, { recursive: true });
    await appendFile(recordsPath, stableSerialize(record) + "\n", "utf8");
    await writeFile(tempManifestPath, stableSerialize(manifest), "utf8");
    await rename(tempManifestPath, manifestPath);
  }

  return {
    async *stream(request, options) {
      const events: CanonicalModelEvent[] = [];
      try {
        for await (const event of inner.stream(request, options)) {
          events.push(event);
          yield event;
        }
      } finally {
        const summary = requestSummary(request);
        const record: ReplayRecord = {
          index: nextIndex++,
          key: replayRequestKey(request),
          provider: request.provider,
          model: request.model,
          toolNames: summary.toolNames,
          userTexts: summary.userTexts,
          events,
        };
        // 串行化写入但吞掉历史拒绝：一次写失败只让本流的 finally 抛错
        // （fail-loud），不会毒化链上后续流的 await。
        writeChain = writeChain.catch(() => undefined).then(() => persistRecord(record));
        await writeChain;
      }
    },
    complete: (request, options) => inner.complete(request, options),
    getCapabilities: (providerId, modelId) => inner.getCapabilities(providerId, modelId),
    getMultimodal: (providerId, modelId) => inner.getMultimodal(providerId, modelId),
    getProviderProtocol: providerId => inner.getProviderProtocol(providerId),
    getProviderBaseUrl: providerId => inner.getProviderBaseUrl(providerId),
  };
}
