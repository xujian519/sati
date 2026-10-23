import assert from "node:assert/strict";
import test from "node:test";
import { checkSectionCompleteness, matchSectionHeading } from "../../../src/patent/spec/checks.js";

const PLAIN_SPEC = [
  "技术领域",
  "本发明涉及机械技术领域。",
  "背景技术",
  "现有技术存在效率低下的问题。",
  "发明内容",
  "本发明提供一种装置。",
  "附图说明",
  "图1为本发明实施例的整体结构示意图。",
  "具体实施方式",
  "实施例1：如图1所示。",
].join("\n");

test("matchSectionHeading: Markdown / 纯文本 / 编号 / 方括号共用一套识别", () => {
  assert.equal(matchSectionHeading("## 技术领域"), "技术领域");
  assert.equal(matchSectionHeading("## 技术领域（Technical Field）"), "技术领域");
  assert.equal(matchSectionHeading("###### 具体实施方式"), "具体实施方式");
  assert.equal(matchSectionHeading("一、背景技术"), "背景技术");
  assert.equal(matchSectionHeading("（一）发明内容"), "发明内容");
  assert.equal(matchSectionHeading("【附图说明】"), "附图说明");
  assert.equal(matchSectionHeading("本发明属于技术领域。"), undefined);
});

test("checkSectionCompleteness: 纯文本说明书判齐全（与 validate_specification 同源）", () => {
  assert.deepEqual(checkSectionCompleteness(PLAIN_SPEC), []);
});

test("checkSectionCompleteness: 只缺附图说明时仅返回该节", () => {
  const text = PLAIN_SPEC.replace("附图说明\n图1为本发明实施例的整体结构示意图。\n", "");
  assert.deepEqual(checkSectionCompleteness(text), ["附图说明"]);
});

test("checkSectionCompleteness: 正文提及章节名不算标题", () => {
  const text = PLAIN_SPEC.replace("技术领域\n本发明涉及机械技术领域。\n", "背景技术\n本发明属于技术领域。\n");
  assert.ok(checkSectionCompleteness(text).includes("技术领域"));
});
