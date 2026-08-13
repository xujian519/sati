import assert from "node:assert/strict";
import test from "node:test";
import { buildStep1Prompt, buildStep2Prompt, FIGURE_SPEC_GUIDE } from "../../../src/patent/figure/prompts.js";

test("FIGURE_SPEC_GUIDE 含标号谨慎规则且区分 U1/U2 占位符机制", () => {
  assert.match(FIGURE_SPEC_GUIDE, /不得臆造编号或用近似编号代替/);
  // 显式区分「标号模糊」与「部件确实无标号」，避免模型把无标号部件误判为无法确认
  assert.match(FIGURE_SPEC_GUIDE, /确实无标号/);
  assert.match(FIGURE_SPEC_GUIDE, /U1\/U2/);
});

test("FIGURE_SPEC_GUIDE 含图面证据粒度规则", () => {
  assert.match(FIGURE_SPEC_GUIDE, /物理形态、空间相对位置与连接关系/);
  assert.match(FIGURE_SPEC_GUIDE, /图面未显示的信息（材料、参数等）不得补充/);
});

test("buildStep1Prompt 含旋转/模糊 notes 指令", () => {
  const prompt = buildStep1Prompt(1, undefined);
  assert.match(prompt, /旋转（横向\/竖向）/);
  assert.match(prompt, /在 notes 中逐条说明/);
});

test("buildStep1Prompt 含 JSON 安全约束", () => {
  const prompt = buildStep1Prompt(1, undefined);
  assert.match(prompt, /不要用 markdown 代码围栏/);
  assert.match(prompt, /所有键与字符串使用双引号/);
});

test("buildStep2Prompt 含组件描述粒度指令", () => {
  const prompt = buildStep2Prompt(1, "structure", "整体描述", undefined);
  assert.match(prompt, /形状、位置、与相邻部件的连接方式/);
  assert.match(prompt, /图面未展示的内容不得补充/);
});
