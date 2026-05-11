import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
  splitThinkContent,
  type OpenAIStreamState,
} from "../../../src/model/providers/openai/stream.js";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
} from "../../../src/model/streaming/assembleModelMessage.js";

// ---------------------------------------------------------------------------
// splitThinkContent — unit tests
// ---------------------------------------------------------------------------

function makeState(): OpenAIStreamState {
  return createOpenAIStreamState();
}

function textEvents(events: { type: string; text?: string }[]) {
  return events.map((e) => ({ type: e.type, text: (e as { text: string }).text }));
}

test("splitThinkContent: full <think> block in a single chunk", () => {
  const state = makeState();
  const events = splitThinkContent("<think>reasoning</think>answer", state, {});
  assert.deepEqual(textEvents(events), [
    { type: "thinking_delta", text: "reasoning" },
    { type: "text_delta", text: "answer" },
  ]);
  assert.equal(state.thinkFsm, "NORMAL");
});

test("splitThinkContent: think block at start, text follows", () => {
  const state = makeState();
  const events = splitThinkContent("<think>step 1</think>Hello world", state, {});
  assert.deepEqual(textEvents(events), [
    { type: "thinking_delta", text: "step 1" },
    { type: "text_delta", text: "Hello world" },
  ]);
});

test("splitThinkContent: think block split across two chunks", () => {
  const state = makeState();
  const e1 = splitThinkContent("<think>step", state, {});
  assert.deepEqual(textEvents(e1), [{ type: "thinking_delta", text: "step" }]);
  assert.equal(state.thinkFsm, "THINKING");

  const e2 = splitThinkContent(" two</think>final", state, {});
  assert.deepEqual(textEvents(e2), [
    { type: "thinking_delta", text: " two" },
    { type: "text_delta", text: "final" },
  ]);
  assert.equal(state.thinkFsm, "NORMAL");
});

test("splitThinkContent: open tag split across chunks", () => {
  const state = makeState();
  // First chunk ends with partial "<thi"
  const e1 = splitThinkContent("hello<thi", state, {});
  assert.deepEqual(textEvents(e1), [{ type: "text_delta", text: "hello" }]);
  assert.equal(state.tagBuffer, "<thi");
  assert.equal(state.thinkFsm, "NORMAL");

  // Next chunk completes the tag
  const e2 = splitThinkContent("nk>reasoning</think>done", state, {});
  assert.deepEqual(textEvents(e2), [
    { type: "thinking_delta", text: "reasoning" },
    { type: "text_delta", text: "done" },
  ]);
});

test("splitThinkContent: close tag split across chunks", () => {
  const state = makeState();
  state.thinkFsm = "THINKING";
  const e1 = splitThinkContent("thinking text</thi", state, {});
  assert.deepEqual(textEvents(e1), [{ type: "thinking_delta", text: "thinking text" }]);
  assert.equal(state.tagBuffer, "</thi");

  const e2 = splitThinkContent("nk>answer", state, {});
  assert.deepEqual(textEvents(e2), [{ type: "text_delta", text: "answer" }]);
  assert.equal(state.thinkFsm, "NORMAL");
});

test("splitThinkContent: no think tags passes through as text_delta", () => {
  const state = makeState();
  const events = splitThinkContent("just regular text", state, {});
  assert.deepEqual(textEvents(events), [{ type: "text_delta", text: "just regular text" }]);
});

test("splitThinkContent: empty think block", () => {
  const state = makeState();
  const events = splitThinkContent("<think></think>answer", state, {});
  assert.deepEqual(textEvents(events), [{ type: "text_delta", text: "answer" }]);
});

test("splitThinkContent: think-only content (no closing tag yet)", () => {
  const state = makeState();
  const events = splitThinkContent("<think>still thinking...", state, {});
  assert.deepEqual(textEvents(events), [{ type: "thinking_delta", text: "still thinking..." }]);
  assert.equal(state.thinkFsm, "THINKING");
});

test("splitThinkContent: partial tag that turns out not to be a tag", () => {
  const state = makeState();
  // "<th" buffered, then "at is not a tag" arrives
  const e1 = splitThinkContent("prefix<th", state, {});
  assert.deepEqual(textEvents(e1), [{ type: "text_delta", text: "prefix" }]);
  assert.equal(state.tagBuffer, "<th");

  // "at" doesn't continue the tag — flush buffer as text
  const e2 = splitThinkContent("at is not a tag", state, {});
  assert.deepEqual(textEvents(e2), [{ type: "text_delta", text: "<that is not a tag" }]);
  assert.equal(state.tagBuffer, "");
});

test("splitThinkContent: single '<' at chunk boundary", () => {
  const state = makeState();
  const e1 = splitThinkContent("hello<", state, {});
  assert.deepEqual(textEvents(e1), [{ type: "text_delta", text: "hello" }]);
  assert.equal(state.tagBuffer, "<");

  const e2 = splitThinkContent("think>reason</think>done", state, {});
  assert.deepEqual(textEvents(e2), [
    { type: "thinking_delta", text: "reason" },
    { type: "text_delta", text: "done" },
  ]);
});

// ---------------------------------------------------------------------------
// Integration: normalizeOpenAIStreamEvent with <think> tags
// ---------------------------------------------------------------------------

test("normalizeOpenAIStreamEvent splits <think> tags from delta.content", () => {
  const state = createOpenAIStreamState();
  const events = normalizeOpenAIStreamEvent(
    { choices: [{ index: 0, delta: { content: "<think>reasoning</think>answer", role: "assistant" }, finish_reason: null }] },
    state,
  );
  const typed = events.filter((e) => e.type === "thinking_delta" || e.type === "text_delta");
  assert.equal(typed.length, 2);
  assert.equal(typed[0]!.type, "thinking_delta");
  assert.equal((typed[0] as { text: string }).text, "reasoning");
  assert.equal(typed[1]!.type, "text_delta");
  assert.equal((typed[1] as { text: string }).text, "answer");
});

test("normalizeOpenAIStreamEvent handles <think> across multiple chunks", () => {
  const state = createOpenAIStreamState();
  const chunks = [
    { choices: [{ index: 0, delta: { content: "<think>step1", role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: " step2</think>answer", role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" }] },
  ];
  const assembler = createModelMessageAssemblerState();
  for (const chunk of chunks) {
    for (const event of normalizeOpenAIStreamEvent(chunk, state)) {
      applyModelEventToAssembler(assembler, event);
    }
  }
  const result = assembleAssistantMessage(assembler);
  assert.equal(result.message.content[0]?.type, "thinking");
  assert.equal((result.message.content[0] as { text: string }).text, "step1 step2");
  assert.equal(result.message.content[1]?.type, "text");
  assert.equal((result.message.content[1] as { text: string }).text, "answer");
});

// ---------------------------------------------------------------------------
// delta.reasoning_content support
// ---------------------------------------------------------------------------

test("normalizeOpenAIStreamEvent maps delta.reasoning_content to thinking_delta", () => {
  const state = createOpenAIStreamState();
  const events = normalizeOpenAIStreamEvent(
    { choices: [{ index: 0, delta: { content: "", role: "assistant", reasoning_content: "Deep reasoning." }, finish_reason: null }] },
    state,
  );
  const thinking = events.filter((e) => e.type === "thinking_delta");
  assert.equal(thinking.length, 1);
  assert.equal((thinking[0] as { text: string }).text, "Deep reasoning.");
});

test("Assembler folds reasoning_content + content into thinking + text blocks", () => {
  const stream = createOpenAIStreamState();
  const assembler = createModelMessageAssemblerState();
  const chunks = [
    { choices: [{ index: 0, delta: { content: "", role: "assistant", reasoning_content: "Think." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "Result.", role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" }] },
  ];
  for (const chunk of chunks) {
    for (const event of normalizeOpenAIStreamEvent(chunk, stream)) {
      applyModelEventToAssembler(assembler, event);
    }
  }
  const result = assembleAssistantMessage(assembler);
  assert.equal(result.message.content[0]?.type, "thinking");
  assert.equal((result.message.content[0] as { text: string }).text, "Think.");
  assert.equal(result.message.content[1]?.type, "text");
  assert.equal((result.message.content[1] as { text: string }).text, "Result.");
});
