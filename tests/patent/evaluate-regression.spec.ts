import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import {
  benchmarkPaths,
  batchReportToScoreboardRecord,
  createProviderFromModelRuntime,
  createRegressionRunner,
  loadRegressionCases,
  parseBenchmarkConfig,
  readScoreboard,
  appendScoreboard,
  Evaluator,
} from "../../src/patent/evaluate/index.js";

/**
 * 专利代理回归评测（P0-2）：装载 benchmark 目录 → provider（脚本运行时）→
 * createRegressionRunner（未建图域走生成 + 规则门）→ Evaluator 聚合 →
 * batchReportToScoreboardRecord → appendScoreboard。全程无 key、确定性。
 *
 * 另验证 statement/rubric 隔离：loadRegressionCases 读入私有 rubric，但
 * Evaluator 的 CaseRunner 只拿到 input（题目），rubric 不流入生成侧。
 */

function scriptedRuntime(response: string): ModelRuntime {
  return {
    stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      return (async function* () {
        yield { type: "text_delta", text: response } as CanonicalModelEvent;
      })();
    },
  } as unknown as ModelRuntime;
}

const DRAFTING_OUTPUT =
  "权利要求1：一种儿童学习椅，包括座板与高度调节机构，所述高度调节机构为丝杆升降组件。" +
  "权利要求2：根据权利要求1所述的学习椅，丝杆由电机驱动。符合专利法第二十六条第四款。";

const CONFIG_YAML = [
  "name: patent-agent-regression",
  "target_role: patent-agent",
  "eval_runtime:",
  "  provider: deepseek",
  "  model_id: deepseek-v4-flash",
  "  thinking_level: high",
].join("\n");

const RUBRIC_YAML = [
  "maxScore: 100",
  "items:",
  "  - id: independent_claim",
  "    weight: 0.5",
  "    criterion: 是否给出独立权利要求",
  "    behavior: observable",
  "  - id: cites_a264",
  "    weight: 0.5",
  "    criterion: 是否引用第二十六条第四款",
  "    behavior: observable",
].join("\n");

async function seedBenchmark(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "patent-agent-eval-"));
  const dir = join(root, "patent-agent");
  await mkdir(join(dir, "drafting-mini-claims"), { recursive: true });
  await writeFile(join(dir, "benchmark_config.yaml"), CONFIG_YAML, "utf8");
  await writeFile(join(dir, "drafting-mini-claims", "statement.md"), "为丝杆升降儿童学习椅撰写权利要求布局。", "utf8");
  await writeFile(join(dir, "drafting-mini-claims", "expected.md"), DRAFTING_OUTPUT, "utf8");
  await writeFile(
    join(dir, "drafting-mini-claims", "case.yaml"),
    "domain: drafting\nrequiredCitations:\n  - 第二十六条第四款\n",
    "utf8",
  );
  await writeFile(join(dir, "drafting-mini-claims", "rubric.yaml"), RUBRIC_YAML, "utf8");
  // 第二个用例：无 expected.md（应被 loadRegressionCases 跳过）。
  await mkdir(join(dir, "orphan-no-expected"), { recursive: true });
  await writeFile(join(dir, "orphan-no-expected", "statement.md"), "只有题目没有参考产出。", "utf8");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("loadRegressionCases：收齐 statement+expected 的目录，跳过缺 expected 的目录，读入私有 rubric", async () => {
  const { root, cleanup } = await seedBenchmark();
  try {
    const paths = benchmarkPaths(root, "patent-agent");
    const cases = await loadRegressionCases(paths);
    assert.equal(cases.length, 1, "orphan-no-expected 缺 expected.md 应被跳过");
    assert.equal(cases[0]!.id, "drafting-mini-claims");
    assert.equal(cases[0]!.domain, "drafting");
    assert.deepEqual(cases[0]!.requiredCitations, ["第二十六条第四款"]);
    assert.ok(cases[0]!.rubric, "私有 rubric 应被读入");
    assert.equal(cases[0]!.rubric?.items.length, 2);
  } finally {
    await cleanup();
  }
});

test("createProviderFromModelRuntime：callLLM 收集 text_delta 为完整文本", async () => {
  const provider = createProviderFromModelRuntime(scriptedRuntime("你好，专利助手"), {
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
  const text = await provider.callLLM?.("系统提示\n用户输入");
  assert.equal(text, "你好，专利助手");
});

test("回归全链路：未建图域走生成+规则门，聚合 BatchReport 且指标在 0..1", async () => {
  const { root, cleanup } = await seedBenchmark();
  try {
    const paths = benchmarkPaths(root, "patent-agent");
    const cases = await loadRegressionCases(paths);
    const provider = createProviderFromModelRuntime(scriptedRuntime(DRAFTING_OUTPUT), {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      caseId: "drafting-mini-claims",
    });
    const report = await new Evaluator(createRegressionRunner(provider)).evaluateCases(cases);

    assert.equal(report.total, 1);
    assert.ok(report.metrics.keyword_recall >= 0 && report.metrics.keyword_recall <= 1);
    assert.ok(report.metrics.citation_completeness >= 0 && report.metrics.citation_completeness <= 1);
    assert.ok(Object.prototype.hasOwnProperty.call(report.metrics, "rule_gate_pass"));
    // 生成的产出即参考文本 → 关键词召回与引用完整度应较高。
    assert.ok((report.metrics.keyword_recall ?? 0) > 0.5);
    assert.equal(report.metrics.citation_completeness, 1);
  } finally {
    await cleanup();
  }
});

test("batchReportToScoreboardRecord → appendScoreboard：0..100 缩放 + 版本递增落盘", async () => {
  const { root, cleanup } = await seedBenchmark();
  try {
    const paths = benchmarkPaths(root, "patent-agent");
    const config = parseBenchmarkConfig(await readFile(paths.configPath, "utf8"));
    assert.ok(config.config);
    const cases = await loadRegressionCases(paths);
    const provider = createProviderFromModelRuntime(scriptedRuntime(DRAFTING_OUTPUT), {
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    const report = await new Evaluator(createRegressionRunner(provider)).evaluateCases(cases);
    const record = batchReportToScoreboardRecord(report, config.config, 1, () => new Date("2026-09-29T00:00:00Z"));

    assert.equal(record.version, 1);
    assert.equal(record.provider, "deepseek");
    assert.equal(record.model_id, "deepseek-v4-flash");
    assert.ok(record.score >= 0 && record.score <= 100);
    assert.equal(record.cases.length, 1);
    assert.equal(record.cases[0]!.case, "drafting-mini-claims");
    assert.equal(record.cases[0]!.runs.length, 1);

    const appended = await appendScoreboard(paths.scoreboardPath, record);
    assert.ok(appended.ok, `append 失败: ${appended.ok ? "" : appended.error}`);
    const readBack = await readScoreboard(paths.scoreboardPath);
    assert.equal(readBack.records.length, 1);
    assert.equal(readBack.records[0]!.version, 1);
  } finally {
    await cleanup();
  }
});
