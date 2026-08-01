import assert from "node:assert/strict";
import test from "node:test";
import {
  createValidateSpecificationTool,
  validateSpecification,
} from "../../../src/tool/builtin/validateSpecification.js";

const GOOD_SPEC = [
  "# 技术领域",
  "本发明涉及机械技术领域。",
  "",
  "# 背景技术",
  "现有技术存在效率低下的问题。",
  "",
  "# 发明内容",
  "本发明提供一种装置，包括壳体、驱动单元。",
  "",
  "# 附图说明",
  "图1为本发明实施例的整体结构示意图。",
  "",
  "# 具体实施方式",
  "实施例1：如图1所示，驱动单元采用伺服电机。",
].join("\n");

test("validate_specification passes a complete specification", () => {
  const result = validateSpecification({
    text: GOOD_SPEC,
    title: "一种自动化分拣装置",
    abstract: "本发明公开了一种自动化分拣装置。",
  });
  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
  assert.equal(result.violations.length, 0);
});

test("validate_specification flags missing sections and long title", () => {
  const result = validateSpecification({
    text: "# 技术领域\n本发明涉及机械技术领域。",
    title: "一种用于自动化分拣系统的高效多级分类输送装置及其控制方法",
  });
  assert.equal(result.passed, false);
  const sectionViolation = result.violations.find(v => v.rule === "sections");
  assert.ok(sectionViolation, "should flag missing sections");
  assert.match(sectionViolation?.message ?? "", /缺少必要章节：背景技术、发明内容、附图说明、具体实施方式/);
  const titleViolation = result.violations.find(v => v.rule === "title_length");
  assert.ok(titleViolation, "should flag title length");
});

test("validate_specification flags vague terms and drawing inconsistencies", () => {
  const result = validateSpecification({
    text: GOOD_SPEC.replace("驱动单元采用伺服电机", "驱动单元优选采用伺服电机"),
  });
  const clarity = result.violations.find(v => v.rule === "clarity");
  assert.ok(clarity, "should flag vague terms");
  assert.ok(clarity?.message.includes("优选"));

  // 正文无图引用但有附图说明章节
  const noBodyRef = validateSpecification({
    text: GOOD_SPEC.replace("实施例1：如图1所示，驱动单元采用伺服电机。", "实施例1：驱动单元采用伺服电机。"),
  });
  assert.ok(
    noBodyRef.violations.some(v => v.rule === "drawings"),
    "should warn when body never references figures",
  );
});

test("validate_specification flags abstract over 300 chars", () => {
  const result = validateSpecification({
    text: GOOD_SPEC,
    abstract: "长摘要".repeat(110),
  });
  assert.ok(result.violations.some(v => v.rule === "abstract_length"));
});

test("validate_specification tool definition is read-only", async () => {
  const tool = createValidateSpecificationTool();
  assert.equal(tool.name, "validate_specification");
  assert.equal(tool.isReadOnly({ text: "" }), true);
  const result = await tool.execute({ text: GOOD_SPEC }, {} as never);
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  assert.equal((first.value as { passed: boolean }).passed, true);
});
