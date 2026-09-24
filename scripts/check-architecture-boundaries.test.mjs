// check-architecture-boundaries.test.mjs
// 负控制：证明架构边界门禁对每一类回归都会变红（docs/development-standards.md §4）。
// 做法：在临时目录里搭 fixture 仓库树（src / ui/src / ui/server + 基线文件），
// 用 --root 指向它跑真实脚本，断言退出码与输出。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-architecture-boundaries.mjs", import.meta.url));
const BASELINE = "docs/technical-debt/architecture-baseline.json";

function makeTree(t, name) {
  const root = mkdtempSync(join(tmpdir(), `sati-arch-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined, `无法启动脚本：${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 铺一棵「干净」的 fixture 树并写入基线（空豁免）。 */
function seedCleanTree(t, name) {
  const root = makeTree(t, name);
  write(root, "src/index.ts", "export const a = 1;\n");
  write(root, "ui/src/app.tsx", "export const App = () => null;\n");
  write(root, "ui/server/main.js", "export const server = 1;\n");
  const updated = run(root, ["--update-baseline"]);
  assert.equal(updated.status, 0, updated.stderr);
  return root;
}

const bigFile = lines => Array.from({ length: lines }, (_, index) => `export const v${index} = ${index};`).join("\n");

test("干净树 + 空基线 → fresh", t => {
  const root = seedCleanTree(t, "clean");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^check-architecture-boundaries: fresh（3 规则/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, BASELINE), "utf8")).exemptions, []);
});

test("R1：src/ import ui/（相对路径）→ 失败", t => {
  const root = seedCleanTree(t, "src-to-ui");
  write(root, "src/leak.ts", 'import { x } from "../ui/src/app.js";\nexport const y = x;\n');

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /发现 1 处架构边界违规/);
  assert.match(result.stderr, /src-no-ui-import {2}src\/leak\.ts:1/);
  assert.match(result.stderr, /铁律 2/);
});

test("R1：src/ import 裸包名 ui / sati-ui → 失败；注释里的导入不算", t => {
  const root = seedCleanTree(t, "src-bare-ui");
  write(
    root,
    "src/bare.ts",
    ['// import { a } from "sati-ui";', 'import { b } from "ui/components/x.js";', "export const c = b;"].join("\n"),
  );

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/bare\.ts:2/);
  assert.equal(result.stderr.includes("src/bare.ts:1"), false, "注释里的 import 不应被计为违规");
});

test("R1 不误伤：src/ 引用 @sati/* 别名（不属于 ui/）不算违规", t => {
  const root = seedCleanTree(t, "src-alias");
  write(root, "src/alias.ts", 'import { protocol } from "@sati/web-client";\nexport const p = protocol;\n');

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("R2：ui/src import 后端 src/（相对路径与裸包名）→ 失败", t => {
  const root = seedCleanTree(t, "ui-to-src");
  write(
    root,
    "ui/src/leak.tsx",
    [
      'import { a } from "../../src/index.js";',
      'import { b } from "@sati/web-client";',
      "export const c = [a, b];",
    ].join("\n"),
  );

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ui-src-no-backend-import {2}ui\/src\/leak\.tsx:1/);
  assert.match(result.stderr, /ui\/src\/leak\.tsx:2/);
  assert.match(result.stderr, /WebSocket/);
});

test("R3：超限文件失败；登记进基线后放行；阈值可调", t => {
  const root = seedCleanTree(t, "size");
  write(root, "src/big.ts", bigFile(850));

  const failing = run(root);
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /file-size {2}src\/big\.ts {2}（850 行 > 上限）/);

  // 阈值抬高到 900 → 放行（证明判据是阈值，不是文件本身）。
  const tolerated = run(root, ["--max-file-lines", "900"]);
  assert.equal(tolerated.status, 0, tolerated.stderr);

  // 登记进基线 → 存量不阻塞。
  const updated = run(root, ["--update-baseline"]);
  assert.equal(updated.status, 0, updated.stderr);
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
  assert.deepEqual(baseline.exemptions, [{ rule: "file-size", file: "src/big.ts", lines: 850 }]);
  const baselined = run(root);
  assert.equal(baselined.status, 0, baselined.stderr);
  assert.match(baselined.stdout, /存量豁免 1 条/);
});

test("R3：vendored 子包不参与行数上限，但仍受 R1 约束", t => {
  const root = seedCleanTree(t, "vendored");
  write(root, "src/context/memory/edgeclaw-memory-core/big.ts", bigFile(900));
  write(
    root,
    "src/context/memory/edgeclaw-memory-core/leak.ts",
    'import { x } from "../../../../ui/src/app.js";\nexport const y = x;\n',
  );

  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes("file-size"), false, "vendored 子包不应触发 file-size");
  assert.match(result.stderr, /src-no-ui-import {2}src\/context\/memory\/edgeclaw-memory-core\/leak\.ts:1/);
});

test("基线缺失 → 失败并给出重建命令；基线含已失效条目 → 放行但提示清理", t => {
  const root = seedCleanTree(t, "baseline");
  rmSync(join(root, BASELINE));

  const missing = run(root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /architecture-baseline\.json 不存在/);
  assert.match(missing.stderr, /--update-baseline/);

  // 恢复基线并塞入一条已不再违规的条目。
  write(
    root,
    BASELINE,
    `${JSON.stringify({ version: 1, exemptions: [{ rule: "file-size", file: "src/gone.ts" }] })}\n`,
  );
  const stale = run(root);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /1 条已失效待清理/);
  assert.match(stale.stderr, /基线条目已不再违规/);
});

test("非法参数 → 退出码 2；--help → 0", t => {
  const root = seedCleanTree(t, "args");

  for (const args of [["--max-file-lines", "0"], ["--max-file-lines", "abc"], ["--nope"]]) {
    const result = run(root, args);
    assert.equal(result.status, 2, `参数 ${args.join(" ")} 应报退出码 2`);
  }

  const help = run(root, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^用法：node scripts\/check-architecture-boundaries\.mjs/);
});

test("--update-baseline 会移除已消失的条目（基线不变成永久许可清单）", t => {
  const root = seedCleanTree(t, "rebaseline");
  write(root, "src/big.ts", bigFile(850));
  run(root, ["--update-baseline"]);
  assert.equal(JSON.parse(readFileSync(join(root, BASELINE), "utf8")).exemptions.length, 1);

  // 文件被拆小后重新基线化 → 条目消失。
  write(root, "src/big.ts", "export const small = 1;\n");
  const updated = run(root, ["--update-baseline"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, BASELINE), "utf8")).exemptions, []);
});

// #527 棘轮：基线记录的行数是**上限**，存量豁免文件再增长即视为新违规。
test("R3 棘轮：存量豁免文件增长 → 失败并列 Δ；--update-baseline 追认后放行", t => {
  const root = seedCleanTree(t, "ratchet");
  write(root, "src/big.ts", bigFile(850));
  run(root, ["--update-baseline"]); // 基线记录 850 行
  assert.equal(run(root).status, 0, "登记后应当放行");

  // 同一文件长到 900 行（仍命中「规则+文件」键，但超过基线记录值）。
  write(root, "src/big.ts", bigFile(900));
  const grown = run(root);
  assert.equal(grown.status, 1, "存量文件增长必须被棘轮拦下");
  assert.match(grown.stderr, /900 行 > 基线记录 850 行（\+50 · 棘轮/);
  assert.match(grown.stderr, /其中 1 条是存量豁免文件增长/);

  // --update-baseline 显式追认，并打印本次的 Δ。
  const ack = run(root, ["--update-baseline"]);
  assert.equal(ack.status, 0, ack.stderr);
  assert.match(ack.stdout, /本次追认 1 条 file-size 行数变化（合计 \+50 行）/);
  assert.match(ack.stdout, /src\/big\.ts: 850 → 900（\+50）/);
  assert.equal(JSON.parse(readFileSync(join(root, BASELINE), "utf8")).exemptions[0].lines, 900);

  // 追认后放行。
  assert.equal(run(root).status, 0, "追认后应当放行");
});

// 负控制：把棘轮判据（当前行数 > 基线记录值）去掉，增长用例必须重新变绿——
// 证明拦住增长的是棘轮，而不是别的规则。
test("R3 棘轮负控制：文件缩小到基线以下不触发（判据是「超过记录值」而非「命中基线」）", t => {
  const root = seedCleanTree(t, "ratchet-shrink");
  write(root, "src/big.ts", bigFile(900));
  run(root, ["--update-baseline"]); // 记录 900
  write(root, "src/big.ts", bigFile(850)); // 缩到 850（仍 > 800 上限，但 ≤ 记录值）
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 条已失效待清理|存量豁免 1 条/);
});
