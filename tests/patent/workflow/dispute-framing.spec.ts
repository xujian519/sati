/**
 * dispute_framing 文本契约（#737）：两段标记解析 + 「未识别争点」语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPUTE_CLAIMS_HEADING,
  DISPUTE_GROUNDS_HEADING,
  DISPUTE_UNIDENTIFIED_LABEL,
  parseDisputeFraming,
  renderUnidentifiedDisputeFraming,
} from "../../../src/patent/index.js";

test("parseDisputeFraming: 两段按出现顺序解析，支持项目符号与编号", () => {
  const text = [
    "粗定争点如下：",
    DISPUTE_GROUNDS_HEADING,
    "- 创造性（专利法第22条第3款）",
    "1. 公开不充分（第26条第3款）",
    DISPUTE_CLAIMS_HEADING,
    "- 权利要求1",
    "* 权利要求3",
  ].join("\n");
  assert.deepEqual(parseDisputeFraming(text), {
    grounds: ["创造性（专利法第22条第3款）", "公开不充分（第26条第3款）"],
    claims: ["权利要求1", "权利要求3"],
    unidentified: false,
  });
});

test("parseDisputeFraming: 其它标题结束当前段，段外内容不计入", () => {
  const text = [
    DISPUTE_GROUNDS_HEADING,
    "- 权属争议",
    "## 后续说明",
    "- 不属于争点",
    DISPUTE_CLAIMS_HEADING,
    "- 权利要求2",
  ].join("\n");
  assert.deepEqual(parseDisputeFraming(text), {
    grounds: ["权属争议"],
    claims: ["权利要求2"],
    unidentified: false,
  });
});

test("parseDisputeFraming: 两段都为空 / 缺段 → unidentified（不臆造条目）", () => {
  for (const text of ["", "自由文本，没有分段标记", `${DISPUTE_GROUNDS_HEADING}\n${DISPUTE_CLAIMS_HEADING}`]) {
    assert.deepEqual(parseDisputeFraming(text), { grounds: [], claims: [], unidentified: true });
  }
});

test("parseDisputeFraming: 「未识别」「N/A」占位行不计为条目", () => {
  const text = [DISPUTE_GROUNDS_HEADING, "- 未识别", DISPUTE_CLAIMS_HEADING, "- （N/A）"].join("\n");
  assert.deepEqual(parseDisputeFraming(text), { grounds: [], claims: [], unidentified: true });
});

test("renderUnidentifiedDisputeFraming: 输出可被解析回 unidentified，且写「未识别争点」", () => {
  const text = renderUnidentifiedDisputeFraming("输入缺少对方主张");
  assert.ok(text.includes(DISPUTE_UNIDENTIFIED_LABEL));
  assert.ok(!text.includes("无争点"), "不得把未识别写成无争点");
  assert.deepEqual(parseDisputeFraming(text), { grounds: [], claims: [], unidentified: true });
});
