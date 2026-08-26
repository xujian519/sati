import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BenchmarkConfig } from "../../../src/patent/evaluate/benchmark.js";
import { benchmarkPaths } from "../../../src/patent/evaluate/benchmark.js";
import { readScoreboard } from "../../../src/patent/evaluate/scoreboard.js";
import {
  buildJudgePrompt,
  diffScoreboards,
  evaluateCandidate,
  listCaseDirs,
  parseVerdicts,
  runBaseline,
  shouldAcceptCandidate,
} from "../../../src/patent/evaluate/evolve.js";
import { parseRubric, type Rubric } from "../../../src/patent/evaluate/rubric.js";
import type { ScoreboardRecord } from "../../../src/patent/evaluate/scoreboard.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-evolve-"));
  tempDirs.push(dir);
  return dir;
}

function makeCase(root: string, caseId: string, statement: string, rubricYaml: string): void {
  const dir = join(root, caseId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "statement.md"), statement);
  writeFileSync(join(dir, "rubric.yaml"), rubricYaml);
}

function exampleConfig(): BenchmarkConfig {
  return {
    name: "claims-drafting-quality",
    target_role: "drafting-analyst",
    eval_runtime: { provider: "deepseek", model_id: "deepseek-v4-flash", thinking_level: "medium" },
  };
}

const RUBRIC = `
items:
  - id: three_step_method
    weight: 0.5
    criterion: 是否使用三步法。
    behavior: observable
  - id: legal_citation
    weight: 0.5
    criterion: 引用的法条是否正确。
    behavior: observable
`;

function parseTestRubric(): Rubric {
  const r = parseRubric(RUBRIC);
  assert.equal(r.error, null);
  return r.rubric!;
}

const FIXED_NOW = () => new Date("2026-08-09T00:00:00.000Z");

describe("buildJudgePrompt", () => {
  it("包含 statement/output/每条 criterion，要求只输出 JSON", () => {
    const prompt = buildJudgePrompt("题目背景", "产出正文", parseTestRubric());
    assert.ok(prompt.includes("题目背景"));
    assert.ok(prompt.includes("产出正文"));
    assert.ok(prompt.includes("three_step_method"));
    assert.ok(prompt.includes("legal_citation"));
    assert.ok(prompt.includes("只输出 JSON"));
  });
});

describe("parseVerdicts", () => {
  it("解析布尔对象，未解析项默认 false（保守）", () => {
    const items = parseTestRubric().items;
    assert.deepEqual(parseVerdicts('{"three_step_method": true, "legal_citation": false}', items), {
      three_step_method: true,
      legal_citation: false,
    });
  });

  it("容错解析围栏与 yes/1/no/0", () => {
    const items = parseTestRubric().items;
    const v1 = parseVerdicts('```json\n{"three_step_method": "yes", "legal_citation": 0}\n```', items);
    assert.deepEqual(v1, { three_step_method: true, legal_citation: false });
  });

  it("无法解析 → 全部 false", () => {
    const items = parseTestRubric().items;
    assert.deepEqual(parseVerdicts("分析很充分", items), { three_step_method: false, legal_citation: false });
  });
});

describe("listCaseDirs", () => {
  it("只列出含 statement.md + rubric.yaml 的子目录", async () => {
    const root = makeDir();
    const paths = benchmarkPaths(root, "bench");
    mkdirSync(paths.root, { recursive: true });
    makeCase(paths.root, "c1", "s", RUBRIC);
    makeCase(paths.root, "c2", "s", RUBRIC);
    writeFileSync(join(paths.root, "not-a-case.txt"), "x");
    const cases = await listCaseDirs(paths);
    assert.deepEqual(cases, ["c1", "c2"]);
  });
});

describe("runBaseline", () => {
  it("逐 case 生成 + 评分，聚合为 ScoreboardRecord 并追加", async () => {
    const root = makeDir();
    const paths = benchmarkPaths(root, "bench");
    mkdirSync(paths.root, { recursive: true });
    makeCase(paths.root, "c1", "题目", RUBRIC);
    makeCase(paths.root, "c2", "题目2", RUBRIC);

    const result = await runBaseline({
      paths,
      config: exampleConfig(),
      version: 1,
      now: FIXED_NOW,
      generate: async (_sys, statement) => ({
        text: `产出:${statement}`,
        sessionId: `sess-${statement}`,
        durationMs: 100,
      }),
      judge: async () => 85,
    });

    assert.equal(result.casesRun, 2);
    assert.equal(result.record.score, 85);
    assert.equal(result.record.version, 1);
    assert.equal(result.record.provider, "deepseek");
    assert.equal(result.record.cases.length, 2);
    assert.equal(result.record.cases[0]!.runs[0]!.session_id, "sess-题目");

    const read = await readScoreboard(paths.scoreboardPath);
    assert.equal(read.error, null);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0]!.cases[0]!.runs[0]!.session_id, "sess-题目");
  });

  it("追加到已有 scoreboard 时版本递增且不覆盖历史", async () => {
    const root = makeDir();
    const paths = benchmarkPaths(root, "bench");
    mkdirSync(paths.root, { recursive: true });
    makeCase(paths.root, "c1", "题目", RUBRIC);

    await runBaseline({
      paths,
      config: exampleConfig(),
      version: 1,
      now: FIXED_NOW,
      generate: async () => ({ text: "o", sessionId: "s-1", durationMs: 1 }),
      judge: async () => 70,
    });
    const result = await runBaseline({
      paths,
      config: exampleConfig(),
      version: 2,
      now: FIXED_NOW,
      generate: async () => ({ text: "o", sessionId: "s-2", durationMs: 1 }),
      judge: async () => 90,
    });
    const after = await readScoreboard(paths.scoreboardPath);
    assert.equal(after.records.length, 2);
    assert.equal(after.records[0]!.version, 1);
    assert.equal(after.records[1]!.version, 2);
    assert.equal(result.record.score, 90);
  });

  it("runs>1（batch）每 case 多次 run，case 分取均值", async () => {
    const root = makeDir();
    const paths = benchmarkPaths(root, "bench");
    mkdirSync(paths.root, { recursive: true });
    makeCase(paths.root, "c1", "题目", RUBRIC);
    const result = await runBaseline({
      paths,
      config: exampleConfig(),
      version: 1,
      now: FIXED_NOW,
      runs: 3,
      generate: async (_sys, s) => ({ text: `o:${s}`, sessionId: `s->${Math.random()}`, durationMs: 1 }),
      judge: async () => 60,
    });
    assert.equal(result.record.cases[0]!.runs.length, 3);
    assert.equal(result.record.cases[0]!.score, 60);
  });
});

describe("diffScoreboards (M3)", () => {
  function rec(version: number, scoreByCase: Record<string, number>): ScoreboardRecord {
    return {
      time: "2026-08-09T00:00:00.000Z",
      version,
      provider: "deepseek",
      model_id: "deepseek-v4-flash",
      thinking_level: "medium",
      score: round2(mean(Object.values(scoreByCase))),
      cost: null,
      duration_ms: 100,
      cases: Object.entries(scoreByCase).map(([caseId, score]) => ({
        case: caseId,
        score,
        runs: [{ score, cost: null, duration_ms: 100, session_id: `s-${version}-${caseId}` }],
      })),
    };
  }

  it("逐 case 对比并标出失分/提升", () => {
    const d = diffScoreboards(rec(1, { a: 80, b: 70, c: 60 }), rec(2, { a: 90, b: 50, c: 60 }));
    assert.equal(d.olderVersion, 1);
    assert.equal(d.newerVersion, 2);
    assert.deepEqual(d.lost, ["b"]);
    assert.deepEqual(d.improvedOrFlat, ["a", "c"]);
    const a = d.cases.find(c => c.caseId === "a")!;
    assert.equal(a.delta, 10);
  });

  it("单边缺失的 case 记 null 且不影响整体判断", () => {
    const d = diffScoreboards(rec(1, { a: 80 }), rec(2, { a: 90, b: 40 }));
    const b = d.cases.find(c => c.caseId === "b")!;
    assert.equal(b.older, null);
    assert.equal(b.delta, null);
  });
});

describe("严格接受规则 (M4)", () => {
  it("仅严格更高才接受；相等视为拒绝", () => {
    assert.equal(shouldAcceptCandidate(90, 80), true);
    assert.equal(shouldAcceptCandidate(80, 80), false);
    assert.equal(shouldAcceptCandidate(70, 80), false);
  });

  it("evaluateCandidate 返回接受/回滚理由", () => {
    const ref = { score: 80, version: 1 } as ScoreboardRecord;
    const cand = { score: 85, version: 2 } as ScoreboardRecord;
    const ok = evaluateCandidate(cand, ref);
    assert.equal(ok.accepted, true);
    assert.match(ok.reason, /严格高于/);
    const reject = evaluateCandidate({ score: 80, version: 2 } as ScoreboardRecord, ref);
    assert.equal(reject.accepted, false);
    assert.match(reject.reason, /回滚/);
  });
});

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
