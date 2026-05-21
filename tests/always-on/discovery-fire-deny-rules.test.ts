import assert from "node:assert/strict";
import test from "node:test";
import { ALWAYS_ON_EXECUTION_DENY_RULES } from "../../src/always-on/runtime/DiscoveryFire.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { matchPermissionRule } from "../../src/permission/index.js";
import { createPilotDeckTestTool, createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("ALWAYS_ON_EXECUTION_DENY_RULES contains git push and git remote rules", () => {
  assert.ok(ALWAYS_ON_EXECUTION_DENY_RULES.length >= 4);
  const patterns = ALWAYS_ON_EXECUTION_DENY_RULES.map((r) => r.pattern);
  assert.ok(patterns.includes("git push*"));
  assert.ok(patterns.includes("git remote*"));
  assert.ok(patterns.includes("*git push*"));
  assert.ok(patterns.includes("*git remote*"));
  for (const rule of ALWAYS_ON_EXECUTION_DENY_RULES) {
    assert.equal(rule.behavior, "deny");
    assert.equal(rule.toolName, "bash");
  }
});

test("deny rules match git push commands via matchPermissionRule", () => {
  const pushRule = ALWAYS_ON_EXECUTION_DENY_RULES.find((r) => r.pattern === "git push*")!;
  const chainedPushRule = ALWAYS_ON_EXECUTION_DENY_RULES.find((r) => r.pattern === "*git push*")!;

  assert.ok(matchPermissionRule(pushRule, "bash", { command: "git push origin HEAD:main" }));
  assert.ok(matchPermissionRule(pushRule, "bash", { command: "git push" }));
  assert.ok(!matchPermissionRule(pushRule, "bash", { command: "git status" }));
  assert.ok(!matchPermissionRule(pushRule, "bash", { command: "git log --oneline" }));

  assert.ok(matchPermissionRule(chainedPushRule, "bash", { command: "cd /tmp && git push origin main" }));
  assert.ok(matchPermissionRule(chainedPushRule, "bash", { command: "git add . && git commit -m x && git push" }));
  assert.ok(!matchPermissionRule(chainedPushRule, "bash", { command: "git commit -m 'fix'" }));
});

test("deny rules match git remote commands via matchPermissionRule", () => {
  const remoteRule = ALWAYS_ON_EXECUTION_DENY_RULES.find((r) => r.pattern === "git remote*")!;
  const chainedRemoteRule = ALWAYS_ON_EXECUTION_DENY_RULES.find((r) => r.pattern === "*git remote*")!;

  assert.ok(matchPermissionRule(remoteRule, "bash", { command: "git remote add origin https://example.com" }));
  assert.ok(matchPermissionRule(remoteRule, "bash", { command: "git remote set-url origin https://new.com" }));
  assert.ok(!matchPermissionRule(remoteRule, "bash", { command: "git status" }));

  assert.ok(matchPermissionRule(chainedRemoteRule, "bash", { command: "cd /tmp && git remote -v" }));
});

test("deny rules block bash in bypassPermissions via PermissionRuntime", async () => {
  const runtime = new PermissionRuntime();
  const bashTool = createPilotDeckTestTool({ name: "bash", readOnly: false, kind: "shell" });
  const { context } = createPilotDeckToolRuntimeFixture({
    permissionMode: "bypassPermissions",
    canPrompt: false,
  });

  context.permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: "bypassPermissions",
    canPrompt: false,
    rules: {
      deny: [...ALWAYS_ON_EXECUTION_DENY_RULES],
    },
  });

  const pushResult = await runtime.decide(bashTool, { command: "git push origin main" }, context, "call-push");
  assert.equal(pushResult.type, "deny");

  const chainedPushResult = await runtime.decide(
    bashTool,
    { command: "cd /some/dir && git push origin HEAD:main" },
    context,
    "call-chained-push",
  );
  assert.equal(chainedPushResult.type, "deny");

  const remoteResult = await runtime.decide(bashTool, { command: "git remote add origin https://x.com" }, context, "call-remote");
  assert.equal(remoteResult.type, "deny");
});

test("deny rules do NOT block safe git commands in bypassPermissions", async () => {
  const runtime = new PermissionRuntime();
  const bashTool = createPilotDeckTestTool({ name: "bash", readOnly: false, kind: "shell" });
  const { context } = createPilotDeckToolRuntimeFixture({
    permissionMode: "bypassPermissions",
    canPrompt: false,
  });

  context.permissionContext = createDefaultPermissionContext({
    cwd: context.cwd,
    mode: "bypassPermissions",
    canPrompt: false,
    rules: {
      deny: [...ALWAYS_ON_EXECUTION_DENY_RULES],
    },
  });

  const commitResult = await runtime.decide(bashTool, { command: "git commit -m 'test'" }, context, "call-commit");
  assert.equal(commitResult.type, "allow");

  const diffResult = await runtime.decide(bashTool, { command: "git diff --stat" }, context, "call-diff");
  assert.equal(diffResult.type, "allow");

  const lsResult = await runtime.decide(bashTool, { command: "ls -la" }, context, "call-ls");
  assert.equal(lsResult.type, "allow");
});
