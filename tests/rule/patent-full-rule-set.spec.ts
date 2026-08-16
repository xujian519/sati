import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadActivationOverrides,
  loadPatentComplianceRuleSet,
  loadPatentFullRuleSet,
  RuleOutputGate,
} from "../../src/rule/index.js";

test("loadPatentFullRuleSet 合并 compliance + nuo 全量规则（4 + 96 = 100 条）", () => {
  const loaded = loadPatentFullRuleSet();
  assert.ok(loaded.source !== null, "应能找到规则资产");
  assert.equal(loaded.ruleSet.rules.length, 100, "compliance 4 条 + nuo 96 条");
  const ids = new Set(loaded.ruleSet.rules.map(r => r.id));
  assert.ok(ids.has("PAT-RISK-001"), "compliance 规则保留");
  assert.ok(ids.has("CON-COMP-0101"), "nuo 规则加载");
  assert.ok(ids.has("PR-OA-001"), "nuo 实践规则加载");
});

test("activation overrides 降级生效：block → review/warn/log", () => {
  const { ruleSet } = loadPatentFullRuleSet();
  const byId = new Map(ruleSet.rules.map(r => [r.id, r]));

  // 保留 block（占位符检测，无误伤）
  assert.equal(byId.get("CON-COMP-0101")?.action, "block");
  assert.equal(byId.get("X-REF-003")?.action, "block");

  // 降级 review（编造风险保留人工关注）
  assert.equal(byId.get("CON-102")?.action, "review");

  // 降级 warn（完整性期望 → 完整性提醒）
  assert.equal(byId.get("EX-CLM-001")?.action, "warn");
  assert.equal(byId.get("EX-SEL-004")?.action, "warn");
  assert.equal(byId.get("EX-DIS-002")?.action, "warn");
  assert.equal(byId.get("CON-401")?.action, "warn");

  // 降级 log（语义弱/过宽/重复）
  assert.equal(byId.get("CON-301")?.action, "log");
  assert.equal(byId.get("CON-COMP-0104")?.action, "log");
  assert.equal(byId.get("PR-OA-002")?.action, "log");
});

test("override 只改 action，不改 name/check 等字段（字段级合并）", () => {
  const { ruleSet } = loadPatentFullRuleSet();
  const byId = new Map(ruleSet.rules.map(r => [r.id, r]));
  const con102 = byId.get("CON-102");
  assert.equal(con102?.action, "review");
  assert.equal(con102?.name, "禁止编造对比文件", "name 保留");
  assert.equal(con102?.check.type, "keyword_blocklist", "check 保留");
  assert.ok(Array.isArray((con102?.check as { keywords?: string[] }).keywords), "keywords 保留");
});

test("patent-full 可被 RuleOutputGate 消费：占位符命中 → needsApproval", () => {
  const { ruleSet } = loadPatentFullRuleSet();
  const gate = new RuleOutputGate(ruleSet);
  // 占位专利号（block 保留）→ 挂起审批
  const hit = gate.process("现有技术 CNXXXXXX 公开了一种方法。");
  assert.ok(hit.blockHits.includes("CON-COMP-0101"));
  assert.equal(hit.needsApproval, true);

  // 合法真实专利号 → 不误伤
  const clean = gate.process("现有技术 CN201910123456A 公开了一种方法。");
  assert.equal(clean.blockHits.includes("CON-COMP-0101"), false);
});

test("scope 差异：patent 保持 4 条，patent-full 100 条（存量行为不变）", () => {
  const patent = loadPatentComplianceRuleSet();
  const full = loadPatentFullRuleSet();
  assert.equal(patent.ruleSet.rules.length, 4, "scope=patent 保持 compliance 4 条不变");
  assert.equal(full.ruleSet.rules.length, 100, "scope=patent-full 全量");
});

test("loadActivationOverrides 解析 29 条补丁，无警告", () => {
  const ov = loadActivationOverrides();
  assert.ok(ov.source !== null, "应能找到 activation-overrides.yaml");
  assert.equal(ov.byId.size, 29, "29 条降级规则");
  assert.equal(ov.warnings.length, 0, "补丁格式应无警告");
  assert.equal(ov.byId.get("CON-102")?.action, "review");
});

test("目录容错：损坏的 nuo 文件不阻塞加载（跳过并告警）", () => {
  const saved = process.env.SATI_RULES_DIR;
  const tmp = mkdtempSync(join(tmpdir(), "sati-rules-"));
  const patentDir = join(tmp, "patent");
  try {
    // SATI_RULES_DIR 契约：规则根目录，平铺资产在 <root>/patent/*.yaml
    mkdirSync(patentDir);
    writeFileSync(join(patentDir, "compliance.yaml"), "rules: []\n", "utf8");
    writeFileSync(join(patentDir, "nuo-patent-law.yaml"), "rules: [ { id: 坏\n", "utf8");
    process.env.SATI_RULES_DIR = tmp;
    const loaded = loadPatentFullRuleSet();
    // 不抛错即通过；损坏文件应产生告警（fallback 到仓库根加载合法文件）
    assert.ok(loaded.ruleSet.rules.length > 0, "规则集不因单文件损坏而空");
    assert.ok(
      loaded.warnings.some(w => w.includes("规则资产加载失败") || w.includes("nuo")),
      "损坏文件应产生告警",
    );
  } finally {
    if (saved === undefined) delete process.env.SATI_RULES_DIR;
    else process.env.SATI_RULES_DIR = saved;
    rmSync(tmp, { recursive: true, force: true });
  }
});
