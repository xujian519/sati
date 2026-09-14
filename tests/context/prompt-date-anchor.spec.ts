import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPostCompactMessages, CompactionEngine } from "../../src/context/index.js";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { isPromptDateNotice } from "../../src/context/prompt/promptDateNotice.js";
import type { MemoryResolver, MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../src/model/index.js";

/**
 * 会话提示日期锚定 + 跨 UTC 日通知（上游 PilotDeck v2026.09.14 / PR #571 语义移植）。
 *
 * `<environment>now: YYYY-MM-DD</environment>` 落在 system prompt 前缀里，是 prompt
 * cache 的缓存键：此前按 UTC 自然日刷新，跨午夜的会话会改写 system prompt、整段前缀
 * 缓存失效，重付一次全量 prefill。现在会话首次正式组装请求时锚定日期、此后不再改写，
 * 跨日改为在消息尾部追加一条合成日期通知告知模型真实日期；只有完整压缩（前缀本来
 * 就要重写）才重新锚定。
 */

function message(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function notices(context: { messages: CanonicalMessage[] }): CanonicalMessage[] {
  return context.messages.filter(isPromptDateNotice);
}

function promptDate(context: { systemPrompt?: string }): string | undefined {
  return context.systemPrompt?.match(/now: (\d{4}-\d{2}-\d{2})/)?.[1];
}

function makeInput(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    provider: "test",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    messages: [message("你好")],
    tools: [],
    ...overrides,
  };
}

/** 用真实压缩引擎产出一份 checkpoint（boundary + 摘要）头部，避免手写标记字符串。 */
async function buildCheckpoint(engine: CompactionEngine, messages: CanonicalMessage[]): Promise<CanonicalMessage[]> {
  const result = await engine.run({
    trigger: "auto",
    keepTailRatio: 0.01,
    protectedToolNames: null,
    messages,
  });
  const compacted = buildPostCompactMessages(result);
  assert.ok(
    compacted[0]?.content.some(block => block.type === "text" && block.text.startsWith("<compact-boundary")),
    "压缩引擎应产出 boundary 头部",
  );
  return compacted;
}

function makeSummaryEngine(counter: { value: number }): CompactionEngine {
  return new CompactionEngine({
    model: {
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        counter.value += 1;
        yield { type: "message_start", role: "assistant" };
        yield {
          type: "text_delta",
          text:
            `## Objective\nContinue.\n\n## Current State\nCompacted ${counter.value}.\n\n` +
            "## Remaining\nContinue.\n\n## Files And Artifacts\nNone.",
        };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });
}

describe("DefaultContextRuntime 会话提示日期锚定", () => {
  it("首次组装锚定日期，同一自然日内 systemPrompt 逐字不变", async () => {
    let current = new Date("2026-09-10T00:10:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const morning = await runtime.prepareForModel(makeInput());
    current = new Date("2026-09-10T18:00:00.000Z");
    const evening = await runtime.prepareForModel(makeInput());

    assert.match(morning.systemPrompt ?? "", /now: 2026-09-10/);
    assert.equal(evening.systemPrompt, morning.systemPrompt);
    assert.equal(notices(morning).length, 0);
    assert.equal(notices(evening).length, 0);
  });

  it("首次组装晚于构造时刻时，用组装当天的日期", async () => {
    let current = new Date("2026-09-10T12:00:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    current = new Date("2026-09-12T09:00:00.000Z");
    const context = await runtime.prepareForModel(makeInput());

    assert.match(context.systemPrompt ?? "", /now: 2026-09-12/);
  });

  it("跨 UTC 午夜不改写 systemPrompt，改为追加一条日期通知", async () => {
    let current = new Date("2026-09-10T23:50:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const before = await runtime.prepareForModel(makeInput());
    current = new Date("2026-09-11T00:05:00.000Z");
    const after = await runtime.prepareForModel(makeInput());

    assert.equal(after.systemPrompt, before.systemPrompt);
    assert.match(after.systemPrompt ?? "", /now: 2026-09-10/);
    assert.equal(notices(after).length, 1);
    assert.match(JSON.stringify(notices(after)), /current_date: 2026-09-11/);
  });

  it("通知只追加一次，后续请求以前一次请求的消息为逐字前缀", async () => {
    let current = new Date("2026-09-10T23:59:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });
    const messages = [message("第一问")];

    const first = await runtime.prepareForModel(makeInput({ messages }));
    current = new Date("2026-09-11T00:01:00.000Z");
    messages.push(message("第二问"));
    const rollover = await runtime.prepareForModel(makeInput({ messages }));
    assert.deepEqual(rollover.messages.slice(0, first.messages.length), first.messages);
    assert.equal(notices(rollover).length, 1);

    messages.push(assistant("答复"), message("第三问"));
    const later = await runtime.prepareForModel(makeInput({ messages }));
    assert.equal(notices(later).length, 1, "同一 UTC 日内不重复追加");
    assert.deepEqual(later.messages.slice(0, rollover.messages.length), rollover.messages);
    assert.equal(later.systemPrompt, first.systemPrompt);

    current = new Date("2026-09-12T00:01:00.000Z");
    const tomorrow = await runtime.prepareForModel(makeInput({ messages }));
    assert.equal(notices(tomorrow).length, 2);
    assert.deepEqual(tomorrow.messages.slice(0, later.messages.length), later.messages);
    assert.equal(tomorrow.systemPrompt, first.systemPrompt);
  });

  it("头部裁剪 / 微压缩 / 中间删减都不改写 system 日期，受影响的通知挪到新末尾", async () => {
    for (const rewritten of [
      [message("tail")],
      [message("head"), message("short tool result"), message("tail")],
      [message("head"), message("tail")],
    ]) {
      let current = new Date("2026-09-10T12:00:00.000Z");
      const runtime = new DefaultContextRuntime({ now: () => current });
      const original = [message("head"), message("long tool result"), message("tail")];

      await runtime.prepareForModel(makeInput({ messages: original }));
      current = new Date("2026-09-11T12:00:00.000Z");
      const rollover = await runtime.prepareForModel(makeInput({ messages: original }));
      assert.equal(notices(rollover).length, 1);

      const rewrittenContext = await runtime.prepareForModel(makeInput({ messages: rewritten }));
      assert.equal(promptDate(rewrittenContext), "2026-09-10");
      assert.equal(notices(rewrittenContext).length, 1);
      assert.ok(isPromptDateNotice(rewrittenContext.messages.at(-1)!), "通知应落在新末尾");

      current = new Date("2026-09-12T12:00:00.000Z");
      const next = await runtime.prepareForModel(makeInput({ messages: [...rewritten, message("next")] }));
      assert.equal(promptDate(next), "2026-09-10");
    }
  });

  it("滑动窗口改变投影后仍不改写 system 日期", async () => {
    let current = new Date("2026-09-10T12:00:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });
    const messages = [message("old"), message("head"), message("tail")];

    await runtime.prepareForModel(makeInput({ messages, maxMessages: 2 }));
    current = new Date("2026-09-11T12:00:00.000Z");
    const rollover = await runtime.prepareForModel(makeInput({ messages, maxMessages: 2 }));
    assert.equal(promptDate(rollover), "2026-09-10");

    const advanced = await runtime.prepareForModel(
      makeInput({ messages: [...messages, message("next")], maxMessages: 2 }),
    );
    assert.equal(promptDate(advanced), "2026-09-10");
  });

  it("完整压缩产生新 checkpoint 后才刷新 system 日期并清除旧通知", async () => {
    const counter = { value: 0 };
    const engine = makeSummaryEngine(counter);
    const messages = [
      message("Older work"),
      assistant("older response"),
      message("Latest tail request"),
      assistant("latest response"),
    ];
    let current = new Date("2026-09-10T12:00:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const first = await runtime.prepareForModel(makeInput({ messages }));
    assert.match(first.systemPrompt ?? "", /now: 2026-09-10/);
    current = new Date("2026-09-11T12:00:00.000Z");
    assert.equal(notices(await runtime.prepareForModel(makeInput({ messages }))).length, 1);

    const checkpoint = await buildCheckpoint(engine, messages);
    const rewritten = await runtime.prepareForModel(makeInput({ messages: checkpoint }));
    assert.equal(promptDate(rewritten), "2026-09-11");
    assert.equal(notices(rewritten).length, 0);

    const continued = [...checkpoint, message("continue")];
    const sameDay = await runtime.prepareForModel(makeInput({ messages: continued }));
    assert.equal(promptDate(sameDay), "2026-09-11", "压缩后同一 UTC 日内不再刷新");
    assert.equal(notices(sameDay).length, 0);

    current = new Date("2026-09-12T12:00:00.000Z");
    const rollover = await runtime.prepareForModel(makeInput({ messages: continued }));
    assert.equal(promptDate(rollover), "2026-09-11", "普通跨日只追加通知，不改写 system 日期");
    assert.equal(notices(rollover).length, 1);

    const nextCheckpoint = await buildCheckpoint(engine, continued);
    const refreshed = await runtime.prepareForModel(makeInput({ messages: nextCheckpoint }));
    assert.equal(promptDate(refreshed), "2026-09-12");
    assert.equal(notices(refreshed).length, 0);
  });

  it("不同会话各自维护锚点（同一 runtime 内隔离）", async () => {
    let current = new Date("2026-09-10T23:59:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const first = await runtime.prepareForModel(makeInput({ sessionId: "a" }));
    current = new Date("2026-09-11T08:00:00.000Z");
    const other = await runtime.prepareForModel(makeInput({ sessionId: "b" }));

    assert.equal(promptDate(first), "2026-09-10");
    assert.equal(promptDate(other), "2026-09-11");
    assert.equal(notices(other).length, 0, "新会话不继承其它会话的日期通知");
  });

  it("锚定与通知不依赖 provider 协议（runtime 无协议分支）", async () => {
    let current = new Date("2026-09-10T23:59:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const before = await runtime.prepareForModel(makeInput({ provider: "openai", model: "gpt-x" }));
    current = new Date("2026-09-11T00:30:00.000Z");
    const after = await runtime.prepareForModel(makeInput({ provider: "openai", model: "gpt-x" }));

    assert.equal(after.systemPrompt, before.systemPrompt);
    assert.equal(notices(after).length, 1);
  });

  it("预算预演（previewOnly）不提交锚点与通知位置", async () => {
    const counter = { value: 0 };
    const engine = makeSummaryEngine(counter);
    let current = new Date("2026-09-10T12:00:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });
    const messages = [message("第一问")];

    const first = await runtime.prepareForModel(makeInput({ messages }));
    current = new Date("2026-09-11T12:00:00.000Z");

    const preview = await runtime.prepareForModel(
      makeInput({ messages: [...messages, message("假设被丢弃的历史")], previewOnly: true }),
    );
    assert.equal(promptDate(preview), "2026-09-10", "预演用已提交的锚点，不前进");
    assert.equal(notices(preview).length, 1);

    const checkpoint = await buildCheckpoint(engine, [...messages, assistant("答复"), message("继续撰写")]);
    const checkpointPreview = await runtime.prepareForModel(makeInput({ messages: checkpoint, previewOnly: true }));
    assert.equal(promptDate(checkpointPreview), "2026-09-10", "完整压缩的预演也不得刷新锚点");

    const actual = await runtime.prepareForModel(makeInput({ messages: [...messages, message("第二问")] }));
    assert.equal(actual.systemPrompt, first.systemPrompt);
    assert.equal(notices(actual).length, 1);
    assert.ok(isPromptDateNotice(actual.messages.at(-1)!), "通知位置取自真实请求，未被预演污染");

    const repeated = await runtime.prepareForModel(makeInput({ messages: [...messages, message("第二问")] }));
    assert.deepEqual(repeated.messages, actual.messages);
  });

  it("日期通知不参与记忆检索的 query 与最近消息", async () => {
    const captured: MemoryRetrieveInput[] = [];
    const resolver: MemoryResolver = {
      retrieve: async input => {
        captured.push(input);
        return { diagnostics: [] };
      },
      captureTurn: async () => undefined,
    };
    let current = new Date("2026-09-10T23:59:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current, memoryResolver: resolver });
    const messages = [message("今天请继续撰写说明书")];

    await runtime.prepareForModel(makeInput({ messages }));
    current = new Date("2026-09-11T00:05:00.000Z");
    const context = await runtime.prepareForModel(makeInput({ messages }));

    assert.equal(notices(context).length, 1);
    const last = captured.at(-1)!;
    assert.equal(last.query, "今天请继续撰写说明书");
    assert.equal(last.recentMessages.some(isPromptDateNotice), false);
  });
});
