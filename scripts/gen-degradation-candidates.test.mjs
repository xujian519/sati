// gen-degradation-candidates.test.mjs
// 负控制：证明候选漂移扫描的差集语义（新增候选 / 已确认 / registry 覆盖 / 失效冗余基线）、
// --check 退出码与扫描范围口径。做法：临时目录搭 fixture 树（含 registry 与 candidates-baseline
// 两份资产），用 --root 跑真实脚本，断言输出与退出码。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./gen-degradation-candidates.mjs", import.meta.url));

function makeTree(t, name) {
  const root = mkdtempSync(join(tmpdir(), `sati-degradation-candidates-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** 写入 fixture 的 registry 与 candidates-baseline（content 为 YAML 文本）。 */
function writeAssets(root, { registry, baseline }) {
  write(root, "assets/degradation/registry.yaml", registry);
  write(root, "assets/degradation/candidates-baseline.yaml", baseline);
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined, `无法启动脚本：${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const EMPTY_REGISTRY = "entries: []\n";
const EMPTY_BASELINE = "entries: []\n";

test("差集语义：registry 覆盖 / 已确认 / 新增候选 三路归位", t => {
  const root = makeTree(t, "diff");
  writeAssets(root, {
    registry: "entries:\n  - id: covered\n    component: src/covered.ts\n",
    baseline:
      "entries:\n  - path: src/known.ts\n    disposition: known-unregistered\n    reason: fixture 已知未登记\n  - path: src/waived.ts\n    disposition: waived\n    reason: fixture 豁免\n",
  });
  write(root, "src/covered.ts", "export const a = networkFetch;\n");
  write(root, "src/known.ts", "spawn('git', ['status']);\n");
  write(root, "src/waived.ts", "// 仅注释提及 networkFetch\n");
  write(root, "src/fresh.ts", "const ws = new WebSocket(url);\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /新增候选 1 \/ 已确认 2 \/ registry 覆盖 1 \/ 命中 4/);
  assert.match(result.stdout, /src\/fresh\.ts:1` \[websocket\]/);
  assert.equal(result.stdout.includes("## 新增候选") && /- `src\/fresh\.ts:1`/.test(result.stdout), true);
  // 已确认项带 disposition 与理由；registry 覆盖文件不出现在任何清单行
  assert.match(result.stdout, /`src\/known\.ts` — known-unregistered — fixture 已知未登记/);
  assert.match(result.stdout, /`src\/waived\.ts` — waived — fixture 豁免/);
  assert.equal(/^- .*src\/covered\.ts/m.test(result.stdout), false, "registry 覆盖文件不应出现在清单中");
});

test("--check：新增候选 → exit 1；清零后 exit 0", t => {
  const root = makeTree(t, "check");
  writeAssets(root, { registry: EMPTY_REGISTRY, baseline: EMPTY_BASELINE });
  write(root, "src/fresh.ts", "execSync('git fetch');\n");
  const dirty = run(root, ["--check"]);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /新增候选 1/);

  write(
    root,
    "assets/degradation/candidates-baseline.yaml",
    "entries:\n  - path: src/fresh.ts\n    disposition: waived\n    reason: fixture 登记后清零\n",
  );
  const clean = run(root, ["--check"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /新增候选 0 \/ 已确认 1/);
});

test("失效/冗余基线：不再命中与 registry 覆盖双形态均报且 --check 失败", t => {
  const root = makeTree(t, "stale");
  writeAssets(root, {
    registry: "entries:\n  - id: covered\n    component: src/covered.ts\n",
    baseline:
      "entries:\n  - path: src/gone.ts\n    disposition: waived\n    reason: 文件已删除\n  - path: src/covered.ts\n    disposition: waived\n    reason: 已被 registry 覆盖\n",
  });
  write(root, "src/covered.ts", "networkFetch(url);\n");
  const result = run(root, ["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /失效\/冗余基线 2/);
  assert.match(result.stdout, /`src\/gone\.ts` — 不再命中/);
  assert.match(result.stdout, /`src\/covered\.ts` — 冗余基线/);
});

test("范围口径：spec / .d.ts 排除；src + ui/src + ui/server + scripts + apps/desktop/src 全扫描", t => {
  const root = makeTree(t, "scope");
  writeAssets(root, { registry: EMPTY_REGISTRY, baseline: EMPTY_BASELINE });
  write(root, "src/foo.spec.ts", "networkFetch(url);\n");
  write(root, "src/bar.d.ts", "export declare const x: networkFetch;\n");
  write(root, "src/core.ts", "networkFetch(url);\n");
  write(root, "ui/server/app.js", "import { spawn } from 'child_process';\n");
  write(root, "ui/src/ws.tsx", "new WebSocket(url);\n");
  write(root, "scripts/tool.mjs", "execSync('gh pr list');\n");
  write(root, "apps/desktop/src/main.ts", "spawn(argv[0], argv.slice(1));\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /新增候选 5 \/ 已确认 0 \/ registry 覆盖 0 \/ 命中 5/);
  assert.equal(result.stdout.includes("foo.spec.ts"), false, "spec 文件不应出现在报告中");
  assert.equal(result.stdout.includes("bar.d.ts"), false, "声明文件不应出现在报告中");
  for (const path of [
    "src/core.ts",
    "ui/server/app.js",
    "ui/src/ws.tsx",
    "scripts/tool.mjs",
    "apps/desktop/src/main.ts",
  ]) {
    assert.equal(result.stdout.includes(path), true, `${path} 应被扫描`);
  }
});

test("--report：写出 markdown 报告（CI artifact 语义）", t => {
  const root = makeTree(t, "report");
  writeAssets(root, { registry: EMPTY_REGISTRY, baseline: EMPTY_BASELINE });
  write(root, "src/fresh.ts", "new WebSocketServer({ server });\n");
  const result = run(root, ["--report", "candidates.md"]);
  assert.equal(result.status, 0, result.stderr);
  const reportPath = join(root, "candidates.md");
  assert.equal(existsSync(reportPath), true);
  const report = readFileSync(reportPath, "utf8");
  assert.match(report, /# 降级候选漂移报告/);
  assert.match(report, /新增候选 1/);
  assert.match(report, /src\/fresh\.ts:1` \[websocket\]/);
});

test("基线与 registry 资产缺失/非法 → exit 2（配置错误与候选无关）", t => {
  const missing = makeTree(t, "missing-assets");
  write(missing, "src/a.ts", "networkFetch(url);\n");
  const missingResult = run(missing);
  assert.equal(missingResult.status, 2);
  assert.match(missingResult.stderr, /registry\.yaml 失败/);

  const invalid = makeTree(t, "invalid-baseline");
  writeAssets(invalid, {
    registry: EMPTY_REGISTRY,
    baseline: "entries:\n  - path: src/a.ts\n    disposition: whatever\n    reason: 非法枚举\n",
  });
  write(invalid, "src/a.ts", "networkFetch(url);\n");
  const invalidResult = run(invalid);
  assert.equal(invalidResult.status, 2);
  assert.match(invalidResult.stderr, /disposition 必须是 known-unregistered \/ waived/);
});
