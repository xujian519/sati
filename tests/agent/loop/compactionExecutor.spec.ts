import assert from "node:assert/strict";
import test from "node:test";
import { persistCompactSnapshot, runAutoCompact } from "../../../src/agent/loop/compactionExecutor.js";
import { TurnRuntimeState } from "../../../src/agent/loop/turnRuntimeState.js";
import type { AgentContextRuntime } from "../../../src/context/ContextRuntime.js";
import type { AutoCompactResult, CompactionResult } from "../../../src/context/index.js";
import type { TokenBudgetSnapshot } from "../../../src/context/index.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

/**
 * 压缩执行器行为基线（AgentLoop 拆解；issue #147 / TD-SIZE-001）。
 *
 * 覆盖：无 tryAutoCompact 短路、压缩成功（messages 替换 + 快照落盘 + 事件）、
 * transient 提示剥离与回贴、失败降级（日志 + 截头兜底）、入参透传。
 */

const STARTED_AT = "2026-09-14T00:00:00.000Z";

function user(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function snapshot(tokens = 100): TokenBudgetSnapshot {
  return {
    tokens,
    maxContextTokens: 1000,
    warningRatio: 0.8,
    blockingRatio: 0.95,
    state: "ok",
    ratio: tokens / 1000,
  };
}

function compactionResult(overrides: Partial<CompactionResult> = {}): CompactionResult {
  return {
    compactionId: "cmp-1",
    status: "success",
    trigger: "auto",
    preTokens: 5000,
    messagesSummarized: 12,
    boundaryMarker: assistant("[compact boundary]"),
    messagesToKeep: [],
    attachments: [],
    hookResults: [],
    diagnostics: [],
    ...overrides,
  };
}

async function drain<T>(
  generator: AsyncGenerator<AgentEvent, T, unknown>,
): Promise<{ events: AgentEvent[]; value: T }> {
  const events: AgentEvent[] = [];
  while (true) {
    const step = await generator.next();
    if (step.done) return { events, value: step.value };
    events.push(step.value);
  }
}

interface Harness {
  input: AgentLoopInput;
  state: TurnRuntimeState;
  persisted: Array<{
    boundary: { compactMetadata?: { shadowedRanges?: Array<{ fromIndex: number; toIndex: number }> } };
    messages: CanonicalMessage[];
  }>;
  compactCalls: unknown[];
}

function makeHarness(options: { messages?: CanonicalMessage[]; persist?: boolean } = {}): Harness {
  const persisted: Harness["persisted"] = [];
  const compactCalls: unknown[] = [];
  const input: AgentLoopInput = {
    sessionId: "s1",
    turnId: "t1",
    messages: options.messages ?? [user("hi"), assistant("hello")],
  };
  if (options.persist !== false) {
    input.onCompactPersisted = entry => {
      persisted.push(entry as unknown as Harness["persisted"][number]);
    };
  }
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  return { input, state, persisted, compactCalls };
}

/** 构造压缩器桩：返回固定结果并记录每次调用入参。 */
function runtimeWith(result: AutoCompactResult, calls: unknown[]): AgentContextRuntime {
  return {
    tryAutoCompact: async (input: unknown) => {
      calls.push(input);
      return result;
    },
  } as unknown as AgentContextRuntime;
}

// ---------------------------------------------------------------------------
// runAutoCompact
// ---------------------------------------------------------------------------

test("runAutoCompact：无 tryAutoCompact 时短路（不动 messages、无事件）", async () => {
  const h = makeHarness();
  const before = [...h.state.messages];

  const { events, value } = await drain(
    runAutoCompact(undefined, h.state, h.input, { stage: "pre-routing", reservedOutputTokens: 1024 }),
  );

  assert.deepEqual(events, []);
  assert.deepEqual(value, { compacted: false });
  assert.deepEqual(h.state.messages, before);
});

test("runAutoCompact：压缩成功时替换 messages、落快照并广播 turn_continued", async () => {
  const h = makeHarness();
  const messages = [assistant("[summary]"), user("tail")];

  const { events, value } = await drain(
    runAutoCompact(
      runtimeWith(
        { type: "compacted", messages, tier: "full", snapshot: snapshot(), result: compactionResult() },
        h.compactCalls,
      ),
      h.state,
      h.input,
      { stage: "pre-routing", reservedOutputTokens: 1024 },
    ),
  );

  assert.deepEqual(h.state.messages, messages);
  assert.deepEqual(
    events.map(event => event.type),
    ["turn_continued"],
  );
  assert.equal(value.compacted, true);
  assert.equal(value.snapshot?.tokens, 100);
  assert.equal(h.persisted.length, 1);
});

test("runAutoCompact：emitAutoCompactEvent=false 时不广播但仍替换 messages", async () => {
  const h = makeHarness();
  const messages = [assistant("[summary]")];

  const { events, value } = await drain(
    runAutoCompact(
      runtimeWith(
        { type: "compacted", messages, tier: "full", snapshot: snapshot(), result: compactionResult() },
        h.compactCalls,
      ),
      h.state,
      h.input,
      { stage: "model-error-recovery", reservedOutputTokens: 1024, emitAutoCompactEvent: false },
    ),
  );

  assert.deepEqual(events, []);
  assert.deepEqual(h.state.messages, messages);
  assert.equal(value.compacted, true);
});

test("runAutoCompact：transient 恢复提示在压缩输入前剥离、产物后回贴末尾", async () => {
  const h = makeHarness();
  h.state.pushTransientSyntheticPrompt("resume prompt", "max_output_recovery");
  const compressed = [assistant("[summary]")];

  await drain(
    runAutoCompact(
      runtimeWith(
        { type: "compacted", messages: compressed, tier: "full", snapshot: snapshot(), result: compactionResult() },
        h.compactCalls,
      ),
      h.state,
      h.input,
      { stage: "pre-routing", reservedOutputTokens: 1024 },
    ),
  );

  const compactInput = h.compactCalls[0] as { messages: CanonicalMessage[] };
  assert.equal(
    compactInput.messages.some(message => message.metadata?.transient === true),
    false,
  );
  // 压缩产物在前、未被模型消费的恢复提示回贴末尾。
  assert.equal(h.state.messages.length, compressed.length + 1);
  assert.deepEqual(h.state.messages.slice(0, compressed.length), compressed);
  assert.equal(h.state.messages.at(-1)?.metadata?.transient, true);
});

test("runAutoCompact：未压缩且给了兜底比例时按比例截头", async () => {
  const h = makeHarness({
    messages: [user("1"), assistant("2"), user("3"), assistant("4")],
  });

  const { value } = await drain(
    runAutoCompact(runtimeWith({ type: "skipped", snapshot: snapshot(900) }, h.compactCalls), h.state, h.input, {
      stage: "pre-routing",
      reservedOutputTokens: 1024,
      fallbackTruncateRatio: 0.5,
    }),
  );

  assert.equal(value.compacted, false);
  assert.equal(value.snapshot?.tokens, 900);
  assert.equal(h.state.messages.length < 4, true);
});

test("runAutoCompact：tryAutoCompact 抛错时记日志并走兜底（不抛出）", async () => {
  const h = makeHarness({ messages: [user("1"), assistant("2"), user("3"), assistant("4")] });

  const { value } = await drain(
    runAutoCompact(
      {
        tryAutoCompact: async () => {
          throw new Error("compaction exploded");
        },
      } as unknown as AgentContextRuntime,
      h.state,
      h.input,
      { stage: "model-error-recovery", reservedOutputTokens: 1024, fallbackTruncateRatio: 0.5 },
    ),
  );

  assert.deepEqual(value, { compacted: false });
  assert.equal(h.state.messages.length < 4, true);
  assert.deepEqual(h.persisted, []);
});

test("runAutoCompact：入参透传（maxContextTokens/budgetEvaluator/lastUsage）", async () => {
  const h = makeHarness();
  h.state.lastModelUsage = { inputTokens: 42 };
  const budgetEvaluator = async () => snapshot(777);

  await drain(
    runAutoCompact(runtimeWith({ type: "skipped", snapshot: snapshot() }, h.compactCalls), h.state, h.input, {
      stage: "post-routing",
      reservedOutputTokens: 2048,
      maxContextTokens: 128_000,
      budgetEvaluator,
    }),
  );

  const sent = h.compactCalls[0] as Record<string, unknown>;
  assert.equal(sent.sessionId, "s1");
  assert.equal(sent.turnId, "t1");
  assert.equal(sent.maxContextTokens, 128_000);
  assert.equal(sent.reservedOutputTokens, 2048);
  assert.equal(sent.budgetEvaluator, budgetEvaluator);
  assert.deepEqual(sent.lastUsage, { inputTokens: 42 });
});

// ---------------------------------------------------------------------------
// persistCompactSnapshot
// ---------------------------------------------------------------------------

test("persistCompactSnapshot：无钩子或无压缩结果时零开销", async () => {
  const h = makeHarness({ persist: false });
  await persistCompactSnapshot(h.input, {
    type: "compacted",
    messages: [],
    tier: "full",
    snapshot: snapshot(),
    result: compactionResult(),
  });
  assert.deepEqual(h.persisted, []);

  const withHook = makeHarness();
  await persistCompactSnapshot(withHook.input, {
    type: "compacted",
    messages: [],
    tier: "full",
    snapshot: snapshot(),
  });
  assert.deepEqual(withHook.persisted, []);
});

test("persistCompactSnapshot：落压缩边界并标记替换消息", async () => {
  const h = makeHarness();

  await persistCompactSnapshot(h.input, {
    type: "compacted",
    messages: [assistant("[summary]")],
    tier: "snip",
    snapshot: snapshot(),
    result: compactionResult({ shadowedMessageIndexes: [1, 2, 3, 7] }),
  });

  assert.equal(h.persisted.length, 1);
  const entry = h.persisted[0]!;
  assert.deepEqual(entry.boundary.compactMetadata?.shadowedRanges, [
    { fromIndex: 1, toIndex: 3 },
    { fromIndex: 7, toIndex: 7 },
  ]);
  assert.equal(entry.messages[0]?.metadata?.compactReplacement, true);
});

test("persistCompactSnapshot：无遮蔽索引时不下发 shadowedRanges", async () => {
  const h = makeHarness();

  await persistCompactSnapshot(h.input, {
    type: "compacted",
    messages: [],
    tier: "full",
    snapshot: snapshot(),
    result: compactionResult(),
  });

  assert.equal(h.persisted[0]!.boundary.compactMetadata?.shadowedRanges, undefined);
});
