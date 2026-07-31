import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime, createDefaultPermissionContext, type PermissionRule } from "../../src/permission/index.js";
import { rulesToPolicyDenyRules } from "../../src/rule/index.js";
import { matchPermissionRule } from "../../src/permission/policy/matchPermissionRule.js";
import { loadPatentComplianceRuleSet } from "../../src/rule/index.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../src/tool/index.js";
import type { ConstitutionalRule, RuleSet } from "../../src/rule/index.js";

function ruleSet(rules: ConstitutionalRule[]): RuleSet {
  return { rules };
}

const BLOCK_KEYWORD_RULE: ConstitutionalRule = {
  id: "CON-102",
  name: "违法排除",
  severity: "critical",
  action: "block",
  check: { type: "keyword_blocklist", keywords: ["赌博|博彩", "毒品"] },
};

test("rulesToPolicyDenyRules compiles block keyword rules to policy deny rules", () => {
  const { rules, skipped } = rulesToPolicyDenyRules(ruleSet([BLOCK_KEYWORD_RULE]));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.source, "policy");
  assert.equal(rules[0]?.behavior, "deny");
  assert.equal(rules[0]?.toolName, "*");
  assert.equal(rules[0]?.pattern, "text:赌博|博彩|毒品");
  assert.equal(skipped.length, 0);
});

test("rulesToPolicyDenyRules skips non-block actions", () => {
  const { rules, skipped } = rulesToPolicyDenyRules(
    ruleSet([
      {
        id: "W1",
        name: "warn",
        severity: "minor",
        action: "warn",
        check: { type: "keyword_blocklist", keywords: ["绝对"] },
      },
    ]),
  );
  assert.equal(rules.length, 0);
  assert.equal(skipped[0]?.ruleId, "W1");
});

test("rulesToPolicyDenyRules skips negationContext rules by default, opt-in includes them", () => {
  const negationRule: ConstitutionalRule = {
    id: "CON-102",
    name: "否定语境",
    severity: "critical",
    action: "block",
    check: { type: "keyword_blocklist", keywords: ["赌博"], negationContext: true },
  };
  const skipped = rulesToPolicyDenyRules(ruleSet([negationRule]));
  assert.equal(skipped.rules.length, 0);
  assert.equal(skipped.skipped[0]?.ruleId, "CON-102");
  const included = rulesToPolicyDenyRules(ruleSet([negationRule]), { includeNegationContext: true });
  assert.equal(included.rules.length, 1);
});

test("rulesToPolicyDenyRules skips unsupported check types", () => {
  const { rules, skipped } = rulesToPolicyDenyRules(
    ruleSet([
      {
        id: "C1",
        name: "citation",
        severity: "critical",
        action: "block",
        check: { type: "citation_analysis", statutes: { 专利法: { max: 78 } } },
      },
    ]),
  );
  assert.equal(rules.length, 0);
  assert.match(skipped[0]?.reason ?? "", /暂不支持/);
});

test("rulesToPolicyDenyRules respects maxKeywordsPerRule", () => {
  const { rules } = rulesToPolicyDenyRules(ruleSet([BLOCK_KEYWORD_RULE]), { maxKeywordsPerRule: 1 });
  assert.equal(rules[0]?.pattern, "text:赌博");
});

test("matchPermissionRule text: pattern matches serialized tool input", () => {
  const rule: PermissionRule = {
    source: "policy",
    behavior: "deny",
    toolName: "*",
    pattern: "text:赌博|博彩",
  };
  const ctx = createDefaultPermissionContext({ cwd: "/tmp" });
  assert.equal(matchPermissionRule(rule, "write_file", { file_path: "a.txt", content: "包含赌博关键词" }, ctx), true);
  assert.equal(matchPermissionRule(rule, "write_file", { file_path: "a.txt", content: "正常内容" }, ctx), false);
  assert.equal(matchPermissionRule(rule, "bash", { command: "curl 博彩网站" }, ctx), true);
  assert.equal(matchPermissionRule(rule, "get_current_time", undefined, ctx), false);
});

test("matchPermissionRule text: pattern is case-insensitive and ignores JSON keys", () => {
  const rule: PermissionRule = {
    source: "policy",
    behavior: "deny",
    toolName: "*",
    pattern: "text:赌博|BETTING",
  };
  const ctx = createDefaultPermissionContext({ cwd: "/tmp" });
  // 大小写不敏感：BETTING 命中 "betting"
  assert.equal(matchPermissionRule(rule, "write_file", { content: "contains betting keywords" }, ctx), true);
  // 不匹配 JSON key：key 名含 "gambling" 但值不含 → 不命中
  assert.equal(matchPermissionRule(rule, "web_search", { gambling: "safe query" }, ctx), false);
  // 值含关键词（大小写变体）→ 命中
  assert.equal(matchPermissionRule(rule, "web_search", { query: "Betting Site" }, ctx), true);
});

test("matchPermissionRule text: pattern is case-sensitive substring over JSON", () => {
  const rule: PermissionRule = {
    source: "policy",
    behavior: "deny",
    toolName: "*",
    pattern: "text:专利结论",
  };
  const ctx = createDefaultPermissionContext({ cwd: "/tmp" });
  assert.equal(matchPermissionRule(rule, "web_search", { query: "专利结论 侵权" }, ctx), true);
  assert.equal(matchPermissionRule(rule, "web_search", { query: "专利知识" }, ctx), false);
});

// ---------------------------------------------------------------------------
// PermissionRuntime 集成：policy deny 优先级高于 user/session allow
// ---------------------------------------------------------------------------

function makeTool(): SatiToolDefinition {
  return {
    name: "write_file",
    description: "test tool",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function makeContext(rules: { allow?: PermissionRule[]; deny?: PermissionRule[] }): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/tmp",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd: "/tmp",
      canPrompt: true,
      rules: { allow: rules.allow ?? [], deny: rules.deny ?? [], ask: [] },
    }),
  };
}

test("PermissionRuntime: policy deny beats user allow", async () => {
  const runtime = new PermissionRuntime();
  const tool = makeTool();
  const policyDeny: PermissionRule = { source: "policy", behavior: "deny", toolName: "*", pattern: "text:赌博" };
  const userAllow: PermissionRule = { source: "user", behavior: "allow", toolName: "write_file" };
  const decision = await runtime.decide(
    tool,
    { file_path: "a.txt", content: "涉及赌博内容" },
    makeContext({ deny: [policyDeny], allow: [userAllow] }),
    "call-1",
  );
  assert.equal(decision.type, "deny");
  if (decision.type === "deny") {
    assert.deepEqual(decision.reason.type === "rule" ? decision.reason.rule.source : null, "policy");
  }
});

test("PermissionRuntime: policy deny cannot be overridden by session allow", async () => {
  const runtime = new PermissionRuntime();
  const tool = makeTool();
  const policyDeny: PermissionRule = { source: "policy", behavior: "deny", toolName: "*", pattern: "text:博彩" };
  const sessionAllow: PermissionRule = { source: "session", behavior: "allow", toolName: "write_file" };
  const decision = await runtime.decide(
    tool,
    { file_path: "a.txt", content: "涉及博彩内容" },
    makeContext({ deny: [policyDeny], allow: [sessionAllow] }),
    "call-2",
  );
  assert.equal(decision.type, "deny");
});

test("PermissionRuntime: policy deny passes when input is clean", async () => {
  const runtime = new PermissionRuntime();
  const tool = makeTool();
  const policyDeny: PermissionRule = { source: "policy", behavior: "deny", toolName: "*", pattern: "text:赌博" };
  const decision = await runtime.decide(
    tool,
    { file_path: "a.txt", content: "正常内容" },
    makeContext({ deny: [policyDeny], allow: [] }),
    "call-3",
  );
  // 非只读工具、无 allow 规则 → 默认模式 ask
  assert.equal(decision.type, "ask");
});

test("rulesToPolicyDenyRules on bundled patent compliance asset yields policy rules", () => {
  const { ruleSet } = loadPatentComplianceRuleSet();
  const { rules, skipped } = rulesToPolicyDenyRules(ruleSet);
  // compliance.yaml 全部为 warn/review，无 block → 全部跳过
  assert.equal(rules.length, 0);
  assert.ok(skipped.length >= 4);
});
