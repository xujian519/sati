import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { benchmarkPaths, loadRegressionCases, parseRubric } from "../../../src/patent/evaluate/index.js";

/**
 * 回归语料治理测试（#723）：语料规模、四件套完整性、技术领域/法条覆盖、
 * rubric 权重与 loader 装载。语料位于仓库 `benchmarks/patent-agent/`，
 * 测试从编译产物目录回溯仓库根后直接读取，不依赖 cwd。
 */

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const BENCHMARK_ROOT = join(REPO_ROOT, "benchmarks");
const BENCHMARK_ID = "patent-agent";
const REQUIRED_FILES = ["statement.md", "expected.md", "case.yaml", "rubric.yaml"] as const;
const REQUIRED_FIELDS = ["electrical", "chemical", "mechanical", "biological", "software"] as const;
const REQUIRED_ARTICLES = ["A22.2", "A22.3", "A26.3"] as const;
const CLAUSE_BY_ARTICLE: Record<string, string> = {
  "A22.2": "第二十二条第二款",
  "A22.3": "第二十二条第三款",
  "A26.3": "第二十六条第三款",
  "A26.4": "第二十六条第四款",
};

type CorpusCase = {
  id: string;
  domain: string;
  field: string;
  article: string;
  requiredCitations: string[];
  statement: string;
  expected: string;
  rubricText: string;
};

const paths = benchmarkPaths(BENCHMARK_ROOT, BENCHMARK_ID);

/** 用例目录 = 含 statement.md 的子目录（config/scoreboard/snapshots 不算）。 */
async function caseDirs(): Promise<string[]> {
  const entries = await readdir(paths.root, { withFileTypes: true });
  const dirs = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort();
  const result: string[] = [];
  for (const id of dirs) {
    const files = await readdir(join(paths.root, id));
    if (files.includes("statement.md")) result.push(id);
  }
  return result;
}

async function readCase(id: string): Promise<CorpusCase> {
  const dir = join(paths.root, id);
  const [statement, expected, metaText, rubricText] = await Promise.all([
    readFile(join(dir, "statement.md"), "utf8"),
    readFile(join(dir, "expected.md"), "utf8"),
    readFile(join(dir, "case.yaml"), "utf8"),
    readFile(join(dir, "rubric.yaml"), "utf8"),
  ]);
  const meta = parseYaml(metaText) as Record<string, unknown>;
  assert.equal(typeof meta.domain, "string", `${id}: case.yaml 缺少 domain`);
  assert.equal(typeof meta.field, "string", `${id}: case.yaml 缺少 field`);
  assert.equal(typeof meta.article, "string", `${id}: case.yaml 缺少 article`);
  assert.ok(Array.isArray(meta.requiredCitations), `${id}: case.yaml 缺少 requiredCitations`);
  const requiredCitations = meta.requiredCitations.filter((x): x is string => typeof x === "string");
  return {
    id,
    domain: meta.domain as string,
    field: meta.field as string,
    article: meta.article as string,
    requiredCitations,
    statement,
    expected,
    rubricText,
  };
}

let cached: Promise<CorpusCase[]> | undefined;
function corpus(): Promise<CorpusCase[]> {
  cached ??= caseDirs().then(ids => Promise.all(ids.map(readCase)));
  return cached;
}

describe("benchmark corpus", () => {
  it("用例总数不少于 20，且每个用例目录四件套齐全", async () => {
    const dirs = await caseDirs();
    assert.ok(dirs.length >= 20, `用例数应 >= 20，当前 ${dirs.length}`);
    for (const id of dirs) {
      const files = await readdir(join(paths.root, id));
      const missing = REQUIRED_FILES.filter(file => !files.includes(file));
      assert.deepEqual(missing, [], `${id} 缺少文件：${missing.join(", ")}`);
    }
  });

  it("覆盖五个技术领域与 A22.2/A22.3/A26.3 三个法条", async () => {
    const cases = await corpus();
    const fields = new Set(cases.map(c => c.field));
    assert.deepEqual([...fields].sort(), [...REQUIRED_FIELDS].sort(), "技术领域应恰好覆盖五类");
    const articles = new Set(cases.map(c => c.article));
    for (const article of REQUIRED_ARTICLES) {
      assert.ok(articles.has(article), `缺少法条 ${article} 的用例`);
    }
  });

  it("case.yaml 元数据自洽：领域/法条合法，requiredCitations 与 expected 引用一致", async () => {
    const cases = await corpus();
    for (const c of cases) {
      assert.ok(c.domain.trim().length > 0, `${c.id}: domain 为空`);
      assert.ok(REQUIRED_FIELDS.includes(c.field as (typeof REQUIRED_FIELDS)[number]), `${c.id}: field 非法`);
      const clause = CLAUSE_BY_ARTICLE[c.article];
      assert.ok(clause, `${c.id}: article 非法`);
      assert.ok(c.requiredCitations.length > 0, `${c.id}: requiredCitations 为空`);
      assert.ok(c.requiredCitations.includes(clause), `${c.id}: requiredCitations 未包含 ${clause}`);
      assert.ok(c.expected.includes(clause), `${c.id}: expected.md 未引用 ${clause}`);
    }
  });

  it("rubric 可解析且各项权重之和为 1", async () => {
    const cases = await corpus();
    for (const c of cases) {
      const parsed = parseRubric(c.rubricText);
      assert.equal(parsed.error, null, `${c.id}: ${parsed.error}`);
      const sum = parsed.rubric.items.reduce((total, item) => total + item.weight, 0);
      assert.ok(Math.abs(sum - 1) <= 1e-6, `${c.id}: rubric 权重和为 ${sum}`);
    }
  });

  it("loadRegressionCases 能装载全部用例并读入私有 rubric", async () => {
    const cases = await corpus();
    const loaded = await loadRegressionCases(paths);
    assert.equal(loaded.length, cases.length);
    const loadedIds = new Set(loaded.map(c => c.id));
    for (const c of cases) {
      assert.ok(loadedIds.has(c.id), `${c.id} 未被 loader 装载`);
    }
    for (const c of loaded) {
      assert.ok(c.input.trim().length > 0, `${c.id}: statement 为空`);
      assert.ok(c.expected.trim().length > 0, `${c.id}: expected 为空`);
      assert.ok(c.rubric, `${c.id}: rubric 未读入`);
    }
  });
});
