// check-degradation-registry.test.mjs
// 负控制：证明降级 registry 门禁对每一类回归都会变红（docs/development-standards.md §4）。
// 做法：在临时目录搭 fixture 树（assets/degradation/registry.yaml + component/drill 文件），
// 用 --root 指向它跑真实脚本，断言退出码与输出。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-degradation-registry.mjs", import.meta.url));
const COMPONENT = "src/component.ts";
const DRILL = "tests/drill.spec.ts";
const REGISTRY = "assets/degradation/registry.yaml";

function makeTree(t, name) {
  const root = mkdtempSync(join(tmpdir(), `sati-degradation-${name}-`));
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

/** 铺一棵「干净」的 fixture 树：component 与 drill 都存在，registry 稍后写入。 */
function seedTree(t, name) {
  const root = makeTree(t, name);
  write(root, COMPONENT, "export const x = 1;\n");
  write(root, DRILL, "// 负向演练占位\n");
  return root;
}

/** 生成一条 entry 的 YAML 文本（缩进到 entries 之下）。 */
function entry(opts = {}) {
  const id = opts.id ?? "sample-entry";
  const component = opts.component ?? COMPONENT;
  const failDirection = opts.failDirection ?? "open";
  const observability = opts.observability === undefined ? '"warn 日志"' : opts.observability;
  const lines = [
    `  - id: ${id}`,
    `    component: ${component}`,
    `    dependency: "样例依赖"`,
    `    failDirection: ${failDirection}`,
    `    degradedBehavior: "降级行为"`,
    `    degradedImpact: "谁漏了什么"`,
    `    observability: ${observability}`,
  ];
  if (opts.drill !== null) lines.push(`    negativeDrill: ${opts.drill ?? DRILL}`);
  if (opts.waiver) lines.push(...opts.waiver);
  return lines.join("\n");
}

function writeRegistry(root, entriesYaml) {
  write(root, REGISTRY, `version: 1\nentries:\n${entriesYaml}\n`);
}

test("干净 registry → fresh", t => {
  const root = seedTree(t, "clean");
  writeRegistry(root, entry());
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^check-degradation-registry: fresh（1 条目；open 1 \/ closed 0 \/ mixed 0；豁免 0）/);
});

test("component 路径不存在 → 失败（防登记腐烂）", t => {
  const root = seedTree(t, "component-missing");
  writeRegistry(root, entry({ component: "src/not-exist.ts" }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /发现 1 处 registry 违规/);
  assert.match(result.stderr, /\[sample-entry\] component 路径不存在：src\/not-exist\.ts/);
});

test("failDirection 非法 → 失败", t => {
  const root = seedTree(t, "bad-direction");
  writeRegistry(root, entry({ failDirection: "sometimes" }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failDirection 必须是 open \/ closed \/ mixed/);
});

test("id 重复 → 失败", t => {
  const root = seedTree(t, "dup-id");
  writeRegistry(root, [entry(), entry()].join("\n"));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /id 重复/);
});

test("observability 为空且无豁免 → 失败；挂 intentional_silence+reason 后放行", t => {
  const bad = seedTree(t, "silent-no-waiver");
  writeRegistry(bad, entry({ observability: '""' }));
  const badResult = run(bad);
  assert.equal(badResult.status, 1);
  assert.match(badResult.stderr, /observability 为空/);

  const good = seedTree(t, "silent-waived");
  writeRegistry(
    good,
    entry({
      observability: '""',
      waiver: ["    waiver:", "      kind: intentional_silence", '      reason: "设计注释：丢弃陈旧结果"'],
    }),
  );
  const goodResult = run(good);
  assert.equal(goodResult.status, 0, goodResult.stderr);
});

test("negativeDrill 路径缺失 → 失败；缺省 + drill_missing 豁免 → 放行", t => {
  const rotten = seedTree(t, "drill-rotten");
  writeRegistry(rotten, entry({ drill: "tests/not-exist.spec.ts" }));
  const rottenResult = run(rotten);
  assert.equal(rottenResult.status, 1);
  assert.match(rottenResult.stderr, /negativeDrill 路径不存在/);

  const missing = seedTree(t, "drill-missing-no-waiver");
  writeRegistry(missing, entry({ drill: null }));
  const missingResult = run(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /negativeDrill 缺失/);

  const waived = seedTree(t, "drill-waived");
  writeRegistry(
    waived,
    entry({ drill: null, waiver: ["    waiver:", "      kind: drill_missing", '      reason: "T4 补演习"'] }),
  );
  const waivedResult = run(waived);
  assert.equal(waivedResult.status, 0, waivedResult.stderr);
});

test("冗余豁免即红：drill 已存在仍挂 drill_missing → 失败", t => {
  const root = seedTree(t, "redundant-drill");
  writeRegistry(root, entry({ waiver: ["    waiver:", "      kind: drill_missing", '      reason: "多余"'] }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /冗余豁免：negativeDrill 已存在/);
});

test("冗余豁免即红：observability 已填仍挂 intentional_silence → 失败", t => {
  const root = seedTree(t, "redundant-silence");
  writeRegistry(root, entry({ waiver: ["    waiver:", "      kind: intentional_silence", '      reason: "多余"'] }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /冗余豁免：observability 已填/);
});

test("豁免缺 reason → 失败", t => {
  const root = seedTree(t, "waiver-no-reason");
  writeRegistry(root, entry({ drill: null, waiver: ["    waiver:", "      kind: drill_missing"] }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺 reason/);
});

test("--stats 输出条目数与分布（仍执行校验）", t => {
  const root = seedTree(t, "stats");
  writeRegistry(root, [entry({ id: "a" }), entry({ id: "b", failDirection: "mixed" })].join("\n"));
  const result = run(root, ["--stats"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /条目总数 2/);
  assert.match(result.stdout, /open 1 \/ closed 0 \/ mixed 1/);
});
