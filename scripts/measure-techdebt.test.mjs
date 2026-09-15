import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { isDoubleAssertionThroughUnknown, perModuleOf } from "./measure-techdebt.mjs";

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
