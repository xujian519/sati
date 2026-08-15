#!/usr/bin/env tsx
/**
 * LLM replay fixture validation and inspection (phase 4, T1).
 *
 * Recording happens live: run the product with SATI_LLM_REPLAY_RECORD_ROOT
 * set to a fixture directory, exercise a session, then commit the directory.
 * This script validates a recorded fixture with the same loader the tests
 * use and prints its manifest, so fixture reviews and CI gates catch corrupt
 * or under-driven fixtures before they fail a test run.
 *
 * Usage:
 *   pnpm record:replay <fixture-dir>
 */
import { exit } from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createReplayModelRuntime } from "../src/test-support/llm-replay/index.js";
import type { ModelRuntime } from "../src/model/index.js";
import { REPLAY_MANIFEST_FILENAME } from "../src/test-support/llm-replay/record.js";
import type { ReplayManifest } from "../src/test-support/llm-replay/types.js";

/** Capability queries are never used during validation; fail loud if they are. */
function validationOnly(): never {
  throw new Error("validation-only base runtime: capability queries are unavailable during fixture validation");
}

function main(): void {
  const args = process.argv.slice(2);
  const fixtureDir = args.find(arg => !arg.startsWith("--"));
  if (fixtureDir === undefined) {
    console.error("usage: pnpm record:replay <fixture-dir>");
    exit(2);
  }
  const base: ModelRuntime = {
    stream: async function* () {
      // 空生成器 + 立即 throw：满足 require-yield，且验证期永不产出事件。
      yield* [];
      throw validationOnly();
    },
    complete: async () => {
      throw validationOnly();
    },
    getCapabilities: () => {
      throw validationOnly();
    },
    getMultimodal: () => {
      throw validationOnly();
    },
    getProviderProtocol: () => {
      throw validationOnly();
    },
    getProviderBaseUrl: () => {
      throw validationOnly();
    },
  };
  try {
    const runtime = createReplayModelRuntime(fixtureDir, base);
    const records = runtime.unconsumedRecords();
    console.log("fixture valid: " + fixtureDir);
    console.log("records: " + records.length);
    const manifestPath = join(fixtureDir, REPLAY_MANIFEST_FILENAME);
    let manifest: ReplayManifest | undefined;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReplayManifest;
    } catch {
      manifest = undefined;
    }
    if (manifest !== undefined) {
      for (const record of manifest.records) {
        const firstText = record.userTexts[0] ?? "";
        console.log(
          "  [" +
            record.index +
            "] " +
            record.provider +
            "/" +
            record.model +
            " tools=" +
            (record.toolNames.join(",") || "-") +
            " events=" +
            record.eventCount +
            " text=" +
            (firstText.length > 60 ? firstText.slice(0, 60) + "…" : firstText),
        );
      }
    }
  } catch (error) {
    console.error("fixture invalid: " + (error instanceof Error ? error.message : String(error)));
    exit(1);
  }
}

main();
