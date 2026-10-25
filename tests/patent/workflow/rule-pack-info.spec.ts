/**
 * run 级规则包指纹（#736）：每条 run 记录「这一轮用的是哪版规则包」。
 *
 * 指纹来自 `computeRulePackFingerprint`（清单 + 各层规则文件），所以变化必须能
 * 归因到**具体层**；`version` 只取项目清单显式声明的值。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonFileWorkflowRunStore,
  resolveRunRulePack,
  runWorkflow,
  type WorkflowManifest,
} from "../../../src/patent/index.js";

/** 把文件 mtime 强制设为「现在 + ms」毫秒：写入与读取可能落在同一毫秒，靠它拉开。 */
function touchAfter(path: string, ms: number): void {
  const at = new Date(Date.now() + ms);
  utimesSync(path, at, at);
}

/** 搭一个三层 fixture：base + domain + overrides（以 patent 层扮演），可声明清单版本。 */
function makePackFixture(options: { version?: string } = {}): {
  root: string;
  manifestPath: string;
  layers: { base: string; domain: string; patent: string };
} {
  const root = mkdtempSync(join(tmpdir(), "sati-run-rule-pack-"));
  const layers = {
    base: join(root, "base-pack"),
    domain: join(root, "mech-pack"),
    patent: join(root, "patent-pack"),
  };
  mkdirSync(layers.base);
  mkdirSync(layers.domain);
  mkdirSync(layers.patent);

  const writeLayer = (dir: string, packYaml: string[]): void => {
    writeFileSync(join(dir, "pack.yaml"), packYaml.join("\n"));
    writeFileSync(join(dir, "rules.yaml"), 'version: "1.0"\nrules: {}\n');
  };
  writeLayer(layers.base, ["id: sati-rules-test-base", "version: 0.1.0", "description: 测试基础包"]);
  writeLayer(layers.domain, [
    "id: sati-rules-test-domain-mech",
    "version: 0.1.0",
    "domain: mechanical",
    "description: 测试领域包",
  ]);
  writeLayer(layers.patent, ["id: sati-rules-test-patent", "version: 0.1.0", "description: 测试专利层"]);

  mkdirSync(join(root, ".sati"));
  const manifestPath = join(root, ".sati", "rules.yaml");
  writeFileSync(
    manifestPath,
    [
      `base: ${layers.base}`,
      "domains:",
      `  - ${layers.domain}`,
      `overrides: ${layers.patent}`,
      ...(options.version !== undefined ? [`version: "${options.version}"`] : []),
    ].join("\n"),
  );
  return { root, manifestPath, layers };
}

/** 返回两份指纹里发生变化的行（用于断言「归因到哪一层」）。 */
function changedLines(before: string, after: string): string[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  assert.equal(beforeLines.length, afterLines.length, "指纹行数应稳定（层集合未变）");
  return afterLines.filter((line, i) => line !== beforeLines[i]);
}

test("resolveRunRulePack: 同状态幂等（每次 run 重新计算但结果稳定）", () => {
  const { manifestPath } = makePackFixture();
  assert.deepEqual(resolveRunRulePack({ manifestPath }), resolveRunRulePack({ manifestPath }));
});

test("resolveRunRulePack: base / domain / patent 任一层规则文件变化都改变指纹并可归因到层", () => {
  const { manifestPath, layers } = makePackFixture();
  const before = resolveRunRulePack({ manifestPath });

  touchAfter(join(layers.base, "rules.yaml"), 5_000);
  const afterBase = resolveRunRulePack({ manifestPath });
  assert.notEqual(afterBase.fingerprint, before.fingerprint, "base 层变化应改变指纹");
  assert.match(changedLines(before.fingerprint, afterBase.fingerprint).join("\n"), /^base:/m);

  touchAfter(join(layers.domain, "rules.yaml"), 10_000);
  const afterDomain = resolveRunRulePack({ manifestPath });
  assert.notEqual(afterDomain.fingerprint, afterBase.fingerprint, "domain 层变化应改变指纹");
  // 层名按清单里的引用原文展开（域层即 `domain:<ref>`），所以只钉前缀与目录名。
  assert.match(changedLines(afterBase.fingerprint, afterDomain.fingerprint).join("\n"), /^domain:.*mech-pack:/m);

  touchAfter(join(layers.patent, "rules.yaml"), 15_000);
  const afterPatent = resolveRunRulePack({ manifestPath });
  assert.notEqual(afterPatent.fingerprint, afterDomain.fingerprint, "overrides（patent 层）变化应改变指纹");
  assert.match(changedLines(afterDomain.fingerprint, afterPatent.fingerprint).join("\n"), /^overrides:/m);
});

test("resolveRunRulePack: version 只取清单显式声明值，未声明时不臆造", () => {
  const declared = makePackFixture({ version: "2026.10" });
  assert.equal(resolveRunRulePack({ manifestPath: declared.manifestPath }).version, "2026.10");

  const undeclared = makePackFixture();
  const info = resolveRunRulePack({ manifestPath: undeclared.manifestPath });
  assert.equal(info.version, undefined, "清单未声明 version 时不得编造聚合版本");
  assert.equal("version" in info, false);
});

test("runWorkflow: 结果带 rulePack 并随 JSON run 记录落盘", async () => {
  const { root, manifestPath } = makePackFixture({ version: "2026.10" });
  const runsDir = join(root, "runs");
  try {
    const manifest: WorkflowManifest = {
      id: "rule_pack_probe_v1",
      name: "规则包探针",
      caseType: "patent",
      stages: [{ id: "only", strategy: "chain", description: "唯一阶段" }],
    };
    const store = new JsonFileWorkflowRunStore(runsDir);
    const result = await runWorkflow(manifest, { input: "探针" }, async () => "完成", {
      persist: store,
      rulePackManifestPath: manifestPath,
    });

    assert.ok(result.rulePack);
    assert.equal(result.rulePack.version, "2026.10");
    assert.match(result.rulePack.fingerprint, /manifest:/);

    const onDisk = JSON.parse(readFileSync(join(runsDir, "rule_pack_probe_v1.json"), "utf8")) as {
      rulePack?: { fingerprint: string; version?: string };
    };
    assert.deepEqual(onDisk.rulePack, result.rulePack, "落盘记录应含同一指纹");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JsonFileWorkflowRunStore: 旧 run JSON（无 rulePack）仍可读", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-run-legacy-"));
  try {
    const runsDir = join(root, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "legacy_v1.json"),
      JSON.stringify({
        manifestId: "legacy_v1",
        caseType: "patent",
        completed: true,
        stages: [],
        degradedSteps: [],
        summary: "旧记录",
      }),
    );
    const loaded = await new JsonFileWorkflowRunStore(runsDir).loadRun("legacy_v1");
    assert.equal(loaded?.summary, "旧记录");
    assert.equal(loaded?.rulePack, undefined, "旧记录缺 rulePack 属合法（可选字段）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
