import assert from "node:assert/strict";
import test from "node:test";
import { validatePinCite, verifyQuoteInSource } from "../../../src/patent/claim-chart/runtime/pin-cite-validator.js";

const SOURCE = [
  "说明书",
  "[0032]",
  "本实施例的壳体由不锈钢制成，滤芯含有活性炭。",
  "[0033]",
  "滤芯可拆卸地安装于壳体内。",
].join("\n");

test("合法 pin-cite 且段号存在通过", () => {
  assert.deepEqual(validatePinCite("[D1 段[0032] 图3]", SOURCE), { ok: true });
  assert.deepEqual(validatePinCite("[D1 段[0033]]", SOURCE), { ok: true });
});

test("格式非法报错", () => {
  const res = validatePinCite("D1 段 0032", SOURCE);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.reason.includes("格式非法"));
});

test("段号不存在报错（防幻觉引用）", () => {
  const res = validatePinCite("[D1 段[0099]]", SOURCE);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.reason.includes("不存在"));
});

test("quote 必须是源文子串（归一化空白后）", () => {
  assert.equal(verifyQuoteInSource("壳体由不锈钢制成，滤芯含有活性炭", SOURCE).ok, true);
  assert.equal(verifyQuoteInSource("壳体由 不锈钢\n制成", SOURCE).ok, true);
  const bad = verifyQuoteInSource("壳体由钛合金制成", SOURCE);
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.includes("不存在"));
});

test("空引用放行（not-found 行允许空证据）", () => {
  assert.equal(verifyQuoteInSource("", SOURCE).ok, true);
});
