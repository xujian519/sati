import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  isDoubleAssertionThroughUnknown,
  listFiles,
  metricBodyDiff,
  normalizeForCheck,
  perModuleOf,
} from "./measure-techdebt.mjs";

const SCRIPT = fileURLToPath(new URL("./measure-techdebt.mjs", import.meta.url));
const METRICS = fileURLToPath(new URL("../docs/technical-debt/metrics.md", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 跑一次 `--check`，返回退出码（非 0 不抛异常）。 */
function runCheck(target) {
  try {
    execFileSync(process.execPath, [SCRIPT, "--check", target], { stdio: "pipe", encoding: "utf8" });
    return 0;
  } catch (e) {
    return e.status;
  }
}

/**
 * 在给定源码片段上统计「经 unknown 的双重断言」命中数。
 * 与 `scanTypeEscapes` 的遍历方式一致（对每个节点判定、不剪枝），
 * 以便顺带覆盖「同一表达式不被重复计数」的语义。
 */
function countHits(source) {
  const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let hits = 0;
  const visit = node => {
    if (isDoubleAssertionThroughUnknown(node, ts)) hits += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

test("`x as unknown as T` 命中 1 次", () => {
  assert.equal(countHits("const y = x as unknown as Foo;"), 1);
});

test("括号是透明包装：`(x as unknown) as T` 同样命中", () => {
  assert.equal(countHits("const y = (x as unknown) as Foo;"), 1);
});

test("多层括号同样命中", () => {
  assert.equal(countHits("const y = ((x as unknown)) as Foo;"), 1);
});

test("三元串联 `as unknown as unknown as T` 只计 1 次（不重复计数）", () => {
  assert.equal(countHits("const y = x as unknown as unknown as Foo;"), 1);
});

test("单次 `as unknown`（仅加宽）不命中", () => {
  assert.equal(countHits("const y = x as unknown;"), 0);
});

test("普通断言 `as T` 不命中", () => {
  assert.equal(countHits("const y = x as Foo;"), 0);
});

test("`as any` 不命中（any 与双重断言分列两口径）", () => {
  assert.equal(countHits("const y = x as any;"), 0);
});

test("`<T>x` 旧式类型断言不命中", () => {
  assert.equal(countHits("const y = <Foo>x;"), 0);
});

test("整文件多行混合：只数真正的双重断言", () => {
  const hits = countHits(`
    const a = one as unknown as A;
    const b = two as B;
    const c = three as unknown;
    const d = four as unknown as unknown as D;
    const e = five as unknown as E;
  `);
  assert.equal(hits, 3);
});

test("注释与字符串里的 `as unknown as` 不命中（AST 口径的要点）", () => {
  const hits = countHits(`
    // 这里曾写 x as unknown as Foo，现已消除
    const s = "y as unknown as Bar";
    const z = ok as Ok;
  `);
  assert.equal(hits, 0);
});

test("perModuleOf 按模块聚合（src/ui 前缀规则）", () => {
  const perModule = perModuleOf([
    { file: "src/agent/loop/AgentLoop.ts" },
    { file: "src/agent/turn/TurnRunner.ts" },
    { file: "ui/src/components/app-shell/AppShellV2.tsx" },
    { file: "ui/server/routes/commands.js" },
    { file: "tests/agent/loop/x.spec.ts" },
  ]);
  assert.deepEqual(perModule, {
    agent: 2,
    "ui/src": 1,
    "ui/server": 1,
    tests: 1,
  });
});

test("perModuleOf 空输入返回空对象", () => {
  assert.deepEqual(perModuleOf([]), {});
});

// ---------------------------------------------------------------------------
// 文件清单必须 git 感知（本机与 CI 口径一致）
// ---------------------------------------------------------------------------

test("【负控制】listFiles 不返回被 .gitignore 忽略的文件", () => {
  // 磁盘上存在被忽略的 tests/**.test.ts（本仓实测 5 个），它们在 CI 检出树里不存在。
  // 若 listFiles 退回 readdir 遍历，本机与 CI 会得出不同的指标，--check 门禁必假红。
  const files = listFiles(join(REPO_ROOT, "tests"), [".ts", ".tsx", ".js"]).map(f => relative(REPO_ROOT, f));
  assert.ok(files.length > 0, "tests/ 下应至少有一个文件");
  const res = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: REPO_ROOT,
    input: files.join("\n"),
    encoding: "utf8",
  });
  // git check-ignore --stdin：有任一被忽略者退 0（并打印之），全部未被忽略退 1。
  assert.equal(res.status, 1, `以下文件被 .gitignore 忽略却仍被计入：\n${res.stdout}`);
});

test("【负控制】listFiles 计入未跟踪但未被忽略的新文件", () => {
  // 「先刷新基线、再 git add」是常见顺序；若只认 --cached，新文件会被漏计。
  const dir = mkdtempSync(join(REPO_ROOT, "tests", "tmp-listfiles-"));
  try {
    const probe = join(dir, "probe.spec.ts");
    writeFileSync(probe, "// probe\n", "utf8");
    const files = listFiles(dir, [".ts", ".tsx"]);
    assert.deepEqual(
      files.map(f => relative(REPO_ROOT, f)),
      [relative(REPO_ROOT, probe)],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFiles 按扩展名过滤并排除 .d.ts", () => {
  const files = listFiles(join(REPO_ROOT, "scripts"), [".mjs"]);
  assert.ok(files.length > 0);
  assert.ok(files.every(f => f.endsWith(".mjs")));
});

// ---------------------------------------------------------------------------
// 基线新鲜度校验（issue #340）
// ---------------------------------------------------------------------------

test("normalizeForCheck 忽略快照时间戳（否则隔日必假红）", () => {
  const a = normalizeForCheck("> 最近一次快照：**2026-09-11**\n| 指标 | 值 |");
  const b = normalizeForCheck("> 最近一次快照：**2026-09-15**\n| 指标 | 值 |");
  assert.equal(a, b);
  assert.ok(a.includes("**<date>**"));
});

test("normalizeForCheck 丢弃「历史快照」段（不属于本次内容）", () => {
  assert.equal(normalizeForCheck("正文\n\n## 历史快照\n\n- 2026-08-23 是老数字"), "正文");
});

test("normalizeForCheck 无历史段时原样保留", () => {
  assert.equal(normalizeForCheck("正文\n"), "正文");
});

test("metricBodyDiff 分别报出「缺少」与「多余」，且不受行序影响", () => {
  const d = metricBodyDiff("a\nb\nc", "c\na\nd");
  assert.deepEqual(d.missing, ["d"]);
  assert.deepEqual(d.extra, ["b"]);
});

test("metricBodyDiff 正文一致时两侧皆空", () => {
  const d = metricBodyDiff("a\nb", "a\nb");
  assert.deepEqual(d, { missing: [], extra: [] });
});

test("metricBodyDiff 正确处理重复行（多重集而非集合）", () => {
  const d = metricBodyDiff("x\nx\ny", "x\ny");
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.extra, ["x"]);
});

test("【负控制】仓库当前基线必须是新鲜的（--check 退出 0）", () => {
  assert.equal(runCheck(METRICS), 0, "基线过期——请跑 pnpm measure:update 后重试");
});

test("【负控制】正文被插入一行后 --check 非 0 退出", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-metrics-"));
  try {
    const lines = readFileSync(METRICS, "utf8").split("\n");
    lines.splice(1, 0, "| 伪造指标 | 1 |");
    const target = join(dir, "metrics.md");
    writeFileSync(target, lines.join("\n"), "utf8");
    assert.equal(runCheck(target), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("【负控制】数字被改动后 --check 非 0 退出", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-metrics-"));
  try {
    const original = readFileSync(METRICS, "utf8");
    const mutated = original.replace(/\| (\d+) \|/, (m, n) => `| ${Number(n) + 1} |`);
    assert.notEqual(mutated, original, "未能在基线中改动任何数字——用例失效");
    const target = join(dir, "metrics.md");
    writeFileSync(target, mutated, "utf8");
    assert.equal(runCheck(target), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("【负控制】基线文件不存在时 --check 非 0 退出", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-metrics-"));
  try {
    assert.equal(runCheck(join(dir, "nope.md")), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
