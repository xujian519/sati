/**
 * LLM 重放测试 seam 回路级测试（阶段四 T1）。
 *
 * 覆盖：录制→重放全链路（经真实 createRouterRuntime 装配，passthrough 模式）、
 * 未匹配请求 fail-loud、throw/hang 覆写注入、assertAllConsumed 少驱动检测、
 * 请求键稳定性、录制中途失败的局部流捕获、覆写越界校验。
 *
 * 说明：fixture 由确定性 ScriptedModelRuntime 录制（CI 无 key 可跑）。真实
 * 模型 fixture 的录制方式：SATI_LLM_REPLAY_RECORD_ROOT=<dir> 运行 sati 会话，
 * 再用 pnpm record:replay <dir> 校验后提交到 tests/fixtures/llm-replay/。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
  ModelRuntimeOptions,
  MultimodalConstraints,
} from "../../src/model/index.js";
import { createRouterRuntime, type RouterRuntime } from "../../src/router/index.js";
import {
  createRecordingModelRuntime,
  createReplayModelRuntime,
  ReplayError,
  replayRequestKey,
  stableSerialize,
  REPLAY_RECORDS_FILENAME,
} from "../../src/test-support/llm-replay/index.js";

/** Deterministic model runtime the fixture records from; tool requests reply with one tool call. */
class ScriptedModelRuntime implements ModelRuntime {
  stream(request: CanonicalModelRequest, _options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent> {
    const wantsTool = request.messages.some(message =>
      message.content.some(block => block.type === "text" && block.text.includes("CALL_READ_FILE")),
    );
    return (async function* () {
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "message_start", role: "assistant" };
      if (wantsTool) {
        yield { type: "tool_call_start", id: "t1", name: "read_file" };
        yield { type: "tool_call_delta", id: "t1", delta: '{"filePath":"' };
        yield {
          type: "tool_call_end",
          toolCall: { id: "t1", name: "read_file", input: { filePath: "/tmp/replayed.md" } },
        };
      } else {
        yield { type: "text_delta", text: "replayed assistant text" };
      }
      yield { type: "message_end", finishReason: wantsTool ? "tool_call" : "stop" };
      yield { type: "usage", usage: { inputTokens: 12, outputTokens: 7 } };
    })();
  }

  complete(): Promise<never> {
    return Promise.reject(new Error("complete is not exercised by replay tests"));
  }

  getCapabilities() {
    return {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 64000,
      maxOutputTokens: 8192,
    };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

/** Model runtime that throws after its first event, for partial-record coverage. */
class FailingModelRuntime extends ScriptedModelRuntime {
  stream(request: CanonicalModelRequest, _options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent> {
    return (async function* () {
      yield { type: "request_started", provider: request.provider, model: request.model };
      throw new Error("injected mid-stream failure");
    })();
  }
}

function makeRequest(overrides: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest {
  return {
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "user", content: [{ type: "text", text: "hello patent assistant" }] }],
    systemPrompt: "you are a patent assistant",
    maxOutputTokens: 4096,
    ...overrides,
  };
}

function makeToolRequest(): CanonicalModelRequest {
  return makeRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "please CALL_READ_FILE for me" }] }],
    tools: [{ name: "read_file", inputSchema: { filePath: { type: "string" } } }],
  });
}

function makeRouter(runtime: ModelRuntime): RouterRuntime {
  return createRouterRuntime({ enabled: false }, { modelRuntime: runtime, now: () => new Date(0) });
}

async function drive(
  router: RouterRuntime,
  request: CanonicalModelRequest,
  abortSignal?: AbortSignal,
): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of router.stream(request, {
    sessionId: "s1",
    turnId: "t1",
    isMainAgent: true,
    projectPath: "/tmp",
    abortSignal,
  })) {
    events.push(event);
  }
  return events;
}

async function makeFixtureDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "sati-llm-replay-"));
}

test("记录后重放：真实 router 装配下事件流逐字节一致", async () => {
  const fixtureDir = await makeFixtureDir();
  try {
    const scripted = new ScriptedModelRuntime();
    const recording = createRecordingModelRuntime(scripted, fixtureDir);
    const recordRouter = makeRouter(recording);
    const plainEvents = await drive(recordRouter, makeRequest());
    const toolEvents = await drive(recordRouter, makeToolRequest());
    assert.equal(
      plainEvents.some(event => event.type === "text_delta"),
      true,
    );

    const recordsText = await readFile(join(fixtureDir, REPLAY_RECORDS_FILENAME), "utf8");
    const lines = recordsText.trim().split("\n");
    assert.equal(lines.length, 2);

    const replay = createReplayModelRuntime(fixtureDir, scripted);
    const replayRouter = makeRouter(replay);
    const replayedPlain = await drive(replayRouter, makeRequest());
    const replayedTool = await drive(replayRouter, makeToolRequest());
    assert.deepEqual(replayedPlain, plainEvents);
    assert.deepEqual(replayedTool, toolEvents);
    replay.assertAllConsumed();
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("未匹配请求 fail-loud：router 产出含 NO_REPLAY_RECORD 的 error 事件", async () => {
  const fixtureDir = await makeFixtureDir();
  try {
    const scripted = new ScriptedModelRuntime();
    await drive(makeRouter(createRecordingModelRuntime(scripted, fixtureDir)), makeRequest());
    const replay = createReplayModelRuntime(fixtureDir, scripted);
    const events = await drive(
      makeRouter(replay),
      makeRequest({ messages: [{ role: "user", content: [{ type: "text", text: "a totally different question" }] }] }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "error");
    const mismatchMessage = String((events[0] as { error: { message?: string } }).error.message);
    assert.match(mismatchMessage, /no recorded stream matches/);
    // 诊断增强：附 actual key 与 fixture keys，便于 tools inputSchema 变更导致失配时定位。
    assert.match(mismatchMessage, /actual key:/);
    assert.match(mismatchMessage, /fixture keys:/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("throw 覆写：指定记录以注入消息失败，其余记录正常重放", async () => {
  const fixtureDir = await makeFixtureDir();
  try {
    const scripted = new ScriptedModelRuntime();
    const recording = createRecordingModelRuntime(scripted, fixtureDir);
    await drive(makeRouter(recording), makeRequest());
    await drive(makeRouter(recording), makeToolRequest());
    await writeFile(
      join(fixtureDir, "replay.override.json"),
      JSON.stringify({ overrides: [{ record: 1, mode: "throw", message: "injected provider failure" }] }),
      "utf8",
    );
    const replay = createReplayModelRuntime(fixtureDir, scripted);
    const replayRouter = makeRouter(replay);
    const plainEvents = await drive(replayRouter, makeRequest());
    assert.equal(
      plainEvents.some(event => event.type === "text_delta"),
      true,
    );
    const toolEvents = await drive(replayRouter, makeToolRequest());
    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0]!.type, "error");
    assert.match(String((toolEvents[0] as { error: { message?: string } }).error.message), /injected provider failure/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("hang 覆写：挂起直到调用方 abort，随后拒绝", async () => {
  const fixtureDir = await makeFixtureDir();
  try {
    const scripted = new ScriptedModelRuntime();
    await drive(makeRouter(createRecordingModelRuntime(scripted, fixtureDir)), makeRequest());
    await writeFile(
      join(fixtureDir, "replay.override.json"),
      JSON.stringify({ overrides: [{ record: 0, mode: "hang" }] }),
      "utf8",
    );
    const replay = createReplayModelRuntime(fixtureDir, scripted);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("test aborted the hung replay")), 10);
    try {
      await assert.rejects(drive(makeRouter(replay), makeRequest(), controller.signal), /test aborted the hung replay/);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("assertAllConsumed：少驱动一条记录即报错并列出索引", async () => {
  const fixtureDir = await makeFixtureDir();
  try {
    const scripted = new ScriptedModelRuntime();
    const recording = createRecordingModelRuntime(scripted, fixtureDir);
    await drive(makeRouter(recording), makeRequest());
    await drive(makeRouter(recording), makeToolRequest());
    const replay = createReplayModelRuntime(fixtureDir, scripted);
    await drive(makeRouter(replay), makeRequest());
    assert.deepEqual(replay.unconsumedRecords(), [1]);
    assert.throws(() => replay.assertAllConsumed(), /never drove 1 recorded stream/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("请求键稳定：相同请求同键；输出上限参与键；metadata 与 raw 不参与", () => {
  const base = makeRequest();
  assert.equal(replayRequestKey(base), replayRequestKey(makeRequest()));
  assert.notEqual(replayRequestKey(base), replayRequestKey(makeRequest({ maxOutputTokens: 8192 })));
  const withMetadata = makeRequest({ metadata: { session: "other" } });
  assert.equal(replayRequestKey(base), replayRequestKey(withMetadata));
  const withRaw = makeRequest();
  const rawBlock = { type: "text", text: "hello patent assistant", raw: { providerInternal: true } };
  withRaw.messages[0]!.content = [rawBlock as unknown as (typeof withRaw.messages)[0]["content"][0]];
  assert.equal(replayRequestKey(base), replayRequestKey(withRaw));
  assert.equal(stableSerialize({ a: 1, raw: { providerInternal: true } }), '{"a":1}');
});

test("stableSerialize 支持共享引用（DAG）且 raw 键剥离", () => {
  const shared = { inner: 1 };
  assert.equal(stableSerialize({ a: shared, b: shared }), stableSerialize({ a: { inner: 1 }, b: { inner: 1 } }));
  assert.equal(stableSerialize({ data: { raw: "x", ok: 1 } }), '{"data":{"ok":1}}');
});

test("录制中途失败：捕获已产出事件的局部记录并保持错误传播", async () => {
  const fixtureDir = await makeFixtureDir();
  try {
    const recording = createRecordingModelRuntime(new FailingModelRuntime(), fixtureDir);
    const recordRouter = makeRouter(recording);
    const events = await drive(recordRouter, makeRequest());
    // router 先吐已缓冲的 request_started，再以归一化 error 事件收尾。
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, "request_started");
    assert.equal(events[1]!.type, "error");
    assert.match(String((events[1] as { error: { message?: string } }).error.message), /injected mid-stream failure/);
    const recordsText = await readFile(join(fixtureDir, REPLAY_RECORDS_FILENAME), "utf8");
    const lines = recordsText.trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!) as { events: unknown[] };
    assert.equal(record.events.length, 1);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("覆写越界：记录索引超出 fixture 即 fail-loud", async () => {
  const fixtureDir = await makeFixtureDir();
  try {
    const scripted = new ScriptedModelRuntime();
    await drive(makeRouter(createRecordingModelRuntime(scripted, fixtureDir)), makeRequest());
    await writeFile(
      join(fixtureDir, "replay.override.json"),
      JSON.stringify({ overrides: [{ record: 5, mode: "throw", message: "x" }] }),
      "utf8",
    );
    assert.throws(
      () => createReplayModelRuntime(fixtureDir, scripted),
      (error: unknown) => error instanceof ReplayError && error.code === "OVERRIDE_INVALID",
    );
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
