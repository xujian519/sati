import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeToolContext } from "../context-fixture.js";
import { createRuleCheckTool } from "../../../src/tool/builtin/ruleCheck.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { loadPatentComplianceRuleSet, type RulePackLoadResult, type RuleSet } from "../../../src/rule/index.js";

test("rule_check returns no violation for clean text", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "本方案采用特定装置提高效率。" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /无违规/);
});

test("rule_check reports violations with rule id and legal basis", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "本专利结论：存在侵权风险。依据专利法第99条。" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /发现 \d+ 条违规/);
  assert.match(text, /PAT-RISK-001/);
  assert.match(text, /PAT-APPROVAL-001/);
  assert.match(text, /PAT-CITE-001/);
  assert.match(text, /依据：/);
});

test("rule_check honors custom scope loader", async () => {
  const loader = (scope: string): RuleSet => {
    if (scope === "custom") {
      return {
        rules: [
          {
            id: "CUSTOM-1",
            name: "自定义",
            severity: "critical",
            action: "block",
            check: { type: "keyword_blocklist", keywords: ["禁忌词"] },
          },
        ],
      };
    }
    return { rules: [] };
  };
  const tool = createRuleCheckTool({ loader });
  const result = await tool.execute({ text: "包含禁忌词。", scope: "custom" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /CUSTOM-1/);
});

test("rule_check unknown scope is not silently clean", async () => {
  const tool = createRuleCheckTool();
  const result = await tool.execute({ text: "任意文本", scope: "nonexistent" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  // 未知 scope 显式提示"未加载规则"，避免"静默零违规"误判合规
  assert.match(text, /未加载任何规则/);
  assert.match(text, /patent, patent-electrical, patent-full, pack/);
  assert.doesNotMatch(text, /无违规/);
});

test("rule_check scope=pack returns layered summary via injected pack loader", async () => {
  const pack = (): RulePackLoadResult => ({
    ruleSet: {
      rules: [
        {
          id: "PACK-1",
          name: "包内规则",
          severity: "minor",
          action: "review",
          check: { type: "keyword_blocklist", keywords: ["禁忌词"] },
        },
      ],
    },
    sources: ["rules/base/pack-rules.yaml"],
    warnings: [],
    layers: new Map([
      ["PACK-1", "base"],
      ["PACK-2", "domain:mechanical"],
    ]),
    manifestPath: null,
    manifestMtimeMs: null,
  });
  const tool = createRuleCheckTool({ pack });
  const result = await tool.execute({ text: "包含禁忌词。", scope: "pack" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /PACK-1/);
  assert.match(text, /规则分层: base 1 \+ domain:mechanical 1/);
  assert.match(text, /清单: 无，默认 rules\/base/);
});

test("rule_check scope=pack with no violations still prints layers summary", async () => {
  const pack = (): RulePackLoadResult => ({
    ruleSet: {
      rules: [
        {
          id: "PACK-1",
          name: "包内规则",
          severity: "minor",
          action: "review",
          check: { type: "keyword_blocklist", keywords: ["禁忌词"] },
        },
      ],
    },
    sources: [],
    warnings: [],
    layers: new Map([["PACK-1", "base"]]),
    manifestPath: null,
    manifestMtimeMs: null,
  });
  const tool = createRuleCheckTool({ pack });
  const result = await tool.execute({ text: "干净文本。", scope: "pack" }, makeToolContext());
  const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /rule_check\(pack\): 无违规/);
  assert.match(text, /规则分层: base 1/);
});

test("builtin registry includes rule_check by default", () => {
  const registry = createBuiltinRegistry();
  assert.equal(registry.has("rule_check"), true);
  const tool = registry.get("rule_check");
  assert.equal(tool?.isReadOnly({ text: "x" }), true);
});

test("builtin registry can skip rule_check", () => {
  const registry = createBuiltinRegistry({ ruleCheck: false });
  assert.equal(registry.has("rule_check"), false);
});

test("patent compliance rule set asset loads rules", async () => {
  const { ruleSet } = loadPatentComplianceRuleSet();
  assert.ok(ruleSet.rules.length >= 4);
});

// ---------------------------------------------------------------------------
// 长驻进程缓存失效（#355）：只改层规则文件、不动清单，也必须重载
//
// 这些用例模拟 gateway / desktop 的长驻形态——同一个工具实例（= 同一份缓存）跨多次
// 调用，中途有人改了规则文件。仓库根不在临时目录里，故 chdir 进临时工作区。
// ---------------------------------------------------------------------------

/**
 * 在临时工作区里跑 body：预建 `<root>/rules/base`，chdir 进 `<root>` 后调用 body，
 * 结束后恢复 cwd 并清理。
 *
 * **只接受 async body**：若照搬 `try { return body() } finally { 恢复 }` 而 body 是异步，
 * finally 会在第一个 await 之前就执行（cwd 恢复得比用例还早、临时目录也被提前删掉），
 * 用例会以极难定位的方式随机失败。
 */
async function withWorkspace<T>(body: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "sati-rule-check-cache-"));
  const origin = process.cwd();
  mkdirSync(join(root, "rules", "base"), { recursive: true });
  process.chdir(root);
  try {
    return await body();
  } finally {
    process.chdir(origin);
    rmSync(root, { recursive: true, force: true });
  }
}

/** 最小规则 YAML（keyword_blocklist → block），供临时层目录使用。 */
function ruleYaml(id: string, keyword: string): string {
  return [
    'version: "1.0"',
    "rules:",
    `  ${id.toLowerCase()}:`,
    `    id: ${id}`,
    "    name: 临时测试规则",
    "    severity: critical",
    "    action: block",
    "    check:",
    "      type: keyword_blocklist",
    "      keywords:",
    `        - ${keyword}`,
  ].join("\n");
}

async function packCheck(tool: ReturnType<typeof createRuleCheckTool>, text: string): Promise<string> {
  const result = await tool.execute({ text, scope: "pack" }, makeToolContext());
  return result.content.map(c => (c.type === "text" ? c.text : "")).join("");
}

/** 写入与读取可能落在同一毫秒，强制 mtime 前进以稳定触发失效判据。 */
function touchAfter(path: string, ms: number): void {
  const at = new Date(Date.now() + ms);
  utimesSync(path, at, at);
}

test("rule_check(scope=pack) 长驻进程内跟随 base 层规则文件重载（#355）", async () => {
  await withWorkspace(async () => {
    const tool = createRuleCheckTool();
    const ruleFile = join(process.cwd(), "rules", "base", "tmp.yaml");
    writeFileSync(ruleFile, ruleYaml("TMP-OLD", "旧词"));
    assert.match(await packCheck(tool, "包含旧词。"), /TMP-OLD/);

    writeFileSync(ruleFile, ruleYaml("TMP-NEW", "新词"));
    touchAfter(ruleFile, 5_000);

    const stale = await packCheck(tool, "包含旧词。");
    assert.doesNotMatch(stale, /TMP-OLD/, "改写层规则文件后不应再命中旧规则（陈旧规则集）");
    assert.match(await packCheck(tool, "包含新词。"), /TMP-NEW/);
  });
});

test("rule_check(scope=pack) 只改 domain 层规则文件即重载——清单全程未动（#355 核心场景）", async () => {
  await withWorkspace(async () => {
    const root = process.cwd();
    mkdirSync(join(root, ".sati"));
    mkdirSync(join(root, "rules", "domains", "mech"), { recursive: true });
    const manifest = join(root, ".sati", "rules.yaml");
    writeFileSync(manifest, ["base: base", "domains: [mech]"].join("\n"));
    const manifestMtime = statSync(manifest).mtimeMs;
    const domainFile = join(root, "rules", "domains", "mech", "m.yaml");
    writeFileSync(domainFile, ruleYaml("DOM-OLD", "甲词"));

    const tool = createRuleCheckTool();
    const first = await packCheck(tool, "包含甲词。");
    assert.match(first, /DOM-OLD/);
    assert.match(first, /domain:mech/, "应走分层包路径（而非回退默认 rules/base）");

    writeFileSync(domainFile, ruleYaml("DOM-NEW", "乙词"));
    touchAfter(domainFile, 5_000);

    assert.doesNotMatch(await packCheck(tool, "包含甲词。"), /DOM-OLD/);
    assert.match(await packCheck(tool, "包含乙词。"), /DOM-NEW/);
    // 清单 mtime 全程未变 ⇒ 旧缓存键（清单 mtime）在本场景下不具备任何检出能力
    assert.equal(statSync(manifest).mtimeMs, manifestMtime);
  });
});

test("rule_check(scope=pack) 层目录新增规则文件后出现新规则（#355）", async () => {
  await withWorkspace(async () => {
    mkdirSync(join(process.cwd(), ".sati"));
    writeFileSync(join(process.cwd(), ".sati", "rules.yaml"), "base: base\n");
    const tool = createRuleCheckTool();
    assert.doesNotMatch(await packCheck(tool, "包含丙词。"), /ADD-NEW/);

    writeFileSync(join(process.cwd(), "rules", "base", "added.yaml"), ruleYaml("ADD-NEW", "丙词"));
    assert.match(await packCheck(tool, "包含丙词。"), /ADD-NEW/, "新增的层规则文件应被加载");
  });
});
