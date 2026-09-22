// import-specifiers.test.mjs
// scripts/lib/import-specifiers.mjs 的单测：边界门禁的**判据**必须精确——漏报会让门禁空转
// （scripts/check-ui-server-boundary.mjs 2026-09-22 前的实际状态），误报会让门禁拦住合法改动。
//
// 挂载：package.json 的 `test:pr-tooling`（CI quality job 的 "Self-test PR tooling gates" 步骤）。

import assert from "node:assert/strict";
import test from "node:test";
import { extractModuleSpecifiers, isRelativeSpecifier, lineAt, scriptKindOf } from "./lib/import-specifiers.mjs";

const specifiersOf = source => extractModuleSpecifiers("probe.ts", source).map(entry => entry.specifier);

test("提取静态 import / export … from / 动态 import() / require() 四种形态", () => {
  const source = [
    'import { a } from "./a.js";',
    'import type { B } from "../shared/b.js";',
    'export * from "./c.js";',
    'export { d } from "./d.js";',
    'const e = await import("../ui/e.js");',
    'const f = require("./f.cjs");',
    'import g = require("./g.js");',
    'import "./side-effect.js";',
  ].join("\n");
  assert.deepEqual(specifiersOf(source), [
    "./a.js",
    "../shared/b.js",
    "./c.js",
    "./d.js",
    "../ui/e.js",
    "./f.cjs",
    "./g.js",
    "./side-effect.js",
  ]);
});

test("注释里的假 import 不进语法树（不误报）", () => {
  const source = [
    '// import { x } from "../ui/x.js";',
    "/*",
    '  import { y } from "../ui/y.js";',
    "*/",
    'import { z } from "./z.js";',
  ].join("\n");
  assert.deepEqual(specifiersOf(source), ["./z.js"]);
});

test("字符串里的 require/import 形态是数据，不是导入（旧实现正是在此处误报/空转两端失衡）", () => {
  const source = [
    "const a = 'require(\"../ui/a.js\")';",
    'const b = "import x from \\"../ui/b.js\\"";',
    'const c = `import("../ui/c.js")`;',
  ].join("\n");
  assert.deepEqual(specifiersOf(source), []);
});

test("模板字面量 ${} 里的真实动态 import 不漏报", () => {
  const source = 'async function load() { return `${await import("../ui/lazy.js")}`; }';
  assert.deepEqual(specifiersOf(source), ["../ui/lazy.js"]);
});

test("多行 import 与 type-only 形态", () => {
  const source = [
    "import {",
    "  alpha,",
    "  beta,",
    '} from "../ui/multi.js";',
    "export type { T } from './t.js';",
  ].join("\n");
  assert.deepEqual(specifiersOf(source), ["../ui/multi.js", "./t.js"]);
});

test("offset 指向 specifier 字面量起点，可用于换算行号", () => {
  const source = ["const a = 1;", 'import { b } from "./b.js";'].join("\n");
  const [entry] = extractModuleSpecifiers("probe.ts", source);
  assert.equal(lineAt(source, entry.offset), 2);
  assert.equal(source.slice(entry.offset, entry.offset + 6), '"./b.j');
});

test("脚本类型按扩展名选择：JS 与 TSX 都能解析", () => {
  assert.equal(scriptKindOf("a.tsx") !== scriptKindOf("a.ts"), true);
  assert.deepEqual(
    extractModuleSpecifiers("probe.js", 'const x = require("./x.cjs");').map(e => e.specifier),
    ["./x.cjs"],
  );
  assert.deepEqual(
    extractModuleSpecifiers("probe.tsx", 'import React from "react";\nexport const C = () => <div/>;').map(
      e => e.specifier,
    ),
    ["react"],
  );
});

test("isRelativeSpecifier 只认 ./ 与 ../", () => {
  assert.equal(isRelativeSpecifier("./a.js"), true);
  assert.equal(isRelativeSpecifier("../a.js"), true);
  assert.equal(isRelativeSpecifier("sati-ui"), false);
  assert.equal(isRelativeSpecifier("@sati/web-client"), false);
  assert.equal(isRelativeSpecifier(".hidden"), false);
});
