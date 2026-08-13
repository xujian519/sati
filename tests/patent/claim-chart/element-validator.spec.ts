import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWhitespace, validateElements } from "../../../src/patent/claim-chart/runtime/element-validator.js";
import type { ClaimElement } from "../../../src/patent/claim-chart/protocol/types.js";

const CLAIM = "1. 一种过滤装置，包括壳体和滤芯，所述滤芯含有活性炭。";

function el(id: string, text: string): ClaimElement {
  return { id, claimNo: Number(id[0]), text, kind: "limitation" };
}

test("normalizeWhitespace 归一化空白", () => {
  assert.equal(normalizeWhitespace(" 包括壳体  和滤芯\n"), "包括壳体 和滤芯");
});

test("合法要素全部通过", () => {
  const res = validateElements([el("1a", "包括壳体"), el("1b", "和滤芯"), el("1c", "所述滤芯含有活性炭")], CLAIM);
  assert.equal(res.ok, true);
});

test("要素文本被改写（非原文连续子串）时报错", () => {
  const res = validateElements([el("1a", "包括外壳")], CLAIM);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors[0]!.includes("不是权利要求原文的连续子串"));
  }
});

test("要素编号跳号时报错", () => {
  const res = validateElements([el("1a", "包括壳体"), el("1c", "和滤芯")], CLAIM);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some(e => e.includes("跳号")));
  }
});

test("编号重复与格式非法报错", () => {
  const res = validateElements([el("1a", "包括壳体"), el("1a", "和滤芯"), el("X", "所述滤芯含有活性炭")], CLAIM);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some(e => e.includes("重复")));
    assert.ok(res.errors.some(e => e.includes("格式非法")));
  }
});

test("claimNo 与编号不一致报错", () => {
  const res = validateElements([{ id: "1a", claimNo: 2, text: "包括壳体", kind: "limitation" }], CLAIM);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some(e => e.includes("claimNo")));
  }
});

test("权利要求原文为空或要素列表为空报错", () => {
  assert.equal(validateElements([el("1a", "x")], "").ok, false);
  assert.equal(validateElements([], CLAIM).ok, false);
});

test("claim 原文含换行折行时要素仍通过（空白不参与比较）", () => {
  const wrapped = "1. 一种过滤装置，包括\n壳体和滤芯，所述滤芯含有活性炭。";
  const res = validateElements([el("1a", "包括壳体"), el("1b", "和滤芯"), el("1c", "所述滤芯含有活性炭")], wrapped);
  assert.equal(res.ok, true);
});

test("多 claim 共存且各自连续时通过，跨 claim 跳号报错", () => {
  const multi = "1. 一种过滤装置，包括壳体和滤芯。2. 所述滤芯含有活性炭。";
  const ok = validateElements([el("1a", "包括壳体"), el("1b", "和滤芯"), el("2a", "所述滤芯含有活性炭")], multi);
  assert.equal(ok.ok, true);

  const bad = validateElements(
    [el("1a", "包括壳体"), el("1b", "和滤芯"), el("2a", "所述滤芯含有活性炭"), el("2c", "活性炭")],
    multi,
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.some(e => e.includes("跳号")));
  }
});

test("要素文本必须来自自身 claim 段（跨 claim 借用被拒）", () => {
  const multi = "1. 一种过滤装置，包括壳体和滤芯。\n2. 如权利要求1所述，所述滤芯含有活性炭。";
  // 1a 的文本实际来自 claim 2 的段 → 应在 claim 1 段内找不到
  const bad = validateElements([el("1a", "所述滤芯含有活性炭"), el("2a", "所述滤芯含有活性炭")], multi);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.some(e => e.includes("claim 1 段内未找到")));
  }
  // 各自段内命中则通过
  const ok = validateElements([el("1a", "包括壳体"), el("1b", "和滤芯"), el("2a", "所述滤芯含有活性炭")], multi);
  assert.equal(ok.ok, true);
});

test("空白-only 要素文本报错", () => {
  const res = validateElements([el("1a", "   ")], CLAIM);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some(e => e.includes("文本为空")));
  }
});
