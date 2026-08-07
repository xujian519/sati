/**
 * 分层规则包（Rule Pack）测试 — 对应方案 §五 测试计划 1-9。
 *
 * 约定：测试从仓库根运行（pnpm build && node --test dist/tests/rule/），
 * "真实仓库"用例依赖 cwd 下的 rules/base 与 .sati/（当前无 rules.yaml 清单）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import {
  candidatePackDirs,
  evaluateText,
  loadRulePack,
  loadRuleSetDir,
  mergeRuleSets,
  parseRulePackManifest,
  resolvePackDir,
  summarizeRulePackLayers,
  validatePackManifest,
} from "../../src/rule/index.js";

/** 在临时目录搭一个三层 fixture：base + domain + overrides + 项目清单。 */
function makePackFixture(): { manifestPath: string; base: string; domain: string } {
  const root = mkdtempSync(join(tmpdir(), "sati-rule-pack-"));
  const base = join(root, "base-pack");
  const domain = join(root, "mech-pack");
  const local = join(root, "local-rules");
  mkdirSync(base);
  mkdirSync(domain);
  mkdirSync(local);

  writeFileSync(
    join(base, "pack.yaml"),
    ["id: sati-rules-test-base", "version: 0.1.0", "description: 测试基础包"].join("\n"),
  );
  writeFileSync(
    join(base, "rules.yaml"),
    [
      'version: "1.0"',
      "rules:",
      "  shared_rule:",
      "    id: RULE-SHARED",
      "    name: 共享规则",
      "    severity: minor",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      "      keywords:",
      "        - BASEWORD",
      "  base_only:",
      "    id: BASE-ONLY",
      "    name: 基础独有",
      "    severity: minor",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      "      keywords:",
      "        - BASEONLY",
    ].join("\n"),
  );

  writeFileSync(
    join(domain, "pack.yaml"),
    ["id: sati-rules-test-domain-mech", "version: 0.1.0", "domain: mechanical", "description: 测试领域包"].join("\n"),
  );
  writeFileSync(
    join(domain, "rules.yaml"),
    [
      'version: "1.0"',
      "rules:",
      "  shared_rule_override:",
      "    id: RULE-SHARED",
      "    name: 共享规则（领域覆盖版）",
      "    severity: minor",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      "      keywords:",
      "        - DOMAINWORD",
      "  domain_only:",
      "    id: DOMAIN-ONLY",
      "    name: 领域独有",
      "    severity: minor",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      "      keywords:",
      "        - DOMAINONLY",
    ].join("\n"),
  );

  // overrides 无 pack.yaml（项目私有层不强制清单）
  writeFileSync(
    join(local, "rules.yaml"),
    [
      'version: "1.0"',
      "rules:",
      "  local_only:",
      "    id: LOCAL-ONLY",
      "    name: 项目私有",
      "    severity: minor",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      "      keywords:",
      "        - LOCALWORD",
    ].join("\n"),
  );

  mkdirSync(join(root, ".sati"));
  const manifestPath = join(root, ".sati", "rules.yaml");
  writeFileSync(manifestPath, [`base: ${base}`, `domains:`, `  - ${domain}`, `overrides: ../local-rules`].join("\n"));
  return { manifestPath, base, domain };
}

// ---------------------------------------------------------------------------
// 1. 无清单默认加载 rules/base（零配置可用）
// ---------------------------------------------------------------------------
test("loadRulePack without manifest falls back to bundled rules/base", () => {
  const result = loadRulePack();
  assert.equal(result.manifestPath, null);
  assert.equal(result.manifestMtimeMs, null);
  const ids = result.ruleSet.rules.map(r => r.id);
  assert.ok(ids.includes("INV-METHOD-001"), "base 创造性三步法规则应加载");
  assert.ok(ids.includes("INV-EVIDENCE-001"), "base 显而易见性证据规则应加载");
  assert.ok(ids.includes("PAT-RISK-001"), "base 合规规则应加载");
  assert.ok(ids.includes("BASE-CITE-001"), "base 引用规则应加载");
  for (const id of ids) assert.equal(result.layers.get(id), "base");
  assert.ok(result.sources.length >= 3);
});

// ---------------------------------------------------------------------------
// 2. 三层合并：base → domains → overrides，同 id 后者覆盖并记审计 warning
// ---------------------------------------------------------------------------
test("loadRulePack merges base → domains → overrides with id override audit", () => {
  const { manifestPath } = makePackFixture();
  const result = loadRulePack({ manifestPath });
  const ids = result.ruleSet.rules.map(r => r.id).sort();
  assert.deepEqual(ids, ["BASE-ONLY", "DOMAIN-ONLY", "LOCAL-ONLY", "RULE-SHARED"]);
  assert.equal(result.manifestPath, manifestPath);
  assert.equal(typeof result.manifestMtimeMs, "number");
  // 覆盖审计：RULE-SHARED 由 domain 层覆盖 base
  assert.ok(
    result.warnings.some(w => /RULE-SHARED 被 domain:.+ 层覆盖（原: base）/.test(w)),
    `warnings 应含覆盖审计，实际: ${result.warnings.join(" | ")}`,
  );
  // 覆盖生效：domain 版关键词命中，base 版不再命中
  assert.equal(evaluateText("出现 DOMAINWORD。", result.ruleSet).violations.length, 1);
  assert.equal(evaluateText("出现 BASEWORD。", result.ruleSet).violations.length, 0);
  // 摘要按规则最终归属层统计（RULE-SHARED 被覆盖后归 domain 层）
  const summary = summarizeRulePackLayers(result.layers);
  assert.match(summary, /domain:.+ 2/);
  assert.match(summary, /base 1/);
  assert.match(summary, /overrides 1/);
});

// ---------------------------------------------------------------------------
// 3. domain 层目录缺失 → warning 不阻塞
// ---------------------------------------------------------------------------
test("loadRulePack skips missing domain layer with warning", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-rule-pack-missing-"));
  const base = join(root, "base-pack");
  mkdirSync(base);
  writeFileSync(
    join(base, "pack.yaml"),
    ["id: sati-rules-test-base", "version: 0.1.0", "description: 测试基础包"].join("\n"),
  );
  writeFileSync(
    join(base, "rules.yaml"),
    [
      'version: "1.0"',
      "rules:",
      "  base_only:",
      "    id: BASE-ONLY",
      "    name: 基础独有",
      "    severity: minor",
      "    action: warn",
      "    check:",
      "      type: keyword_blocklist",
      "      keywords:",
      "        - BASEONLY",
    ].join("\n"),
  );
  const manifestPath = join(root, "rules.yaml");
  writeFileSync(manifestPath, [`base: ${base}`, `domains:`, `  - ${join(root, "not-exist")}`].join("\n"));
  const result = loadRulePack({ manifestPath });
  // 绝对路径引用的缺失层：目录不存在记 warning，不阻塞
  assert.ok(
    result.warnings.some(w => w.includes("规则目录不存在")),
    `warnings 应含缺失层提示，实际: ${result.warnings.join(" | ")}`,
  );
  assert.equal(result.ruleSet.rules.length, 1, "base 层仍应正常加载");
});

// ---------------------------------------------------------------------------
// 4. 项目清单解析：合法结构 / 缺 base / domains 非数组
// ---------------------------------------------------------------------------
test("parseRulePackManifest parses valid manifest and rejects malformed ones", () => {
  const manifest = parseRulePackManifest("base: base\ndomains: [mechanical, medical]\noverrides: ./local\n");
  assert.deepEqual(manifest, { base: "base", domains: ["mechanical", "medical"], overrides: "./local" });
  assert.deepEqual(parseRulePackManifest("base: base").domains, []);
  assert.throws(() => parseRulePackManifest("domains: [mechanical]"), /base/);
  assert.throws(() => parseRulePackManifest("base: base\ndomains: mechanical"), /字符串数组/);
  assert.throws(() => parseRulePackManifest("base: [unclosed"), /YAML/);
});

// ---------------------------------------------------------------------------
// 5. 入库资产零 issue：rules/base 与 rules/domains/* 全部可加载
// ---------------------------------------------------------------------------
test("bundled rules/base and rules/domains/* load via loadRuleSetDir with zero issues", () => {
  const dirs = [
    "rules/base",
    "rules/domains/mechanical",
    "rules/domains/medical",
    "rules/domains/chemical",
    "rules/domains/software",
  ];
  let totalRules = 0;
  for (const dir of dirs) {
    const { ruleSets, warnings } = loadRuleSetDir(dir);
    assert.deepEqual(warnings, [], `${dir} 应零警告，实际: ${warnings.map(w => w.message).join(" | ")}`);
    totalRules += ruleSets.reduce((n, rs) => n + rs.rules.length, 0);
  }
  assert.ok(totalRules >= 6, `入库规则总数应 ≥ 6，实际 ${totalRules}`);
});

// ---------------------------------------------------------------------------
// 6. pack.yaml schema 校验：样板包通过；非法清单报错；领域包必须声明 domain
// ---------------------------------------------------------------------------
test("validatePackManifest accepts bundled pack manifests and rejects invalid ones", () => {
  const parse = (p: string) => parseDocument(readFileSync(p, "utf8")).toJS();
  assert.deepEqual(validatePackManifest(parse("rules/base/pack.yaml")), []);
  assert.deepEqual(validatePackManifest(parse("rules/domains/mechanical/pack.yaml"), { requireDomain: true }), []);
  assert.deepEqual(validatePackManifest(parse("rules/domains/medical/pack.yaml"), { requireDomain: true }), []);
  // 领域包缺 domain → requireDomain 时报错
  const issues = validatePackManifest(parse("rules/base/pack.yaml"), { requireDomain: true });
  assert.ok(issues.some(i => i.field === "domain"));
  // 非法清单
  const bad = validatePackManifest({ id: "wrong-id", version: "1.0", description: "" });
  assert.ok(bad.some(i => i.field === "id"));
  assert.ok(bad.some(i => i.field === "version"));
  assert.ok(bad.some(i => i.field === "description"));
  assert.ok(
    validatePackManifest({ id: "sati-rules-x", version: "0.1.0", description: "ok", extra: 1 }).some(
      i => i.field === "extra",
    ),
  );
});

// ---------------------------------------------------------------------------
// 7. 领域误报基线：domain 过滤跳过异领域规则；缺省不过滤（向后兼容）
// ---------------------------------------------------------------------------
test("evaluateText domain option skips foreign-domain rules but keeps universal ones", () => {
  const mech = loadRuleSetDir("rules/domains/mechanical").ruleSets;
  const medical = loadRuleSetDir("rules/domains/medical").ruleSets;
  const ruleSet = mergeRuleSets([...mech, ...medical]);
  // 提及用途特征但不分析产品本身影响 → MED-INV-001 命中
  const text = "该区别特征在于治疗用途，据此认定具备创造性。";
  const unfiltered = evaluateText(text, ruleSet);
  assert.ok(
    unfiltered.violations.some(v => v.ruleId === "MED-INV-001"),
    "缺省不过滤应命中 medical 规则",
  );
  const mechanical = evaluateText(text, ruleSet, undefined, { domain: "mechanical" });
  assert.ok(!mechanical.violations.some(v => v.ruleId === "MED-INV-001"), "domain=mechanical 时 medical 规则应跳过");
  const medicalScoped = evaluateText(text, ruleSet, undefined, { domain: "medical" });
  assert.ok(medicalScoped.violations.some(v => v.ruleId === "MED-INV-001"));
});

// ---------------------------------------------------------------------------
// 8. 包解析回归安全网：SATI_RULES_DIR 优先；绝对路径直通；未知包名返回 null
// ---------------------------------------------------------------------------
test("candidatePackDirs and resolvePackDir resolution semantics", () => {
  const previous = process.env.SATI_RULES_DIR;
  try {
    process.env.SATI_RULES_DIR = "/tmp/sati-rules-env";
    assert.equal(candidatePackDirs("base")[0], resolve("/tmp/sati-rules-env", "base"));
    const withoutEnv = ((): string[] => {
      delete process.env.SATI_RULES_DIR;
      return candidatePackDirs("base");
    })();
    assert.ok(withoutEnv.every(c => !c.startsWith("/tmp/sati-rules-env")));
    // 绝对路径直通
    const fixture = mkdtempSync(join(tmpdir(), "sati-rule-pack-abs-"));
    assert.equal(resolvePackDir(fixture), fixture);
    assert.equal(resolvePackDir(join(tmpdir(), "definitely-not-exist-xyz")), null);
    // 内置名：base 可解析（仓库 rules/base），未知名返回 null
    assert.equal(resolvePackDir("base"), resolve(process.cwd(), "rules", "base"));
    assert.equal(resolvePackDir("nonexistent-pack-xyz"), null);
  } finally {
    if (previous === undefined) delete process.env.SATI_RULES_DIR;
    else process.env.SATI_RULES_DIR = previous;
  }
});

// ---------------------------------------------------------------------------
// 9. rule_check scope=pack 回归：真实仓库（无清单）加载 base 并可检出违规
// ---------------------------------------------------------------------------
test("loadRulePack result is consumable by evaluateText end-to-end", () => {
  const { ruleSet, layers } = loadRulePack();
  // 显而易见性断言无证据 → INV-EVIDENCE-001 挂 review
  const found = evaluateText("该区别特征容易想到，故不具备创造性。", ruleSet);
  assert.ok(found.violations.some(v => v.ruleId === "INV-EVIDENCE-001" && v.action === "review"));
  // 否定语境豁免：否定词表为保守镜像（text-utils.DEFAULT_NEGATION_WORDS），
  // "不属于"在表内；"并非"不在表内（仍命中，防误放行取向）
  const negated = evaluateText("该特征不属于容易想到的情形。", ruleSet);
  assert.ok(!negated.violations.some(v => v.ruleId === "INV-EVIDENCE-001"));
  assert.match(summarizeRulePackLayers(layers), /^base \d+$/);
});

// ---------------------------------------------------------------------------
// 附：入库目录清单文件存在性（防遗漏 pack.yaml）
// ---------------------------------------------------------------------------
test("every bundled pack dir ships a pack.yaml manifest", () => {
  for (const dir of readdirSync("rules/domains")) {
    const manifest = join("rules", "domains", dir, "pack.yaml");
    assert.doesNotThrow(() => readFileSync(manifest, "utf8"), `${dir} 缺少 pack.yaml`);
  }
  assert.doesNotThrow(() => readFileSync("rules/base/pack.yaml", "utf8"));
});
