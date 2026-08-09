import test from "node:test";
import assert from "node:assert/strict";
import {
  LifecycleRuntime,
  NullLifecycleRuntime,
  emptyLifecycleDispatchResult,
  SatiLifecycleRuntimeError,
} from "../../src/lifecycle/index.js";
import { HookRuntime } from "../../src/extension/hooks/execution/HookRuntime.js";
import type { HookRuntimeRunInput, HookRuntimeRunResult } from "../../src/extension/hooks/execution/HookRuntime.js";
import type { SatiHookExecutionEvent } from "../../src/extension/hooks/events/HookExecutionEventBus.js";
import type { SatiLifecycleError } from "../../src/lifecycle/protocol/effects.js";
import type { SatiHookEffect } from "../../src/lifecycle/protocol/effects.js";
import type { LifecycleDispatchInput } from "../../src/lifecycle/protocol/payloads.js";

function baseInput(): LifecycleDispatchInput {
  return {
    event: "PreToolUse",
    baseInput: {
      sessionId: "s1",
      transcriptPath: "/tmp/t.jsonl",
      cwd: "/tmp/project",
    },
  };
}

function stubRuntime(result: HookRuntimeRunResult): { runtime: HookRuntime; calls: HookRuntimeRunInput[] } {
  const calls: HookRuntimeRunInput[] = [];
  const runtime = {
    run: async (input: HookRuntimeRunInput): Promise<HookRuntimeRunResult> => {
      calls.push(input);
      return result;
    },
  } as unknown as HookRuntime;
  return { runtime, calls };
}

function emptyResult(): HookRuntimeRunResult {
  return { effects: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
}

test("emptyLifecycleDispatchResult returns all-empty result", () => {
  assert.deepEqual(emptyLifecycleDispatchResult(), {
    effects: [],
    messages: [],
    events: [],
    blockingErrors: [],
    nonBlockingErrors: [],
  });
});

test("SatiLifecycleRuntimeError carries code and details", () => {
  const err = new SatiLifecycleRuntimeError("hook_blocked", "blocked by hook", { hook: "x" });
  assert.equal(err.name, "SatiLifecycleRuntimeError");
  assert.equal(err.code, "hook_blocked");
  assert.equal(err.message, "blocked by hook");
  assert.deepEqual(err.details, { hook: "x" });
  assert.ok(err instanceof Error);
});

test("LifecycleRuntime.dispatch passes event, baseInput cwd, env and signal to hooks", async () => {
  const { runtime, calls } = stubRuntime(emptyResult());
  const lc = new LifecycleRuntime(runtime);
  const signal = new AbortController().signal;
  await lc.dispatch({
    ...baseInput(),
    env: { FOO: "bar" },
    signal,
    matchQuery: "tool=read",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.event, "PreToolUse");
  assert.equal(calls[0]!.cwd, "/tmp/project");
  assert.equal(calls[0]!.env?.FOO, "bar");
  assert.equal(calls[0]!.signal, signal);
  assert.equal(calls[0]!.matchQuery, "tool=read");
  assert.equal(calls[0]!.hookInput.hookEventName, "PreToolUse");
});

test("LifecycleRuntime.dispatch merges payload into hook input", async () => {
  const { runtime, calls } = stubRuntime(emptyResult());
  const lc = new LifecycleRuntime(runtime);
  await lc.dispatch({
    ...baseInput(),
    payload: { toolName: "read_file", extra: 1 },
  });
  assert.equal(calls[0]!.hookInput.toolName, "read_file");
  assert.equal(calls[0]!.hookInput.extra, 1);
});

test("LifecycleRuntime.dispatch maps additional_context effects to user messages", async () => {
  const { runtime } = stubRuntime({
    effects: [
      { type: "additional_context", content: "ctx body", source: "plugin-a" },
      { type: "system_message", content: "sys" },
    ],
    events: [],
    blockingErrors: [],
    nonBlockingErrors: [],
  });
  const lc = new LifecycleRuntime(runtime);
  const result = await lc.dispatch(baseInput());
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]!.role, "user");
  assert.equal(result.effects.length, 2);
  assert.deepEqual(result.messages[0]!.content, [
    {
      type: "text",
      text: '<hook_context source="plugin-a">\nctx body\n</hook_context>',
    },
  ]);
});

test("LifecycleRuntime.dispatch passes through effects, events and errors untouched", async () => {
  const effects: SatiHookEffect[] = [{ type: "block", reason: "denied", stopReason: "policy" }];
  const events: SatiHookExecutionEvent[] = [{ type: "started", hookName: "h", hookEvent: "PreToolUse" }];
  const blockingErrors: SatiLifecycleError[] = [{ code: "hook_blocking_error", message: "b" }];
  const nonBlockingErrors: SatiLifecycleError[] = [{ code: "hook_execution_failed", message: "n" }];
  const { runtime } = stubRuntime({ effects, events, blockingErrors, nonBlockingErrors });
  const lc = new LifecycleRuntime(runtime);
  const result = await lc.dispatch(baseInput());
  assert.equal(result.effects, effects);
  assert.equal(result.events, events);
  assert.equal(result.blockingErrors, blockingErrors);
  assert.equal(result.nonBlockingErrors, nonBlockingErrors);
});

test("NullLifecycleRuntime.dispatch returns empty result without touching hooks", async () => {
  const lc = new NullLifecycleRuntime();
  const result = await lc.dispatch();
  assert.deepEqual(result, emptyLifecycleDispatchResult());
});
