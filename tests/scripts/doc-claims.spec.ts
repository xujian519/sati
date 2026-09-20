import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanMarkers } from "../../scripts/gen-doc-claims.js";
import { CLAIMS, resolveAllClaims } from "../../scripts/doc-claims/resolvers.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";

/**
 * 负控制：`check:doc-claims` 门禁的自测。
 *
 * 三层：
 *   1. marker 扫描器的四种失败形态（过期值 / 未知 id / 未闭合 / 合规）必须分别报错或放过；
 *   2. claim 值必须与**独立测量**一致（工具数取运行期注册结果，防解析器被写歪）；
 *   3. 端到端：编译产物 `dist/scripts/gen-doc-claims.js --check` 在当前仓库必须为绿
 *      （防门禁因路径/语法问题恒失败或恒通过）。
 */
const REPO_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found (no package.json ancestor)");
    dir = parent;
  }
  return dir;
})();

const VALUES = new Map([
  ["app_version", "9.9.9"],
  ["patent_tool_count", "26"],
]);

function marker(id: string, value: string): string {
  return `<!-- claim:${id} -->${value}<!-- /claim -->`;
}

test("marker 扫描：值一致时零问题并命中", () => {
  const scan = scanMarkers("doc.md", `版本 ${marker("app_version", "9.9.9")}。`, VALUES);
  assert.deepEqual(scan.issues, []);
  assert.equal(scan.hits.length, 1);
});

test("marker 扫描：值过期时报出文档值与代码值", () => {
  const scan = scanMarkers("doc.md", `版本 ${marker("app_version", "0.1.4")}。`, VALUES);
  assert.equal(scan.issues.length, 1);
  assert.match(scan.issues[0]?.message ?? "", /claim app_version 过期：文档 "0\.1\.4" ≠ 代码 "9\.9\.9"/);
});

test("marker 扫描：未知 claim id 报错（防拼写错误的标记被静默忽略）", () => {
  const scan = scanMarkers("doc.md", marker("app_verison", "1"), VALUES);
  assert.equal(scan.issues.length, 1);
  assert.match(scan.issues[0]?.message ?? "", /未知 claim id "app_verison"/);
});

test("marker 扫描：同一文档内的多个标记各自独立（不互相吞并）", () => {
  const text = `${marker("app_version", "9.9.9")} 中间正文 ${marker("patent_tool_count", "26")}`;
  const scan = scanMarkers("doc.md", text, VALUES);
  assert.deepEqual(scan.issues, []);
  assert.equal(scan.hits.length, 2);
});

test("marker 扫描：标记未闭合（值内出现新的起始符）报错而非吞正文", () => {
  // 只有起始符、缺 `/claim` 收尾 → 非贪婪匹配会一路吞到下一个 `/claim`，必须报错。
  const text = `<!-- claim:app_version -->9.9.9 <!-- claim:patent_tool_count -->26<!-- /claim -->`;
  const scan = scanMarkers("doc.md", text, VALUES);
  assert.ok(
    scan.issues.some(issue => /未正确闭合/.test(issue.message)),
    JSON.stringify(scan.issues),
  );
});

test("claim 值：与运行期独立测量一致（工具数不靠解析器自证）", () => {
  const values = resolveAllClaims();
  const tools = createBuiltinRegistry().list();
  assert.equal(values.get("default_tool_count"), String(tools.length));
  assert.equal(values.get("patent_tool_count"), String(tools.filter(tool => tool.domain === "patent").length));
  for (const claim of CLAIMS) {
    assert.equal(typeof values.get(claim.id), "string", `claim ${claim.id} 未解析出值`);
    assert.notEqual(values.get(claim.id), "", `claim ${claim.id} 解析为空`);
  }
});

test("端到端：编译产物的 --check 在当前仓库为绿", t => {
  const compiled = join(REPO_ROOT, "dist", "scripts", "gen-doc-claims.js");
  if (!existsSync(compiled)) {
    // `pnpm test` 先 build（dist 必然存在）；单独用 tsx 跑本文件时 dist 可能缺失。
    t.skip("dist/scripts/gen-doc-claims.js 不存在：请先 `pnpm build`（pnpm test 会自动 build）");
    return;
  }
  const result = spawnSync(process.execPath, [compiled, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, `check:doc-claims 应为绿，实际输出：\n${output}`);
  assert.match(output, /gen-doc-claims: fresh/);
});
