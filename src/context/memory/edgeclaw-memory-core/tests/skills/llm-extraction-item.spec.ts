// llm-extraction-item 行为基线测试（从 extractFileMemoryCandidates 拆出，行为等价）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXTRACTION_SYSTEM_PROMPT_LINES,
  extractFocusSignals,
  filterExtractionCandidate,
  normalizeExtractionItem,
  type ExtractionFocusSignals,
} from "../../src/core/skills/llm-extraction-item.js";
import type { MemoryMessage } from "../../src/core/types.js";

const msg = (role: "user" | "assistant", content: string): MemoryMessage => ({ role, content }) as MemoryMessage;

function baseSignals(overrides: Partial<ExtractionFocusSignals> = {}): ExtractionFocusSignals {
  return {
    focusMessages: [msg("user", "focus")],
    focusText: "focus",
    explicitProjectName: "",
    explicitProjectDescriptor: "",
    explicitProjectStage: "",
    explicitTimeline: [],
    explicitGoal: "",
    explicitBlocker: "",
    genericProjectAnchor: false,
    uniqueBatchProjectName: "",
    selectedKnownProject: undefined,
    contextProjectName: "",
    projectFollowUpSignal: false,
    projectRiskSignal: false,
    projectScopeSignal: false,
    projectDefinitionSignal: false,
    feedbackInstructionSignal: false,
    ...overrides,
  };
}

describe("EXTRACTION_SYSTEM_PROMPT_LINES（在用提示词常量）", () => {
  it("含核心指令（JSON/items/type 枚举）", () => {
    const prompt = EXTRACTION_SYSTEM_PROMPT_LINES.join("\n");
    assert.ok(prompt.includes("Return JSON only with an items array"));
    assert.ok(prompt.includes("Allowed item.type values"));
  });
});

describe("extractFocusSignals", () => {
  it("提取 focus 消息/文本与项目信号", () => {
    const signals = extractFocusSignals({
      messages: [msg("user", "项目名叫 Alpha，目前在设计阶段"), msg("assistant", "好的")],
      batchContextMessages: [msg("user", "项目名叫 Alpha")],
      knownProjects: [],
    });
    assert.equal(signals.focusMessages.length, 1);
    assert.ok(signals.explicitProjectName.length > 0);
    assert.ok(signals.explicitProjectStage.length > 0);
    assert.equal(signals.projectDefinitionSignal, true);
  });
  it("无 focus 消息时 focusText 为空", () => {
    const signals = extractFocusSignals({
      messages: [msg("assistant", "ok")],
      batchContextMessages: [],
      knownProjects: [],
    });
    assert.equal(signals.focusText, "");
  });
});

describe("normalizeExtractionItem", () => {
  it("非法 type 丢弃", () => {
    const result = normalizeExtractionItem({
      item: { type: "bogus" },
      signals: baseSignals(),
      timestamp: "2026-01-01",
    });
    assert.equal(result.candidate, null);
    assert.equal(result.discarded?.reason, "invalid_schema");
  });
  it("feedback 缺 rule 丢弃", () => {
    const result = normalizeExtractionItem({
      item: { type: "feedback", name: "F", description: "D" },
      signals: baseSignals(),
      timestamp: "2026-01-01",
    });
    assert.equal(result.candidate, null);
    assert.ok(result.discarded?.summary?.includes("rule"));
  });
  it("project 候选 description 回退链（explicitGoal → rawStage → …）", () => {
    const result = normalizeExtractionItem({
      item: { type: "project", name: "P", goal: "做检索" },
      signals: baseSignals(),
      timestamp: "2026-01-01",
    });
    assert.equal(result.candidate?.type, "project");
    assert.equal(result.candidate?.description, "做检索");
  });
  it("泛化项目名丢弃（generic_project_name）", () => {
    const result = normalizeExtractionItem({
      item: { type: "project", name: "overview", description: "D" },
      signals: baseSignals(),
      timestamp: "2026-01-01",
    });
    assert.equal(result.candidate, null);
    assert.equal(result.discarded?.reason, "generic_project_name");
  });
  it("稳定 project_id 保留（isStableFormalProjectId 白名单）", () => {
    const result = normalizeExtractionItem({
      item: { type: "project", name: "P", description: "D", project_id: "project_abc" },
      signals: baseSignals(),
      timestamp: "2026-01-01",
    });
    assert.equal(result.candidate?.projectId, "project_abc");
  });
  it("user 候选无持久内容丢弃", () => {
    const result = normalizeExtractionItem({
      item: { type: "user", name: "x" },
      signals: baseSignals(),
      timestamp: "2026-01-01",
    });
    assert.equal(result.candidate, null);
    assert.ok(result.discarded?.summary?.includes("durable profile"));
  });
  it("project scope 信号把 focusText 并入 decisions", () => {
    const result = normalizeExtractionItem({
      item: { type: "project", name: "P", description: "D", decisions: ["d1"] },
      signals: baseSignals({ projectScopeSignal: true, focusText: "本期范围是检索" }),
      timestamp: "2026-01-01",
    });
    assert.ok(result.candidate?.decisions?.includes("本期范围是检索"));
  });
});

describe("filterExtractionCandidate", () => {
  const project = { type: "project", name: "P", description: "D", scope: "project" } as never;
  it("feedback 信号 + 无 project 定义 → project 丢弃", () => {
    const result = filterExtractionCandidate({
      item: project,
      signals: baseSignals({ feedbackInstructionSignal: true, projectDefinitionSignal: false }),
      hasStructuredProjectEvidence: true,
      text: "text",
    });
    assert.equal(result.keep, false);
    assert.equal(result.discarded?.reason, "violates_feedback_project_boundary");
  });
  it("generic anchor 无唯一项目 → 丢弃", () => {
    const result = filterExtractionCandidate({
      item: project,
      signals: baseSignals({ genericProjectAnchor: true, projectDefinitionSignal: false }),
      hasStructuredProjectEvidence: true,
      text: "text",
    });
    assert.equal(result.keep, false);
    assert.equal(result.discarded?.reason, "generic_anchor_without_unique_project");
  });
  it("user 恒保留", () => {
    const result = filterExtractionCandidate({
      item: { type: "user", name: "U", scope: "global" } as never,
      signals: baseSignals(),
      hasStructuredProjectEvidence: false,
      text: "",
    });
    assert.equal(result.keep, true);
  });
  it("project 定义信号 + 无 feedback 信号 → 保留", () => {
    const result = filterExtractionCandidate({
      item: project,
      signals: baseSignals({ projectDefinitionSignal: true }),
      hasStructuredProjectEvidence: true,
      text: "text",
    });
    assert.equal(result.keep, true);
  });
});
