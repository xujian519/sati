import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateText,
  loadActivationOverrides,
  loadPatentComplianceRuleSet,
  loadPatentFullRuleSet,
  type PatentComplianceLoadResult,
  parseRuleSetFromYaml,
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

test("loadActivationOverrides 解析 31 条补丁，无警告", () => {
  const ov = loadActivationOverrides();
  assert.ok(ov.source !== null, "应能找到 activation-overrides.yaml");
  assert.equal(ov.byId.size, 31, "29 条 action 降级 + 2 条语义增强新增（#357：X-REF-003 / IPC-GEN-INV-002）");
  assert.equal(ov.warnings.length, 0, "补丁格式应无警告");
  assert.equal(ov.byId.get("CON-102")?.action, "review");
  assert.ok(ov.byId.has("X-REF-003"), "语义增强补丁存在");
  assert.ok(ov.byId.has("IPC-GEN-INV-002"), "去重补丁存在");
});

test("语义增强补丁（#357）落地：check 级键为增补语义，不改动生成物", () => {
  const { ruleSet, warnings } = loadPatentFullRuleSet();
  assert.deepEqual(warnings, [], "全部补丁应无告警（含引用存在性与键合法性校验）");
  const byId = new Map(ruleSet.rules.map(r => [r.id, r]));

  // ① X-REF-003：追加变体关键词，原有 3 条保留（增补而非替换）
  const xref = byId.get("X-REF-003");
  assert.equal(xref?.check.type, "keyword_blocklist");
  const xrefKeywords = xref?.check.type === "keyword_blocklist" ? xref.check.keywords : [];
  assert.equal(xrefKeywords.length, 6, "原有 3 条 + 追加 3 条 OR 组");
  assert.ok(xrefKeywords.includes("(202X)最高法知民终"), "原有半角大写保留");
  assert.ok(
    xrefKeywords.includes("(202X)最高法知民终|（202X）最高法知民终|(202x)最高法知民终|（202x）最高法知民终"),
    "追加全角/小写变体",
  );

  // ② EX-SEL-004：开否定语境 + 4 个领域放行词（默认词表在代码侧，补丁只追加）
  const exSel = byId.get("EX-SEL-004");
  assert.equal(exSel?.action, "warn", "action 降级结论不变");
  assert.equal(exSel?.check.type, "keyword_blocklist");
  if (exSel?.check.type === "keyword_blocklist") {
    assert.equal(exSel.check.negationContext, true);
    assert.deepEqual(exSel.check.additionalNegationWords, ["防", "反", "抑制", "检测"]);
  }

  // ③ IPC-GEN-INV-002：去重降级，与重复项 EX-INV-007 的升级/降级方向一致（保留前者 warn）
  assert.equal(byId.get("IPC-GEN-INV-002")?.action, "log");
  assert.equal(byId.get("EX-INV-007")?.action, "warn");
});

test("rule 级 additionalNegationWords：两键正交（开开关才生效，缺开关显式告警）", () => {
  const withFlag = parseRuleSetFromYaml(
    [
      "rules:",
      "  - id: T-NEG-001",
      "    name: 领域放行词样本",
      "    severity: major",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      '      keywords: ["窃听"]',
      "      negationContext: true",
      '      additionalNegationWords: ["防"]',
      "",
    ].join("\n"),
  );
  assert.deepEqual(withFlag.issues, [], "两键齐备不应告警");
  assert.equal(evaluateText("本发明提供一种防窃听装置。", withFlag.ruleSet).violations.length, 0, "领域词应放行");
  assert.equal(evaluateText("本发明提供一种窃听装置。", withFlag.ruleSet).violations.length, 1, "不得过度放行");

  // 缺开关 ⇒ 词表不生效，且必须在加载期可见（否则是"声明了却不生效"的死配置）
  const withoutFlag = parseRuleSetFromYaml(
    [
      "rules:",
      "  - id: T-NEG-002",
      "    name: 领域放行词样本（缺开关）",
      "    severity: major",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      '      keywords: ["窃听"]',
      '      additionalNegationWords: ["防"]',
      "",
    ].join("\n"),
  );
  assert.ok(
    withoutFlag.issues.some(issue => issue.message.includes("T-NEG-002") && issue.message.includes("negationContext")),
    `应告警缺开关，实际：${JSON.stringify(withoutFlag.issues)}`,
  );
  assert.equal(
    evaluateText("本发明提供一种防窃听装置。", withoutFlag.ruleSet).violations.length,
    1,
    "缺开关时词表不生效",
  );
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

// ---------------------------------------------------------------------------
// 补丁结构性问题必须可见：「评审写了但没生效」此前是静默的
//   （非 action 字段一律被忽略、引用不存在的 id 一律被忽略）
// ---------------------------------------------------------------------------

/** 用临时 SATI_RULES_DIR 注入一份自造 activation-overrides.yaml，跑 body 后还原环境。 */
function withTempOverrides(body: string, run: (loaded: PatentComplianceLoadResult) => void): void {
  const saved = process.env.SATI_RULES_DIR;
  const tmp = mkdtempSync(join(tmpdir(), "sati-overrides-"));
  const patentDir = join(tmp, "patent");
  try {
    mkdirSync(patentDir);
    // compliance 走临时目录；nuo 文件不在临时目录时回退到仓库根（本用例只关心补丁告警）
    writeFileSync(join(patentDir, "compliance.yaml"), "rules: []\n", "utf8");
    writeFileSync(join(patentDir, "activation-overrides.yaml"), body, "utf8");
    process.env.SATI_RULES_DIR = tmp;
    run(loadPatentFullRuleSet());
  } finally {
    if (saved === undefined) delete process.env.SATI_RULES_DIR;
    else process.env.SATI_RULES_DIR = saved;
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("补丁引用不存在的 id → 告警（拼错 id 不再静默失效）", () => {
  withTempOverrides(
    ["overrides:", "  NO-SUCH-RULE:", "    action: log", '    reason: "拼错的 id"', ""].join("\n"),
    loaded => {
      assert.ok(
        loaded.warnings.some(w => w.includes("NO-SUCH-RULE") && w.includes("无此 id")),
        `应告警「规则集中无此 id」，实际：${JSON.stringify(loaded.warnings)}`,
      );
    },
  );
});

test("补丁未知键 → 告警（拼错键名不再静默失效），已知键仍生效", () => {
  withTempOverrides(
    ["overrides:", "  CON-102:", "    action: review", '    addKeyword: ["x"]', '    reason: "键名拼错"', ""].join(
      "\n",
    ),
    loaded => {
      assert.ok(
        loaded.warnings.some(w => w.includes("CON-102") && w.includes("未知键") && w.includes("addKeyword")),
        `应告警未知键，实际：${JSON.stringify(loaded.warnings)}`,
      );
      assert.equal(loaded.ruleSet.rules.find(r => r.id === "CON-102")?.action, "review", "已知键不应被一并丢弃");
    },
  );
});

test("check 级补丁打在非 keyword_blocklist 规则上 → 告警并忽略，规则保持原样", () => {
  withTempOverrides(
    [
      "overrides:",
      "  IPC-GEN-INV-001:",
      '    addKeywords: ["事后诸葛亮"]',
      '    reason: "结构规则不支持关键词增补"',
      "",
    ].join("\n"),
    loaded => {
      assert.ok(
        loaded.warnings.some(w => w.includes("IPC-GEN-INV-001") && w.includes("仅支持 keyword_blocklist")),
        `应告警 check 级键的适用范围，实际：${JSON.stringify(loaded.warnings)}`,
      );
      assert.equal(
        loaded.ruleSet.rules.find(r => r.id === "IPC-GEN-INV-001")?.check.type,
        "structural_analysis",
        "check 应保持原样",
      );
    },
  );
});

test("补丁增补词表但未开开关 → 告警（与资产校验同一条判据）", () => {
  withTempOverrides(
    [
      "overrides:",
      "  EX-SEL-004:",
      '    additionalNegationWords: ["防"]',
      '    reason: "只写了词表，没开开关"',
      "",
    ].join("\n"),
    loaded => {
      assert.ok(
        loaded.warnings.some(w => w.includes("EX-SEL-004") && w.includes("negationContext")),
        `应告警两键组合非法，实际：${JSON.stringify(loaded.warnings)}`,
      );
    },
  );
});

test("补丁无可识别字段 → 告警（避免空条目被当成生效的评审结论）", () => {
  withTempOverrides(["overrides:", "  CON-102:", '    reason: "只有 reason，没有处置"', ""].join("\n"), loaded => {
    assert.ok(
      loaded.warnings.some(w => w.includes("CON-102") && w.includes("无有效字段")),
      `应告警空补丁，实际：${JSON.stringify(loaded.warnings)}`,
    );
  });
});
