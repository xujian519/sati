import { describe, expect, it } from "vitest";
import { parseTodoMarkdown } from "./todoParsing";

/**
 * 与后端共享的 markdown 清单规范用例（见
 * tests/tool/builtin/todoWrite.spec.ts）。
 * 同一组输入必须产出相同的 (content, status) 序列——任何一端改动解析行为，
 * 请同步修改两处用例并保持两端注释互指。
 */
function shape(items: Array<{ content: string; status: string }>): Array<[string, string]> {
  return items.map(item => [item.content, item.status]);
}

describe("parseTodoMarkdown（与后端共享规范）", () => {
  it("基础：未完成项首个为 in_progress，其余 pending，勾选项为 completed", () => {
    const result = parseTodoMarkdown("- [ ] 任务A\n- [ ] 任务B\n- [x] 任务C");
    expect(shape(result)).toEqual([
      ["任务A", "in_progress"],
      ["任务B", "pending"],
      ["任务C", "completed"],
    ]);
  });

  it("大写 X 视为已完成", () => {
    expect(shape(parseTodoMarkdown("- [X] 大写完成"))).toEqual([["大写完成", "completed"]]);
  });

  it("星号与减号两种 bullet 均支持", () => {
    expect(shape(parseTodoMarkdown("- [ ] 减号项\n* [x] 星号完成"))).toEqual([
      ["减号项", "in_progress"],
      ["星号完成", "completed"],
    ]);
  });

  it("行首缩进不影响解析", () => {
    expect(shape(parseTodoMarkdown("  - [ ] 缩进项"))).toEqual([["缩进项", "in_progress"]]);
  });

  it("非清单行被忽略", () => {
    expect(shape(parseTodoMarkdown("普通文本说明\n- [ ] 任务"))).toEqual([["任务", "in_progress"]]);
  });

  it("空内容行被忽略", () => {
    expect(shape(parseTodoMarkdown("- [ ] \n- [ ] 有效任务"))).toEqual([["有效任务", "in_progress"]]);
  });

  it("全部完成时无 in_progress", () => {
    expect(shape(parseTodoMarkdown("- [x] 甲\n- [x] 乙"))).toEqual([
      ["甲", "completed"],
      ["乙", "completed"],
    ]);
  });

  it("已完成项之后第一个未完成项为 in_progress", () => {
    expect(shape(parseTodoMarkdown("- [x] 完成\n- [ ] 未完成1\n- [ ] 未完成2"))).toEqual([
      ["完成", "completed"],
      ["未完成1", "in_progress"],
      ["未完成2", "pending"],
    ]);
  });

  it("内容首尾空白被 trim", () => {
    expect(shape(parseTodoMarkdown("- [ ]  带空格的项  "))).toEqual([["带空格的项", "in_progress"]]);
  });

  it("空字符串或空行返回空数组", () => {
    expect(parseTodoMarkdown("")).toEqual([]);
    expect(parseTodoMarkdown("\n\n")).toEqual([]);
  });

  it("生成的 id 按 1 起连续编号", () => {
    const result = parseTodoMarkdown("- [ ] 甲\n- [ ] 乙");
    expect(result.map(item => item.id)).toEqual(["todo-1", "todo-2"]);
  });
});
