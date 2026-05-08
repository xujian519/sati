import test from "node:test";
import assert from "node:assert/strict";
import { LifecycleRuntime } from "../../src/lifecycle/index.js";
import { HookRuntime } from "../../src/extension/index.js";
import type { PolitDeckHooksSettings } from "../../src/extension/index.js";

test("command hook success can produce additional context effects", async () => {
  const settings: PolitDeckHooksSettings = {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'ctx'}}))"`,
          },
        ],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));

  const result = await lifecycle.dispatch({
    event: "SessionStart",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { source: "startup" },
    matchQuery: "SessionStart",
  });

  assert.deepEqual(result.effects, [{ type: "additional_context", content: "ctx", source: "command" }]);
  assert.equal(result.messages.length, 1);
});

test("command hook exit code 2 produces blocking effect", async () => {
  const settings: PolitDeckHooksSettings = {
    PreToolUse: [
      {
        matcher: "bash",
        hooks: [{ type: "command", command: `node -e "console.error('blocked'); process.exit(2)"` }],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));

  const result = await lifecycle.dispatch({
    event: "PreToolUse",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { toolName: "bash", toolInput: { command: "rm" }, toolUseId: "toolu_1" },
    matchQuery: "bash",
  });

  assert.equal(result.blockingErrors.length, 1);
  assert.equal(result.effects.some((effect) => effect.type === "block"), true);
});

test("command hook non-2 failure is non-blocking", async () => {
  const settings: PolitDeckHooksSettings = {
    PostToolUse: [
      {
        matcher: "read_file",
        hooks: [{ type: "command", command: `node -e "console.error('warn'); process.exit(1)"` }],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));

  const result = await lifecycle.dispatch({
    event: "PostToolUse",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { toolName: "read_file", toolInput: {}, toolUseId: "toolu_1" },
    matchQuery: "read_file",
  });

  assert.equal(result.blockingErrors.length, 0);
  assert.equal(result.nonBlockingErrors.length, 1);
});
