// check-ui-server-boundary.test.mjs
// 负控制：ui/server → src/ 边界门禁**真的会拦**。
//
// 为什么这份测试是修 bug 的直接产物：该门禁原先先用状态机把注释与字符串字面量整体置空，
// 再匹配带引号的 specifier —— specifier 就在字符串里，置空后正则永远匹配不到，门禁从上线起
// 从未拦下任何导入（2026-09-22 实测：伪造深层导入仍输出 fresh）。下面第 2/3/5 例正是当时漏检的形态。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_SRC_PATHS } from "./check-ui-server-boundary.mjs";

const SCRIPT = fileURLToPath(new URL("./check-ui-server-boundary.mjs", import.meta.url));

function write(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** ui/eslint.config.js 的 except 列表需与脚本白名单一致（脚本自带防漂移自检）。 */
function eslintConfig(except) {
  const items = except.map(path => `        "${path}",`).join("\n");
  return [
    "export default [",
    "  {",
    "    rules: {",
    '      "import-x/no-restricted-paths": [',
    "        {",
    "          except: [",
    items,
    "          ],",
    "        },",
    "      ],",
    "    },",
    "  },",
    "];",
    "",
  ].join("\n");
}

/** 搭 fixture 树：完整白名单 + 一个空的 ui/server 探针文件。 */
function makeTree(t, name, { except = [...ALLOWED_SRC_PATHS], withEslintConfig = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), `sati-uisrv-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (withEslintConfig) write(root, "ui/eslint.config.js", eslintConfig(except));
  write(root, "ui/server/probe.js", "export const probe = 1;\n");
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  assert.equal(result.error, undefined, `无法启动脚本：${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("白名单 barrel 入口 → fresh", t => {
  const root = makeTree(t, "allowed");
  write(
    root,
    "ui/server/probe.js",
    'import { gateway } from "../../src/gateway/index.js";\nexport const g = gateway;\n',
  );

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-ui-server-boundary: fresh/);
});

test("未白名单的深层静态导入 → 失败（2026-09-22 前此处空转）", t => {
  const root = makeTree(t, "deep-static");
  write(
    root,
    "ui/server/probe.js",
    'import { deep } from "../../src/patent/workflow/runtime/deepInternal.js";\nexport const d = deep;\n',
  );

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ui\/server\/probe\.js:1 → src\/patent\/workflow\/runtime\/deepInternal\.js/);
});

test("未白名单的动态 import() → 失败", t => {
  const root = makeTree(t, "deep-dynamic");
  write(
    root,
    "ui/server/probe.js",
    'const mod = await import("../../src/agent/loop/AgentLoop.js");\nexport default mod;\n',
  );

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /probe\.js:1 → src\/agent\/loop\/AgentLoop\.js/);
});

test(".cjs 的 require() 逃生口同样纳入门禁", t => {
  const root = makeTree(t, "cjs-require");
  write(
    root,
    "ui/server/legacy.cjs",
    'const deep = require("../../src/patent/evidence/engine.js");\nmodule.exports = { deep };\n',
  );

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /legacy\.cjs:1 → src\/patent\/evidence\/engine\.js/);
});

test("注释里的导入不误报（门禁只认语法树里的真实导入）", t => {
  const root = makeTree(t, "commented");
  write(
    root,
    "ui/server/probe.js",
    [
      "// import { deep } from '../../src/patent/deep.js';",
      "/*",
      "  const legacy = require('../../src/patent/legacy.js');",
      "*/",
      'import { gateway } from "../../src/gateway/index.js";',
      "export const g = gateway;",
    ].join("\n"),
  );

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("eslint except 与白名单漂移 → 失败（防漂移自检）", t => {
  const root = makeTree(t, "except-drift", { except: ["gateway/index.js"] });

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /eslint except 缺白名单项/);
});

test("ui/eslint.config.js 缺失 → 失败（不静默禁用自检）", t => {
  const root = makeTree(t, "no-eslint-config", { withEslintConfig: false });

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /无法解析 ui\/eslint.config\.js/);
});
