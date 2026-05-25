import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getPilotExtensionPaths } from "../../src/pilot/index.js";
import {
  PILOTDECK_HOOK_EVENTS,
  PILOTDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS,
  parseHookOutput,
  toLegacyHookInput,
  createHookInput,
} from "../../src/extension/index.js";

test("hook event list excludes non-migrated teammate and task events", () => {
  assert.equal(PILOTDECK_HOOK_EVENTS.includes("PreToolUse"), true);
  assert.equal((PILOTDECK_HOOK_EVENTS as readonly string[]).includes("TeammateIdle"), false);
  assert.deepEqual(PILOTDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS, [
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
  ]);
});

test("hook input can be projected to legacy snake_case shape", () => {
  const input = createHookInput(
    "PreToolUse",
    {
      sessionId: "session",
      transcriptPath: "/tmp/transcript.jsonl",
      cwd: "/workspace",
      permissionMode: "default",
    },
    {
      toolName: "bash",
      toolInput: { command: "pwd" },
      toolUseId: "toolu_1",
    },
  );

  assert.deepEqual(toLegacyHookInput(input), {
    hook_event_name: "PreToolUse",
    session_id: "session",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/workspace",
    permission_mode: "default",
    tool_name: "bash",
    tool_input: { command: "pwd" },
    tool_use_id: "toolu_1",
  });
});

test("hook output parser recognizes async compatibility without carrying configurable timeout", () => {
  assert.deepEqual(parseHookOutput('{"async":true,"asyncTimeout":1}\n'), {
    type: "async",
    raw: { async: true, asyncTimeout: 1 },
  });
});

test("hook output parser maps sync hook-specific output", () => {
  const output = parseHookOutput(
    JSON.stringify({
      continue: false,
      stopReason: "blocked",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "ctx",
        updatedInput: { command: "pwd" },
      },
    }),
  );

  assert.equal(output.type, "sync");
  if (output.type === "sync") {
    assert.equal(output.continue, false);
    assert.equal(output.stopReason, "blocked");
    assert.deepEqual(output.specific?.updatedInput, { command: "pwd" });
  }
});

test("extension paths are fixed under PilotHome and project .pilotdeck", () => {
  assert.deepEqual(getPilotExtensionPaths("/repo/app", "/home/user/.pilotdeck"), {
    globalPluginsDir: resolve("/home/user/.pilotdeck", "plugins"),
    globalSkillsDir: resolve("/home/user/.pilotdeck", "skills"),
    projectPluginsDir: resolve("/repo/app", ".pilotdeck", "plugins"),
    projectSkillsDir: resolve("/repo/app", ".pilotdeck", "skills"),
  });
});
