import test from "node:test";
import assert from "node:assert/strict";
import { parseHooksConfig } from "../../../src/extension/hooks/config/parseHooksConfig.js";
import { matchHookMatcher } from "../../../src/extension/hooks/config/matchHook.js";
import { matchHookCondition } from "../../../src/extension/hooks/config/matchHookCondition.js";

test("parseHooksConfig returns empty settings for undefined/null", () => {
  assert.deepEqual(parseHooksConfig(undefined), { settings: {}, diagnostics: [] });
  assert.deepEqual(parseHooksConfig(null), { settings: {}, diagnostics: [] });
});

test("parseHooksConfig flags non-object input", () => {
  const result = parseHooksConfig("nope");
  assert.deepEqual(result.settings, {});
  assert.deepEqual(result.diagnostics, ["Hooks config must be an object."]);
});

test("parseHooksConfig rejects unsupported hook events", () => {
  const result = parseHooksConfig({ NotARealEvent: [{ hooks: [] }] });
  assert.deepEqual(result.settings, {});
  assert.match(result.diagnostics[0] ?? "", /Unsupported hook event NotARealEvent/);
});

test("parseHooksConfig requires array of matchers per event", () => {
  const result = parseHooksConfig({ PreToolUse: "not-array" });
  assert.deepEqual(result.settings, {});
  assert.match(result.diagnostics[0] ?? "", /must contain an array of matchers/);
});

test("parseHooksConfig parses command hooks with shell normalization", () => {
  const result = parseHooksConfig({
    PreToolUse: [
      {
        matcher: "read_file",
        hooks: [
          { type: "command", command: "echo hi", shell: "bash", async: true, once: true, timeout: 100 },
          { type: "command", command: "ps", shell: "powershell" },
          { type: "command", command: "sh -c x", shell: "fish" }, // unsupported shell -> undefined
        ],
      },
    ],
  });
  const matchers = result.settings.PreToolUse ?? [];
  assert.equal(matchers.length, 1);
  assert.equal(matchers[0]?.matcher, "read_file");
  const hooks = matchers[0]!.hooks;
  assert.deepEqual(hooks[0], {
    type: "command",
    command: "echo hi",
    shell: "bash",
    async: true,
    asyncRewake: undefined,
    once: true,
    timeout: 100,
    if: undefined,
    statusMessage: undefined,
  });
  assert.equal(hooks[1]?.type, "command");
  if (hooks[1]?.type === "command") {
    assert.equal(hooks[1].shell, "powershell");
  }
  assert.equal(hooks[2]?.type, "command");
  if (hooks[2]?.type === "command") {
    assert.equal(hooks[2].shell, undefined);
  }
});

test("parseHooksConfig parses prompt, http and agent hooks", () => {
  const result = parseHooksConfig({
    SessionStart: [
      {
        hooks: [
          { type: "prompt", prompt: "say hi", model: "grok" },
          {
            type: "http",
            url: "https://example.com/hook",
            headers: { "x-token": "abc", count: 1 },
            allowedEnvVars: ["TOKEN", 5],
          },
          { type: "agent", prompt: "analyze", model: "explore" },
        ],
      },
    ],
  });
  const hooks = result.settings.SessionStart?.[0]!.hooks ?? [];
  assert.deepEqual(hooks[0], {
    type: "prompt",
    prompt: "say hi",
    model: "grok",
    if: undefined,
    statusMessage: undefined,
    once: undefined,
    timeout: undefined,
  });
  assert.deepEqual(hooks[1], {
    type: "http",
    url: "https://example.com/hook",
    headers: { "x-token": "abc" }, // non-string header dropped
    allowedEnvVars: ["TOKEN"],
    if: undefined,
    statusMessage: undefined,
    once: undefined,
    timeout: undefined,
  });
  assert.equal(hooks[2]?.type, "agent");
});

test("parseHooksConfig rejects callback hooks from persistent config", () => {
  const result = parseHooksConfig({ PreToolUse: [{ hooks: [{ type: "callback", id: "x" }] }] });
  // The matcher is retained but its hooks list ends up empty.
  assert.deepEqual(result.settings.PreToolUse?.[0]!.hooks, []);
  assert.match(result.diagnostics[0] ?? "", /callback.*runtime-only/i);
});

test("parseHooksConfig reports per-hook diagnostics and keeps valid ones", () => {
  const result = parseHooksConfig({
    PreToolUse: [
      {
        hooks: [
          { type: "command" }, // missing command
          { type: "prompt" }, // missing prompt
          { type: "http" }, // missing url
          { type: "mystery" }, // unsupported type
          { type: "command", command: "ok" },
        ],
      },
    ],
  });
  assert.equal(result.settings.PreToolUse?.[0]!.hooks.length, 1);
  assert.equal(result.diagnostics.length, 4);
});

test("parseHooksConfig drops matchers without hooks array", () => {
  const result = parseHooksConfig({ PreToolUse: [{ matcher: "x" }] });
  assert.deepEqual(result.settings, {});
  assert.match(result.diagnostics[0] ?? "", /must contain hooks array/);
});

test("parseHooksConfig attaches pluginName/pluginId/pluginRoot", () => {
  const result = parseHooksConfig({
    PreToolUse: [{ pluginName: "p", pluginId: "pid", pluginRoot: "/x", hooks: [{ type: "command", command: "c" }] }],
  });
  const matchers = result.settings.PreToolUse;
  assert.equal(matchers?.length, 1);
  const matcher = matchers![0]!;
  assert.equal(matcher.pluginName, "p");
  assert.equal(matcher.pluginId, "pid");
  assert.equal(matcher.pluginRoot, "/x");
});

test("matchHookMatcher matches star, exact, alternation and regex", () => {
  assert.equal(matchHookMatcher(undefined, "anything"), true);
  assert.equal(matchHookMatcher("*", "anything"), true);
  assert.equal(matchHookMatcher("read_file", "read_file"), true);
  assert.equal(matchHookMatcher("read_file", "write_file"), false);
  assert.equal(matchHookMatcher("read|write", "write"), true);
  assert.equal(matchHookMatcher("/^edit/", "edit_file"), true);
  assert.equal(matchHookMatcher("/[", "x"), false); // invalid regex
  assert.equal(matchHookMatcher("read_file", undefined), false);
});

test("matchHookCondition matches tool name and $ARGUMENTS substring", () => {
  assert.equal(matchHookCondition(undefined, {}), true);
  assert.equal(matchHookCondition("read_file", { toolName: "read_file" }), true);
  assert.equal(matchHookCondition("read-file", { toolName: "read_file" }), true); // normalized
  assert.equal(matchHookCondition("read_file", { toolName: "write_file" }), false);
  // Pattern is matched as a substring of the serialized tool input; `*` is stripped.
  assert.equal(
    matchHookCondition("read_file(secret)", { toolName: "read_file", toolInput: { text: "contains secret here" } }),
    true,
  );
  assert.equal(
    matchHookCondition("read_file(secret)", { toolName: "read_file", toolInput: { text: "no match" } }),
    false,
  );
  assert.equal(
    matchHookCondition("read_file(*secret*)", { toolName: "read_file", toolInput: { text: "has secret inside" } }),
    true,
  );
  assert.equal(matchHookCondition("bad format!", { toolName: "x" }), false);
  assert.equal(matchHookCondition("read_file(*)", { toolName: "read_file" }), true);
});
