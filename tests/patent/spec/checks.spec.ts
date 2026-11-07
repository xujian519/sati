import assert from "node:assert/strict";
import test from "node:test";
import { checkSectionCompleteness, matchSectionHeading, splitEmbodiments } from "../../../src/patent/spec/checks.js";

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

test("splitEmbodiments: 兼容 Markdown / 方括号 / 中文序号标题", () => {
  const text = [
    "## 具体实施方式",
    "### 实施例一：",
    "第一实施例包括壳体。",
    "【实施例2】",
    "第二实施例包括盖体。",
    "实施例3",
    "第三实施例包括密封圈。",
  ].join("\n");
  const chunks = splitEmbodiments(text);
  assert.deepEqual(
    chunks.map(chunk => chunk.embodimentId),
    ["一", "2", "3"],
  );
  assert.ok(chunks[1]!.content.includes("第二实施例包括盖体"));
});

test("splitEmbodiments: 正文里的『实施例1中…』不被切成新块", () => {
  const text = ["实施例1：", "在实施例1中，壳体采用铝合金。", "实施例2：", "盖体采用塑料。"].join("\n");
  const chunks = splitEmbodiments(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0]!.content.includes("在实施例1中"));
});

test("splitEmbodiments: 无实施例标题返回空数组（调用方回退整节截断）", () => {
  assert.deepEqual(splitEmbodiments("技术领域\n本发明涉及机械领域。"), []);
});

test("splitEmbodiments: 特征按连续子串绑定到所属实施例", () => {
  const text = ["实施例1：", "包括壳体和盖体。", "实施例2：", "包括密封圈。"].join("\n");
  const chunks = splitEmbodiments(text, ["壳体", "密封圈", "未出现的特征"]);
  assert.deepEqual(chunks[0]!.featureIds, ["壳体"]);
  assert.deepEqual(chunks[1]!.featureIds, ["密封圈"]);
  assert.equal(chunks[1]!.charCount, "包括密封圈。".length);
});
