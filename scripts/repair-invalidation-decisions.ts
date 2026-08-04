/**
 * 补全 invalidation-decisions 用例中残缺的"核心理由"。
 *
 * Mady 数据提取（scripts/extract_invalidation_cases.py）对部分 CNIPA 无效决定
 * 无法提取"核心理由"（expected 中残留"（详见决定书正文）"/"综上所述，"占位）。
 * 本脚本按用例 input 中的专利号在宝宸知识库_Raw 原始决定书（.md）中定位原文，
 * 重新提取核心理由并写回 business fixtures 的 expected。
 *
 * 提取策略（三级）：
 *   1. "决定要点：..."（官方摘要，最可靠）
 *   2. "综上所述/基于上述观点…" 结语段（若足够实质）
 *   3. "二、决定的理由"下首个编号论述段（退而求其次）
 *
 * 用法：pnpm build 后 node dist/scripts/repair-invalidation-decisions.js
 *       [--data-dir /path/to/宝宸知识库_Raw/无效复审决定]
 *       [--fixtures /path/to/fixtures/business/business-invalidation.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BusinessPatentExamFixture } from "../tests/patent/benchmark/types.js";

const DEFAULT_DATA_DIR = "/Users/xujian/projects/宝宸知识库_Raw/无效复审决定";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** 从编译产物（dist/scripts）或源码定位仓库根目录，fixtures 在源码树中。 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("未找到仓库根目录（向上查找 tsconfig.json 失败）");
    dir = parent;
  }
}

const DATA_DIR = arg("--data-dir") ?? DEFAULT_DATA_DIR;
const FIXTURES_PATH =
  arg("--fixtures") ?? resolve(repoRoot(), "tests/patent/benchmark/fixtures/business/business-invalidation.json");

/** 判断 expected 的核心理由是否残缺。 */
function reasonIsDefective(expected: string): boolean {
  const m = expected.match(/核心理由[:：]\s*(.{0,30})/);
  if (!m) return true;
  const s = m[1].trim();
  return s.length < 12 || s.includes("详见决定书正文") || s.endsWith("综上所述") || s === "如果在";
}

/** 从原始决定书文本提取核心理由（兼容根目录原始版与 knowledge_base 结构化版）。 */
function extractReason(text: string): string {
  const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
  // 1) 决定要点（官方摘要）
  const points = text.match(/决定要点[:：]\s*([\s\S]*?)(?=附件|\n\s*合议组|\n\s*[一二三四五六七八九十]、|\n\s*决定|$)/);
  if (points && clean(points[1]).length > 15) return clean(points[1]).slice(0, 400);
  // 2) 结构化版的"关键论证"章节（[合议组认定] / [请求人主张]…）
  const keyArgs = text.match(/###\s*关键论证[\s\S]*?-\s*(\[[\s\S]*?)(?=\n###|\n##\s|$)/);
  if (keyArgs && clean(keyArgs[1]).length > 30) return clean(keyArgs[1]).slice(0, 400);
  // 3) "决定的理由"/"逻辑论证过程"下首个编号论述段或"分析段落 1"
  const section =
    text.match(
      /决定的理由[\s\S]{0,80}?\n?\s*[1１][、\.]\s*([\s\S]*?)(?=\n\s*[2２][、\.]|\n\s*综上所述|\n\s*三、|\n###|$)/,
    ) ?? text.match(/\*\*分析段落\s*1\*\*[\s\S]{0,30}?\s*([\s\S]*?)(?=\n\s*\*\*分析段落\s*2|\n###|$)/);
  if (section && clean(section[1]).length > 20) return clean(section[1]).slice(0, 400);
  // 4) "合议组认为：…"论述段（老格式决定书）
  const panel = text.match(
    /(?:合议组|本合议组)认为[:：]\s*([\s\S]*?)(?=\n\s*(?:合议组|本合议组)认为|\n\s*(?:基于上述|综上所述)|$)/,
  );
  if (panel && clean(panel[1]).length > 30) return clean(panel[1]).slice(0, 400);
  // 5) 综上所述 / 基于上述观点/理由/事实 结语段
  const closings = [
    ...text.matchAll(
      /(?:综上所述|基于上述观点|基于上述理由|基于上述事实)[，,]\s*([\s\S]*?)(?=\n\s*三、决定|\n\s*三．决定|\n\s*决定|\n\s*本决定|\n###|$)/g,
    ),
  ];
  if (closings.length > 0) {
    const s = clean(closings[closings.length - 1][1]);
    if (s.length > 15) return s.slice(0, 400);
  }
  // 6) 任意"关于…"论述段
  const about = text.match(/\n\s*\d+[、\.]\s*(关于[\s\S]{0,300}?)(?=\n\s*\d+[、\.]|\n\s*综上所述|\n###|$)/);
  if (about && clean(about[1]).length > 20) return clean(about[1]).slice(0, 400);
  return "";
}

/** 建立全量 md 文件索引：文件名（去点专利号）→ 路径。 */
function buildIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const stack: string[] = [DATA_DIR];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map(d => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (name.endsWith(".md")) {
        const base = name.replace(/\.md$/, "");
        const key = base.replace(/\./g, "").replace(/^.*_/, "");
        if (key.length >= 3) {
          // 精确 key 优先；同时登记去前缀后的完整段（纯编号文件名）
          if (!index.has(key)) index.set(key, p);
        }
      } else if (!name.includes(".")) {
        stack.push(p);
      }
    }
  }
  return index;
}

function main(): void {
  if (!existsSync(DATA_DIR)) {
    console.error(`[repair] 数据目录不存在: ${DATA_DIR}`);
    process.exitCode = 1;
    return;
  }
  console.log("[repair] 建立原始文件索引…");
  const index = buildIndex();
  console.log(`[repair] 索引 ${index.size} 个文件`);

  const fixture = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as BusinessPatentExamFixture;
  let repaired = 0;
  let failed = 0;
  for (const c of fixture.cases) {
    if (!c.id.startsWith("invalidation_decision_")) continue;
    if (!reasonIsDefective(c.expected)) continue;
    const m = c.input.match(/专利号[:：]?\s*([A-Za-z0-9._]+)/);
    const patentNo = m ? m[1] : "";
    const key = patentNo.replace(/\./g, "").replace(/^.*_/, "");
    const file = key ? index.get(key) : undefined;
    if (!file) {
      console.warn(`[repair] ${c.id} 未定位到原始文件（专利号 ${patentNo}）`);
      failed += 1;
      continue;
    }
    const reason = extractReason(readFileSync(file, "utf8"));
    if (reason.length < 20) {
      console.warn(`[repair] ${c.id} 提取失败（${reason.length}字）: ${file}`);
      failed += 1;
      continue;
    }
    c.expected = c.expected.replace(/核心理由[:：][\s\S]*?(?=\n?\s*主要法条)/, `核心理由：${reason}`);
    repaired += 1;
  }
  // 无法定位/提取的用例：将误导性占位改为明确降级标注（结论与法条仍可评测）
  for (const c of fixture.cases) {
    if (!c.id.startsWith("invalidation_decision_")) continue;
    if (!reasonIsDefective(c.expected)) continue;
    const degraded = c.expected.replace(
      /核心理由[:：][\s\S]*?(?=\n?\s*主要法条)/,
      "核心理由：（原始决定书未收录于数据源，无法提取理由摘要；仅结论与法条可评测）",
    );
    if (degraded !== c.expected) {
      c.expected = degraded;
      failed += 1;
      console.warn(`[repair] ${c.id} 已降级标注（无原始文件/无法提取）`);
    }
  }
  writeFileSync(FIXTURES_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`[repair] 完成：修复 ${repaired} 条，降级 ${failed} 条 → ${FIXTURES_PATH}`);
}

main();
