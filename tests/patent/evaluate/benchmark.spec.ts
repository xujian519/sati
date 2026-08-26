import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { benchmarkPaths, parseBenchmarkConfig } from "../../../src/patent/evaluate/benchmark.js";

describe("parseBenchmarkConfig", () => {
  it("合法配置解析出 target_role 与 eval_runtime", () => {
    const text = `
name: patent-drafting-quality
description: 撰写质量基准
target_role: drafting-analyst
eval_runtime:
  provider: deepseek
  model_id: deepseek-v4-pro
  thinking_level: medium
`;
    const result = parseBenchmarkConfig(text);
    assert.equal(result.error, null);
    assert.equal(result.config!.target_role, "drafting-analyst");
    assert.equal(result.config!.eval_runtime.model_id, "deepseek-v4-pro");
    assert.equal(result.config!.description, "撰写质量基准");
  });

  it("缺 target_role 报错", () => {
    const result = parseBenchmarkConfig("name: x\neval_runtime: { provider: a, model_id: b, thinking_level: c }\n");
    assert.notEqual(result.error, null);
  });

  it("非法 YAML 容错归一为 error", () => {
    const result = parseBenchmarkConfig("name: [");
    assert.notEqual(result.error, null);
  });
});

describe("benchmarkPaths", () => {
  it("构造目录与 case 路径", () => {
    const p = benchmarkPaths("/data/benchmarks", "drafting");
    assert.equal(p.root, "/data/benchmarks/drafting");
    assert.equal(p.scoreboardPath, "/data/benchmarks/drafting/scoreboard.yaml");
    assert.equal(p.statementPath("c1"), "/data/benchmarks/drafting/c1/statement.md");
    assert.equal(p.rubricPath("c1"), "/data/benchmarks/drafting/c1/rubric.yaml");
  });

  it("非法 caseId 抛错（防路径注入）", () => {
    const p = benchmarkPaths("/data/benchmarks", "drafting");
    assert.throws(() => p.caseDir("../../etc"));
  });
});
