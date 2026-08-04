/**
 * 专利代理人考试评测集加载器。
 *
 * 读取 tests/patent/benchmark/fixtures/business/ 下的业务化 fixtures（由
 * scripts/patent-benchmark-business.ts 从 Mady 原始导出转换而来）。fixtures
 * 位于源码树（tsc 不会复制到 dist/），仓库根目录通过向上查找 tsconfig.json
 * 定位，兼容两种运行方式：
 *   - 编译产物：pnpm build 后 node --test dist/tests/...
 *   - 源码直跑：tsx / node --experimental-strip-types tests/...
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkIndex, BusinessPatentExamCase, BusinessPatentExamFixture, PatentExamFixture } from "./types.js";

/** 从任意模块路径向上定位仓库根目录（含 tsconfig.json 的目录）。 */
function repoRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("未找到仓库根目录（向上查找 tsconfig.json 失败）");
    dir = parent;
  }
}

const FIXTURES_ROOT = resolve(repoRoot(import.meta.url), "tests/patent/benchmark/fixtures");

/** 业务化 fixtures 目录（默认读取目标）。 */
const BUSINESS_DIR = join(FIXTURES_ROOT, "business");

function readJson<T>(dir: string, relPath: string): T {
  return JSON.parse(readFileSync(join(dir, relPath), "utf8")) as T;
}

/** 读取业务化 index.json（suite 清单与总数）。 */
export function loadIndex(): BenchmarkIndex {
  return readJson<BenchmarkIndex>(BUSINESS_DIR, "index.json");
}

/** 读取单个业务 suite 的 fixture。 */
export function loadFixture(suite: string): BusinessPatentExamFixture {
  return readJson<BusinessPatentExamFixture>(BUSINESS_DIR, `${suite}.json`);
}

/** 加载全部业务化用例（按 index.json 中的 suite 顺序）。 */
export function loadAllCases(): BusinessPatentExamCase[] {
  const index = loadIndex();
  const cases: BusinessPatentExamCase[] = [];
  for (const { suite } of index.suites) {
    cases.push(...loadFixture(suite).cases);
  }
  return cases;
}

/** 按业务 suite 名分组的用例表。 */
export function loadCasesBySuite(): Map<string, BusinessPatentExamCase[]> {
  const index = loadIndex();
  const bySuite = new Map<string, BusinessPatentExamCase[]>();
  for (const { suite } of index.suites) {
    bySuite.set(suite, loadFixture(suite).cases);
  }
  return bySuite;
}

/** business 目录中实际存在的 suite 名（排除 index.json）。 */
export function listSuites(): string[] {
  return readdirSync(BUSINESS_DIR)
    .filter(f => f.endsWith(".json") && f !== "index.json")
    .map(f => f.replace(/\.json$/, ""))
    .sort();
}

/* ------------------------- 原始导出（只读，用于溯源校验） ------------------------- */

/** 读取原始（Mady 导出）index.json。 */
export function loadRawIndex(): BenchmarkIndex {
  return readJson<BenchmarkIndex>(FIXTURES_ROOT, "index.json");
}

/** 读取单个原始 suite 的 fixture。 */
export function loadRawFixture(suite: string): PatentExamFixture {
  return readJson<PatentExamFixture>(FIXTURES_ROOT, `${suite}.json`);
}

/** 加载全部原始用例（Mady 导出口径）。 */
export function loadRawAllCases(): PatentExamFixture["cases"] {
  const index = loadRawIndex();
  const cases: PatentExamFixture["cases"] = [];
  for (const { suite } of index.suites) {
    cases.push(...loadRawFixture(suite).cases);
  }
  return cases;
}
