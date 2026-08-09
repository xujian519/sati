import test from "node:test";
import assert from "node:assert/strict";
import { parseHookOutput } from "../../../src/extension/hooks/execution/parseHookOutput.js";
import { AsyncHookRegistry } from "../../../src/extension/hooks/execution/AsyncHookRegistry.js";
import type { PendingAsyncHook } from "../../../src/extension/hooks/execution/AsyncHookRegistry.js";

test("parseHookOutput returns sync for non-JSON stdout", () => {
  assert.deepEqual(parseHookOutput(""), { type: "sync" });
  assert.deepEqual(parseHookOutput("plain text output"), { type: "sync" });
  assert.deepEqual(parseHookOutput("{broken json"), { type: "sync" });
});

test("parseHookOutput returns async for async:true", () => {
  const output = parseHookOutput(JSON.stringify({ async: true, hookEventName: "PreToolUse" }));
  assert.equal(output.type, "async");
  assert.ok((output as { raw?: unknown }).raw);
});

test("parseHookOutput scans for first JSON line", () => {
  const output = parseHookOutput(`random noise
{"continue": false}
tail`);
  assert.equal(output.type, "sync");
  assert.equal((output as { continue?: boolean }).continue, false);
});

test("parseHookOutput parses sync fields and decision", () => {
  const output = parseHookOutput(
    JSON.stringify({
      continue: true,
      suppressOutput: true,
      stopReason: "max_tokens",
      decision: "block",
      reason: "policy",
      systemMessage: "be careful",
    }),
  );
  assert.equal(output.type, "sync");
  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
  assert.equal(output.stopReason, "max_tokens");
  assert.equal(output.decision, "block");
  assert.equal(output.reason, "policy");
  assert.equal(output.systemMessage, "be careful");
});

test("parseHookOutput ignores invalid decision values", () => {
  const output = parseHookOutput(JSON.stringify({ decision: "maybe", continue: "yes" }));
  assert.equal(output.type, "sync");
  assert.equal(output.decision, undefined);
  assert.equal(output.continue, undefined);
});

test("parseHookOutput parses hookSpecificOutput fields", () => {
  const output = parseHookOutput(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "ctx",
        initialUserMessage: "hi",
        watchPaths: ["/tmp/a", 5],
        permissionDecision: "allow",
        permissionDecisionReason: "trusted",
        updatedInput: { path: "/tmp/f" },
        updatedMCPToolOutput: { ok: true },
        decision: { behavior: "deny", message: "no", interrupt: true },
        retry: true,
        worktreePath: "/wt",
      },
    }),
  );
  if (output.type !== "sync") {
    throw new Error("expected sync output");
  }
  const specific = output.specific;
  assert.equal(specific?.hookEventName, "PreToolUse");
  assert.equal(specific?.additionalContext, "ctx");
  assert.equal(specific?.initialUserMessage, "hi");
  assert.deepEqual(specific?.watchPaths, ["/tmp/a"]);
  assert.equal(specific?.permissionDecision, "allow");
  assert.equal(specific?.permissionDecisionReason, "trusted");
  assert.deepEqual(specific?.updatedInput, { path: "/tmp/f" });
  assert.deepEqual(specific?.updatedMCPToolOutput, { ok: true });
  assert.deepEqual(specific?.decision, { behavior: "deny", message: "no", interrupt: true });
  assert.equal(specific?.retry, true);
  assert.equal(specific?.worktreePath, "/wt");
});

test("parseHookOutput parses allow decision with updatedInput", () => {
  const output = parseHookOutput(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        decision: { behavior: "allow", updatedInput: { a: 1 }, updatedPermissions: ["p1"] },
      },
    }),
  );
  if (output.type !== "sync") {
    throw new Error("expected sync output");
  }
  assert.deepEqual(output.specific?.decision, {
    behavior: "allow",
    updatedInput: { a: 1 },
    updatedPermissions: ["p1"],
  });
});

test("parseHookOutput drops malformed specific output", () => {
  const first = parseHookOutput(JSON.stringify({ hookSpecificOutput: "x" }));
  if (first.type === "sync") {
    assert.equal(first.specific, undefined);
  }
  const second = parseHookOutput(JSON.stringify({ hookSpecificOutput: {} }));
  if (second.type === "sync") {
    assert.equal(second.specific, undefined);
  }
  const third = parseHookOutput(JSON.stringify({ hookSpecificOutput: { decision: { behavior: "maybe" } } }));
  if (third.type === "sync") {
    assert.equal(third.specific?.decision, undefined);
  }
});

function pendingHook(overrides: Partial<PendingAsyncHook> = {}): PendingAsyncHook {
  return {
    id: "h1",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    hookName: "test:command",
    hookEvent: "PreToolUse",
    stdout: "",
    stderr: "",
    responseDelivered: false,
    ...overrides,
  };
}

test("AsyncHookRegistry registers and lists hooks", () => {
  const registry = new AsyncHookRegistry();
  registry.register(pendingHook());
  assert.equal(registry.list().length, 1);
  registry.clear();
  assert.equal(registry.list().length, 0);
});

test("collectResponses skips empty stdout and async outputs", () => {
  const registry = new AsyncHookRegistry();
  registry.register(pendingHook({ id: "empty" }));
  registry.register(pendingHook({ id: "async", stdout: JSON.stringify({ async: true }) }));
  const responses = registry.collectResponses();
  assert.equal(responses.length, 0);
});

test("collectResponses delivers sync outputs once and removes delivered", () => {
  const registry = new AsyncHookRegistry();
  registry.register(pendingHook({ id: "a", stdout: JSON.stringify({ continue: false }) }));
  registry.register(pendingHook({ id: "b", stdout: "plain" }));
  const first = registry.collectResponses();
  assert.equal(first.length, 2);
  assert.equal(first[0]!.id, "a");
  assert.equal(first[0]!.output.type, "sync");
  assert.equal(registry.collectResponses().length, 0); // already delivered
  registry.removeDelivered();
  assert.equal(registry.list().length, 0);
});

test("collectResponses flags rewake only for asyncRewake with blocking output", () => {
  const registry = new AsyncHookRegistry();
  registry.register(pendingHook({ id: "block", asyncRewake: true, stdout: JSON.stringify({ continue: false }) }));
  registry.register(pendingHook({ id: "ok", asyncRewake: true, stdout: JSON.stringify({ continue: true }) }));
  registry.register(pendingHook({ id: "noflag", stdout: JSON.stringify({ decision: "block" }) }));
  const responses = registry.collectResponses();
  const byId = new Map(responses.map(r => [r.id, r]));
  assert.equal(byId.get("block")?.rewake, true);
  assert.equal(byId.get("ok")?.rewake, false);
  assert.equal(byId.get("noflag")?.rewake, false);
});
