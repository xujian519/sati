/**
 * src/patent/figure/symbols — 电学符号知识库加载器测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSymbolsAsContext,
  loadElectricalSymbols,
  parseRefNumber,
  querySymbolById,
  querySymbolByRefPrefix,
} from "../../../src/patent/figure/symbols/index.js";

test("符号库加载：条目数量、id 唯一、refPrefix 非空", () => {
  const index = loadElectricalSymbols();
  assert.ok(index.all.length >= 25, `符号库应覆盖 25+ 类常见符号（当前 ${index.all.length}）`);
  const ids = index.all.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, "符号 id 必须唯一");
  for (const entry of index.all) {
    assert.ok(entry.nameZh.length > 0, `${entry.id} 缺中文名`);
    assert.ok(entry.refPrefix.length > 0, `${entry.id} 缺标号前缀`);
    assert.ok(entry.drawingHints.length > 0, `${entry.id} 缺画法要点`);
  }
});

test("符号库索引：按前缀与 id 查询", () => {
  const resistors = querySymbolByRefPrefix("R");
  assert.ok(
    resistors.some(e => e.id === "resistor"),
    "R 前缀应命中电阻",
  );
  assert.ok(
    querySymbolByRefPrefix("r").some(e => e.id === "resistor"),
    "前缀查询大小写不敏感",
  );

  const caps = querySymbolByRefPrefix("C");
  assert.ok(
    caps.some(e => e.id === "capacitor"),
    "C 前缀应命中电容",
  );

  assert.equal(querySymbolById("resistor")?.category, "passive");
  assert.equal(querySymbolById("transistor_bjt")?.terminalCount, 3);
  assert.equal(querySymbolById("not-exist"), undefined);
});

test("parseRefNumber：解析字母前缀+编号", () => {
  assert.deepEqual(parseRefNumber("R1"), { prefix: "R", number: "1" });
  assert.deepEqual(parseRefNumber("IC2"), { prefix: "IC", number: "2" });
  assert.deepEqual(parseRefNumber("r3"), { prefix: "R", number: "3" });
  assert.equal(parseRefNumber("GND"), null, "无编号的电源/地符号不解析");
  assert.equal(parseRefNumber("12"), null, "纯数字不解析");
});

test("formatSymbolsAsContext：输出包含符号名称与画法要点", () => {
  const context = formatSymbolsAsContext();
  assert.ok(context.includes("电阻"), "上下文应包含电阻");
  assert.ok(context.includes("电阻".length > 0 ? "标号前缀" : ""), "上下文应含标号前缀说明");
  assert.ok(context.includes("电容") && context.includes("二极管"));
  assert.ok(context.includes("画法"), "上下文应含画法要点");
});
