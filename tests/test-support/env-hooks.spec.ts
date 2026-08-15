/**
 * gateway env 钩子测试（阶段四 T1）。
 *
 * 覆盖：未设置时恒等返回、双 env 互斥 fail-loud、录制包裹写入 fixture、
 * 重放包裹对未匹配请求 fail-loud。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import {
  applyReplayEnvHooks,
  REPLAY_RECORD_ROOT_ENV,
  REPLAY_ROOT_ENV,
  REPLAY_RECORDS_FILENAME,
} from "../../src/test-support/llm-replay/index.js";

function makeBase(): ModelRuntime {
  return {
    stream: async function* (request: CanonicalModelRequest) {
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "text_delta", text: "hi" };
      yield { type: "message_end", finishReason: "stop" };
    },
    complete: async () => {
      throw new Error("unused");
    },
    getCapabilities: () => ({
      supportsToolUse: false,
      supportsStreaming: true,
      supportsParallelToolCalls: false,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 1000,
      maxOutputTokens: 1000,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  };
}

function makeRequest(text = "x"): CanonicalModelRequest {
  return { provider: "p", model: "m", messages: [{ role: "user", content: [{ type: "text", text }] }] };
}

test("未设置钩子：恒等返回原 runtime", () => {
  const base = makeBase();
  assert.equal(applyReplayEnvHooks(base, {}), base);
});

test("双 env 同时设置：fail-loud", () => {
  const base = makeBase();
  assert.throws(
    () => applyReplayEnvHooks(base, { [REPLAY_RECORD_ROOT_ENV]: "/a", [REPLAY_ROOT_ENV]: "/b" }),
    /set only one of/,
  );
});

test("RECORD_ROOT：包裹后录制 fixture", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "sati-replay-env-"));
  try {
    const wrapped = applyReplayEnvHooks(makeBase(), { [REPLAY_RECORD_ROOT_ENV]: fixtureDir });
    const events: unknown[] = [];
    for await (const event of wrapped.stream(makeRequest())) {
      events.push(event);
    }
    assert.equal(events.length, 3);
    const records = await readFile(join(fixtureDir, REPLAY_RECORDS_FILENAME), "utf8");
    assert.equal(records.trim().split("\n").length, 1);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("ROOT：包裹后未匹配请求 fail-loud（NO_REPLAY_RECORD）", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "sati-replay-env-"));
  try {
    // 先用录制路径产出合法 fixture（空 fixture 在包裹期即 FIXTURE_INVALID）。
    const recording = applyReplayEnvHooks(makeBase(), { [REPLAY_RECORD_ROOT_ENV]: fixtureDir });
    for await (const _event of recording.stream(makeRequest())) {
      // 收集完整个流以触发落盘
    }
    const wrapped = applyReplayEnvHooks(makeBase(), { [REPLAY_ROOT_ENV]: fixtureDir });
    await assert.rejects(async () => {
      for await (const _event of wrapped.stream(makeRequest("different"))) {
        // 收集直到拒绝
      }
    }, /no recorded stream matches/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
