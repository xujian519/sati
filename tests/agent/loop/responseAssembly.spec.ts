import assert from "node:assert/strict";
import test from "node:test";
import { DoomLoop, type DoomLoopSignal } from "../../../src/agent/loop/doomLoop.js";
import type { LargeFileRepairDecision } from "../../../src/agent/loop/LargeFileRepair.js";
import {
  assembleAndRecover,
  handleEmptyResponse,
  handlePartialTextToolCall,
  handleRepairedTruncation,
  repairTextExtractedToolNames,
  type AssembledResponse,
  type ResponseAssemblyDeps,
  type SyntheticPromptOutcome,
} from "../../../src/agent/loop/responseAssembly.js";
import { TokenCapManager } from "../../../src/agent/loop/tokenCapManager.js";
import {
  MAX_CONSECUTIVE_EMPTY,
  MAX_OUTPUT_RECOVERY_LIMIT,
  TurnRuntimeState,
} from "../../../src/agent/loop/turnRuntimeState.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import {
  applyModelEventToAssembler,
  createModelMessageAssemblerState,
  type CanonicalMessage,
  type CanonicalModelRequest,
  type CanonicalToolCall,
} from "../../../src/model/index.js";
import type { RouterDecision } from "../../../src/router/index.js";

/**
 * 响应装配与异常处置行为基线（AgentLoop 拆解；issue #147 / TD-AGENT-103）。
 *
 * 覆盖：文本回退工具名修复、三条互斥异常处置路径（半截文本 / 修补后截断 /
 * 空响应）的触发条件与产物、调度顺序（半截文本先于空响应）、以及正常落库。
 */

const STARTED_AT = "2026-09-14T00:00:00.000Z";
const DECISION: RouterDecision = { provider: "p1", model: "m1" } as RouterDecision;
const REQUEST: CanonicalModelRequest = { provider: "p1", model: "m1", messages: [], stream: true };

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolCall(id: string, name: string, input: unknown = {}): CanonicalToolCall {
  return { id, name, input } as CanonicalToolCall;
}

function response(overrides: Partial<AssembledResponse> = {}): AssembledResponse {
  const message = overrides.assistantMessage ?? assistant("done");
  return {
    assembled: {
      message,
      finishReason: "stop",
      hasMessageEnd: true,
      toolCalls: [],
    },
    assistantMessage: message,
    toolCalls: [],
    ...overrides,
  };
}

interface Harness {
  input: AgentLoopInput;
  state: TurnRuntimeState;
  deps: ResponseAssemblyDeps;
  durable: CanonicalMessage[];
  emitted: AgentEvent[];
  syntheticCalls: Array<{ decision: LargeFileRepairDecision; options?: { stripCurrentAssistant?: boolean } }>;
}

interface HarnessOptions {
  messages?: CanonicalMessage[];
  deps?: Partial<ResponseAssemblyDeps>;
  syntheticOutcome?: SyntheticPromptOutcome;
}

function bare(): { input: AgentLoopInput; state: TurnRuntimeState } {
  const input: AgentLoopInput = {
    sessionId: "s1",
    turnId: "t1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  return { input, state: new TurnRuntimeState(input, {}, STARTED_AT) };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const durable: CanonicalMessage[] = [];
  const emitted: AgentEvent[] = [];
  const syntheticCalls: Harness["syntheticCalls"] = [];
  const input: AgentLoopInput = {
    sessionId: "s1",
    turnId: "t1",
    messages: options.messages ?? [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    onDurableMessage: message => {
      durable.push(message);
    },
  };
  const state = new TurnRuntimeState(input, {}, STARTED_AT);
  const deps: ResponseAssemblyDeps = {
    tokenCaps: new TokenCapManager({ provider: "p1", model: "m1", maxOutputTokens: 8192 }, {}),
    contextRuntime: undefined,
    now: () => new Date("2026-09-14T01:02:03.004Z"),
    doomLoop: undefined,
    eventEmitter: event => void emitted.push(event),
    listToolNames: () => ["write_file", "read_file", "edit_file"],
    toolAliases: undefined,
    continueWithSyntheticPrompt: async (s, i, decision, opts) => {
      syntheticCalls.push({ decision, options: opts });
      return (
        options.syntheticOutcome ?? {
          type: "continue",
          event: { type: "turn_continued", sessionId: i.sessionId, turnId: i.turnId, reason: "model_error" },
        }
      );
    },
    ...options.deps,
  };
  return { input, state, deps, durable, emitted, syntheticCalls };
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

const eventTypes = (events: AgentEvent[]): string[] => events.map(event => event.type);

// ---------------------------------------------------------------------------
// 文本回退工具名修复
// ---------------------------------------------------------------------------

test("repairTextExtractedToolNames：按别名纠正消息与工具调用两侧的名字", () => {
  const { deps } = makeHarness({ deps: { toolAliases: { Write: "write_file" } } });
  const message: CanonicalMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "写文件" },
      { type: "tool_call", id: "c1", name: "Write", input: { path: "a.mjs" } },
    ],
  };

  const repaired = repairTextExtractedToolNames(deps, message, [toolCall("c1", "Write", { path: "a.mjs" })]);

  assert.equal(repaired.toolCalls[0]!.name, "write_file");
  const block = repaired.message.content.find(entry => entry.type === "tool_call");
  assert.equal(block?.type === "tool_call" ? block.name : undefined, "write_file");
  assert.equal(repaired.message.content[0]!.type, "text");
});

test("repairTextExtractedToolNames：无法纠正时原样返回（保持同一引用）", () => {
  const { deps } = makeHarness();
  const message = assistant("no tool call here");
  const toolCalls = [toolCall("c1", "totally_unknown_tool_name")];

  const repaired = repairTextExtractedToolNames(deps, message, toolCalls);

  assert.equal(repaired.message, message);
  assert.equal(repaired.toolCalls, toolCalls);
});

test("repairTextExtractedToolNames：无工具调用时零开销", () => {
  const { deps } = makeHarness();
  const message = assistant("text only");

  const repaired = repairTextExtractedToolNames(deps, message, []);

  assert.equal(repaired.message, message);
  assert.deepEqual(repaired.toolCalls, []);
});

// ---------------------------------------------------------------------------
// 半截文本工具调用
// ---------------------------------------------------------------------------

test("handlePartialTextToolCall：无半截片段时不接管", async () => {
  const h = makeHarness();

  const { events, value } = await drain(handlePartialTextToolCall(h.deps, h.state, h.input, response()));

  assert.deepEqual(events, []);
  assert.deepEqual(value, { kind: "unhandled" });
});

test("handlePartialTextToolCall：预算内注入续跑提示并消耗一次预算", async () => {
  const h = makeHarness();
  const assembled = response({
    assembled: {
      message: assistant("let me write <tool_call>"),
      finishReason: "stop",
      hasMessageEnd: true,
      toolCalls: [],
      hasPartialTextToolCall: true,
      partialTextToolCall: { format: "xml", reason: "unclosed" } as never,
    },
  });

  const { events, value } = await drain(handlePartialTextToolCall(h.deps, h.state, h.input, assembled));

  assert.equal(h.state.maxOutputRecoveryCount, 1);
  assert.equal(h.state.finalMessage, undefined);
  assert.deepEqual(eventTypes(events), ["turn_continued"]);
  assert.deepEqual(value, { kind: "continue" });
});

test("handlePartialTextToolCall：预算耗尽时以 error 结果终止本轮", async () => {
  const h = makeHarness();
  h.state.maxOutputRecoveryCount = MAX_OUTPUT_RECOVERY_LIMIT;
  const assembled = response({
    assembled: {
      message: assistant("half"),
      finishReason: "stop",
      hasMessageEnd: true,
      toolCalls: [],
      hasPartialTextToolCall: true,
    },
  });

  const { events, value } = await drain(handlePartialTextToolCall(h.deps, h.state, h.input, assembled));

  assert.deepEqual(eventTypes(events), ["agent_status", "turn_failed", "turn_completed"]);
  assert.equal(value.kind, "return");
  assert.equal(value.kind === "return" ? value.result.type : undefined, "error");
  assert.equal(h.state.finalMessage, undefined);
});

// ---------------------------------------------------------------------------
// 修补后截断的工具调用
// ---------------------------------------------------------------------------

test("handleRepairedTruncation：非修补截断响应不接管", async () => {
  const h = makeHarness();
  const unrepaired = response();

  assert.deepEqual(
    (await drain(handleRepairedTruncation(h.deps, h.state, h.input, DECISION, undefined, unrepaired))).value,
    { kind: "unhandled" },
  );

  const wrongFinish = response({
    assembled: {
      message: assistant("x"),
      finishReason: "error" as never,
      hasMessageEnd: true,
      toolCalls: [],
      hasRepairedToolCalls: true,
    },
  });
  assert.deepEqual(
    (await drain(handleRepairedTruncation(h.deps, h.state, h.input, DECISION, undefined, wrongFinish))).value,
    { kind: "unhandled" },
  );
});

test("handleRepairedTruncation：非文件写工具交给共享 max-output 恢复（Phase A 加倍）", async () => {
  const h = makeHarness();
  const repaired = response({
    assembled: {
      message: assistant("searching"),
      finishReason: "length",
      hasMessageEnd: true,
      toolCalls: [],
      hasRepairedToolCalls: true,
    },
    toolCalls: [toolCall("c1", "patent_search", { query: "x" })],
  });

  const { events, value } = await drain(
    handleRepairedTruncation(h.deps, h.state, h.input, DECISION, undefined, repaired),
  );

  assert.deepEqual(value, { kind: "continue" });
  assert.deepEqual(eventTypes(events), ["token_cap_adjusted", "turn_continued"]);
  assert.equal(h.deps.tokenCaps.currentMaxOutputTokens("p1", "m1"), 16_384);
  assert.deepEqual(h.syntheticCalls, []);
});

test("handleRepairedTruncation：文件写工具先走 LargeFileRepair 续跑", async () => {
  const h = makeHarness();
  const repaired = response({
    assembled: {
      message: assistant("writing"),
      finishReason: "length",
      hasMessageEnd: true,
      toolCalls: [],
      hasRepairedToolCalls: true,
    },
    toolCalls: [toolCall("c1", "write_file", { path: "a.mjs", content: "x" })],
  });

  const { events, value } = await drain(
    handleRepairedTruncation(h.deps, h.state, h.input, DECISION, undefined, repaired),
  );

  assert.equal(h.syntheticCalls.length, 1);
  assert.deepEqual(h.syntheticCalls[0]!.options, { stripCurrentAssistant: false });
  assert.deepEqual(eventTypes(events), ["turn_continued"]);
  assert.deepEqual(value, { kind: "continue" });
});

test("handleRepairedTruncation：LargeFileRepair 判定停止时以状态 + 结果终止", async () => {
  const h = makeHarness({
    syntheticOutcome: {
      type: "completed",
      result: {
        type: "error",
        stopReason: "tool_error",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: STARTED_AT,
        sessionId: "s1",
        turnId: "t1",
        completedAt: "2026-09-14T00:00:01.000Z",
        errors: [{ code: "agent_tool_error_loop", message: "looping" }],
      },
      status: { event: "tool_error_loop", kind: "error", text: "looping" },
    },
  });
  const repaired = response({
    assembled: {
      message: assistant("writing"),
      finishReason: "stop",
      hasMessageEnd: true,
      toolCalls: [],
      hasRepairedToolCalls: true,
    },
    toolCalls: [toolCall("c1", "write_file", { path: "a.mjs", content: "x" })],
  });

  const { events, value } = await drain(
    handleRepairedTruncation(h.deps, h.state, h.input, DECISION, undefined, repaired),
  );

  assert.deepEqual(eventTypes(events), ["agent_status", "turn_failed", "turn_completed"]);
  assert.equal(value.kind, "return");
});

test("handleRepairedTruncation：Phase 耗尽后以 error 结果终止（不执行半截调用）", async () => {
  const h = makeHarness();
  h.state.maxOutputRecoveryCount = MAX_OUTPUT_RECOVERY_LIMIT;
  h.state.hasAttemptedOutputRetry = true;
  const repaired = response({
    assembled: {
      message: assistant("searching"),
      finishReason: "length",
      hasMessageEnd: true,
      toolCalls: [],
      hasRepairedToolCalls: true,
    },
    toolCalls: [toolCall("c1", "patent_search", { query: "x" })],
  });

  const { events, value } = await drain(
    handleRepairedTruncation(h.deps, h.state, h.input, DECISION, undefined, repaired),
  );

  assert.deepEqual(eventTypes(events), ["agent_status", "turn_failed", "turn_completed"]);
  assert.equal(value.kind, "return");
  assert.equal(
    value.kind === "return" ? value.result.errors?.[0]?.message : undefined,
    "Recovered tool call still looked repaired/truncated after max-output recovery was exhausted.",
  );
});

// ---------------------------------------------------------------------------
// 空响应
// ---------------------------------------------------------------------------

test("handleEmptyResponse：有文本或有工具调用时不接管", async () => {
  const h = makeHarness();

  assert.deepEqual(
    (await drain(handleEmptyResponse(h.deps, h.state, h.input, REQUEST, DECISION, undefined, response()))).value,
    { kind: "unhandled" },
  );

  const withTools = response({ toolCalls: [toolCall("c1", "read_file")] });
  assert.deepEqual(
    (await drain(handleEmptyResponse(h.deps, h.state, h.input, REQUEST, DECISION, undefined, withTools))).value,
    { kind: "unhandled" },
  );
});

test("handleEmptyResponse：首次空响应交给共享恢复链重试", async () => {
  const h = makeHarness();
  const empty = response({ assistantMessage: { role: "assistant", content: [] } });

  const { events, value } = await drain(
    handleEmptyResponse(h.deps, h.state, h.input, REQUEST, DECISION, undefined, empty),
  );

  assert.deepEqual(value, { kind: "continue" });
  assert.equal(h.state.hasAttemptedEmptyRetry, true);
  assert.equal(eventTypes(events).includes("turn_continued"), true);
});

test("handleEmptyResponse：恢复链不接管时以 status + 成功结果收尾", async () => {
  const h = makeHarness();
  h.state.hasAttemptedEmptyRetry = true;
  const empty = response({ assistantMessage: { role: "assistant", content: [] } });

  const { events, value } = await drain(
    handleEmptyResponse(h.deps, h.state, h.input, REQUEST, DECISION, undefined, empty),
  );

  assert.deepEqual(eventTypes(events), ["agent_status", "turn_completed"]);
  assert.equal(value.kind, "return");
  assert.equal(value.kind === "return" ? value.result.type : undefined, "success");
});

test("handleEmptyResponse：连空预算耗尽时透传恢复链的终止结果", async () => {
  const h = makeHarness();
  h.state.maxOutputRecoveryCount = 1;
  h.state.consecutiveEmptyCount = MAX_CONSECUTIVE_EMPTY;
  const empty = response({ assistantMessage: { role: "assistant", content: [] } });

  const { events, value } = await drain(
    handleEmptyResponse(h.deps, h.state, h.input, REQUEST, DECISION, undefined, empty),
  );

  assert.deepEqual(eventTypes(events), ["agent_status", "turn_completed"]);
  assert.equal(value.kind, "return");
});

// ---------------------------------------------------------------------------
// 调度链
// ---------------------------------------------------------------------------

test("assembleAndRecover：正常响应落库并交回主循环", async () => {
  const h = makeHarness();
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, { type: "text_delta", text: "done" });
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "stop" });
  applyModelEventToAssembler(assembler, { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } });

  const { events, value } = await drain(
    assembleAndRecover(h.deps, h.state, h.input, REQUEST, DECISION, undefined, assembler),
  );

  assert.deepEqual(eventTypes(events), ["assistant_message"]);
  assert.equal(value.kind, "proceed");
  assert.equal(h.durable.length, 1);
  assert.deepEqual(h.state.messages.at(-1), h.durable[0]);
  assert.equal(h.state.usage.inputTokens, 10);
  assert.equal(h.state.usage.outputTokens, 2);
  assert.equal(h.state.lastModelUsage?.inputTokens, 10);
  assert.equal(h.state.lastModelUsage?.outputTokens, 2);
});

test("assembleAndRecover：错误响应不落库（交由恢复链处置）", async () => {
  const h = makeHarness();
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, { type: "text_delta", text: "half" });
  applyModelEventToAssembler(assembler, {
    type: "error",
    error: { provider: "p1", protocol: "openai", code: "timeout", message: "boom", retryable: true },
  });

  const { events, value } = await drain(
    assembleAndRecover(h.deps, h.state, h.input, REQUEST, DECISION, undefined, assembler),
  );

  assert.deepEqual(events, []);
  assert.equal(value.kind, "proceed");
  assert.equal(h.durable.length, 0);
  assert.equal(h.state.messages.length, 1);
  assert.ok(h.state.finalMessage);
});

test("assembleAndRecover：doomLoop 记录在装配后即刻生效（fatal 写入 state）", async () => {
  const signals: DoomLoopSignal[] = [{ detector: "textRepetition", reason: "repeat", turn: 1, fatal: true }];
  const h = makeHarness({
    deps: { doomLoop: { recordModelCall: () => signals, currentTurnNumber: () => 1 } as unknown as DoomLoop },
  });
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, { type: "text_delta", text: "same" });
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "stop" });

  await drain(assembleAndRecover(h.deps, h.state, h.input, REQUEST, DECISION, undefined, assembler));

  assert.equal(h.state.doomLoopFatalReason, "repeat");
  assert.deepEqual(eventTypes(h.emitted), ["doomloop_signal"]);
});

test("assembleAndRecover：正常装配时连续中断计数清零", async () => {
  const h = makeHarness();
  h.state.streamInterruptionRecoveryCount = 2;
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, { type: "text_delta", text: "ok" });
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "stop" });

  await drain(assembleAndRecover(h.deps, h.state, h.input, REQUEST, DECISION, undefined, assembler));

  assert.equal(h.state.streamInterruptionRecoveryCount, 0);
});

test("assembleAndRecover：修补后截断的响应不落库，转 max-output 恢复", async () => {
  const h = makeHarness();
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, {
    type: "tool_call_end",
    toolCall: toolCall("c1", "patent_search", { query: "x" }),
    wasRepaired: true,
  });
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "length" });

  const { events, value } = await drain(
    assembleAndRecover(h.deps, h.state, h.input, REQUEST, DECISION, undefined, assembler),
  );

  // 脏的修补消息绝不落库：恢复响应将替换它。
  assert.equal(eventTypes(events).includes("assistant_message"), false);
  assert.equal(h.durable.length, 0);
  assert.deepEqual(value, { kind: "continue" });
  assert.equal(h.deps.tokenCaps.currentMaxOutputTokens("p1", "m1"), 16_384);
});

test("assembleAndRecover：空响应走空响应恢复链而非落库空消息", async () => {
  const h = makeHarness();
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "stop" });

  const { events, value } = await drain(
    assembleAndRecover(h.deps, h.state, h.input, REQUEST, DECISION, undefined, assembler),
  );

  assert.deepEqual(eventTypes(events), ["turn_continued"]);
  assert.deepEqual(value, { kind: "continue" });
  assert.equal(h.state.hasAttemptedEmptyRetry, true);
  assert.equal(h.durable.length, 0);
});

test("assembleAndRecover：文本回退工具名在装配期被修复", async () => {
  const h = makeHarness({ deps: { toolAliases: { Write: "write_file" } } });
  const assembler = createModelMessageAssemblerState();
  applyModelEventToAssembler(assembler, { type: "message_start", role: "assistant" });
  applyModelEventToAssembler(assembler, {
    type: "text_delta",
    text: '<tool_call>\n{"name": "Write", "arguments": {"path": "a.mjs"}}\n</tool_call>',
  });
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "tool_call" });

  const { value } = await drain(assembleAndRecover(h.deps, h.state, h.input, REQUEST, DECISION, undefined, assembler));

  assert.equal(value.kind, "proceed");
  assert.equal(value.kind === "proceed" ? value.toolCalls[0]!.name : undefined, "write_file");
  assert.equal(value.kind === "proceed" ? value.assembled.hasTextFallbackToolCalls : undefined, true);
});
