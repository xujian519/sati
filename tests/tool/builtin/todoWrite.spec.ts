import assert from "node:assert/strict";
import test from "node:test";
import { parseTodoMarkdown } from "../../../src/tool/builtin/todoWrite.js";

/**
 * 与 UI 渲染端共享的 markdown 清单规范用例（见
 * ui/src/components/chat/tools/configs/toolConfigs.parseTodoMarkdown.spec.ts）。
 * 同一组输入必须产出相同的 (content, status) 序列——任何一端改动解析行为，
 * 请同步修改两处用例并保持两端注释互指。
 */
function shape(items: Array<{ content: string; status: string }>): Array<[string, string]> {
  return items.map(item => [item.content, item.status]);
}

test("基础：未完成项首个为 in_progress，其余 pending，勾选项为 completed", () => {
  const result = parseTodoMarkdown("- [ ] 任务A\n- [ ] 任务B\n- [x] 任务C");
  assert.deepEqual(shape(result), [
    ["任务A", "in_progress"],
    ["任务B", "pending"],
    ["任务C", "completed"],
  ]);
});

test("大写 X 视为已完成", () => {
  assert.deepEqual(shape(parseTodoMarkdown("- [X] 大写完成")), [["大写完成", "completed"]]);
});

test("星号与减号两种 bullet 均支持", () => {
  assert.deepEqual(shape(parseTodoMarkdown("- [ ] 减号项\n* [x] 星号完成")), [
    ["减号项", "in_progress"],
    ["星号完成", "completed"],
  ]);
});

test("行首缩进不影响解析", () => {
  assert.deepEqual(shape(parseTodoMarkdown("  - [ ] 缩进项")), [["缩进项", "in_progress"]]);
});

test("非清单行被忽略", () => {
  assert.deepEqual(shape(parseTodoMarkdown("普通文本说明\n- [ ] 任务")), [["任务", "in_progress"]]);
});

test("空内容行被忽略", () => {
  assert.deepEqual(shape(parseTodoMarkdown("- [ ] \n- [ ] 有效任务")), [["有效任务", "in_progress"]]);
});

test("全部完成时无 in_progress", () => {
  assert.deepEqual(shape(parseTodoMarkdown("- [x] 甲\n- [x] 乙")), [
    ["甲", "completed"],
    ["乙", "completed"],
  ]);
});

test("已完成项之后第一个未完成项为 in_progress", () => {
  assert.deepEqual(shape(parseTodoMarkdown("- [x] 完成\n- [ ] 未完成1\n- [ ] 未完成2")), [
    ["完成", "completed"],
    ["未完成1", "in_progress"],
    ["未完成2", "pending"],
  ]);
});

test("内容首尾空白被 trim", () => {
  assert.deepEqual(shape(parseTodoMarkdown("- [ ]  带空格的项  ")), [["带空格的项", "in_progress"]]);
});

test("空字符串或空行返回空数组", () => {
  assert.deepEqual(parseTodoMarkdown(""), []);
  assert.deepEqual(parseTodoMarkdown("\n\n"), []);
});

test("生成的 id 按 1 起连续编号", () => {
  const result = parseTodoMarkdown("- [ ] 甲\n- [ ] 乙");
  assert.deepEqual(
    result.map(item => item.id),
    ["todo-1", "todo-2"],
  );
});
