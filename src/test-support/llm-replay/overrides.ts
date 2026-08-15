/**
 * Sidecar override loading for the LLM replay seam (phase 4, T1).
 *
 * replay.override.json sits beside records.jsonl and forces one recorded
 * stream to throw or hang when the test drives it. Unknown fields are ignored
 * (forward compatibility); out-of-range record indices and duplicates fail
 * loud so a rename never silently detaches an override.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReplayError, type ReplayOverride } from "./types.js";

const OVERRIDE_MODES = new Set(["throw", "hang"]);

/**
 * Load and validate the override sidecar for a fixture directory.
 *
 * @param fixtureDir - directory holding records.jsonl and the optional sidecar.
 * @param recordCount - number of records in the fixture, for index bounds.
 * @returns a map from record index to its override; empty when no sidecar exists.
 */
export function loadReplayOverrides(fixtureDir: string, recordCount: number): Map<number, ReplayOverride> {
  const path = join(fixtureDir, "replay.override.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw new ReplayError("FIXTURE_INVALID", "cannot parse replay.override.json", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReplayError("OVERRIDE_INVALID", "replay.override.json must be a JSON object");
  }
  const rawOverrides = (parsed as { overrides?: unknown }).overrides;
  if (rawOverrides === undefined) {
    return new Map();
  }
  if (!Array.isArray(rawOverrides)) {
    throw new ReplayError("OVERRIDE_INVALID", "replay.override.json field 'overrides' must be an array");
  }
  const result = new Map<number, ReplayOverride>();
  for (const item of rawOverrides) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ReplayError("OVERRIDE_INVALID", "each override must be a JSON object");
    }
    const record = item.record;
    const mode = item.mode;
    const message = item.message;
    if (typeof record !== "number" || !Number.isInteger(record) || record < 0 || record >= recordCount) {
      throw new ReplayError(
        "OVERRIDE_INVALID",
        "override record index must be an integer in [0, " + (recordCount - 1) + "], got " + String(record),
      );
    }
    if (typeof mode !== "string" || !OVERRIDE_MODES.has(mode)) {
      throw new ReplayError("OVERRIDE_INVALID", "override mode must be 'throw' or 'hang'");
    }
    if (mode === "throw" && typeof message !== "string") {
      throw new ReplayError("OVERRIDE_INVALID", "a 'throw' override requires a string message");
    }
    if (result.has(record)) {
      throw new ReplayError("OVERRIDE_INVALID", "duplicate override for record index " + record);
    }
    result.set(record, { record, mode: mode as ReplayOverride["mode"], ...(message === undefined ? {} : { message }) });
  }
  return result;
}
