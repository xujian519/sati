// llm-hints 行为基线测试（从 llm-extraction.ts G7 拆出，逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSyntheticProjectFollowUpCandidate,
  extractProjectNameHint,
  extractProjectStageHint,
  isGenericProjectCandidateName,
  isStableFormalProjectId,
  looksLikeProjectScopeText,
  sanitizeFeedbackSectionText,
  selectKnownProjectHint,
  splitProfileFacts,
  stripMarkdownSyntax,
} from "../../src/core/skills/llm-hints.js";

describe("isStableFormalProjectId / isGenericProjectCandidateName", () => {
  it("project_xxx 判定", () => {
    assert.equal(isStableFormalProjectId("project_abc123"), true);
    assert.equal(isStableFormalProjectId("Project_ABC"), false);
  });
  it("泛化名判定（精确词 overview/project/project-item/memory-item）", () => {
    assert.equal(isGenericProjectCandidateName("overview"), true);
    assert.equal(isGenericProjectCandidateName("project"), true);
    assert.equal(isGenericProjectCandidateName("project overview"), false); // 非精确词
    assert.equal(isGenericProjectCandidateName("专利检索系统"), false);
  });
});

describe("extractProjectStageHint 首中即返", () => {
  it("识别阶段：返回整个匹配片段（非单关键词）", () => {
    assert.equal(extractProjectStageHint("目前处于调研阶段"), "目前处于调研阶段");
    assert.equal(extractProjectStageHint("项目在开发阶段"), "开发阶段");
  });
  it("无命中返回空", () => {
    assert.equal(extractProjectStageHint("今天天气不错"), "");
  });
});

describe("extractProjectNameHint", () => {
  it("识别项目名模式（触发词：项目名叫/叫它/叫做）", () => {
    assert.equal(extractProjectNameHint("项目名叫专利检索系统"), "专利检索系统");
    assert.equal(extractProjectNameHint("先叫它 Alpha"), "Alpha");
  });
});

describe("looksLikeProjectScopeText", () => {
  it("识别范围信号（一期范围/替换旧记忆/memory_* 工具名等特定词）", () => {
    assert.equal(looksLikeProjectScopeText("本期范围是检索"), true);
    assert.equal(looksLikeProjectScopeText("替换旧记忆"), true);
    assert.equal(looksLikeProjectScopeText("新增 memory tab"), true);
    assert.equal(looksLikeProjectScopeText("普通聊天"), false);
  });
});

describe("sanitizeFeedbackSectionText", () => {
  it("过滤英文样板句（9 条固定黑名单之一）", () => {
    assert.equal(sanitizeFeedbackSectionText("explicit project collaboration preference captured from the user"), "");
  });
  it("保留真实内容", () => {
    assert.equal(sanitizeFeedbackSectionText("交付时先给结论再展开。"), "交付时先给结论再展开。");
  });
});

describe("selectKnownProjectHint", () => {
  const known = [
    { projectId: "p1", projectName: "Alpha 项目", description: "检索", updatedAt: "2026-01-01" },
    { projectId: "p2", projectName: "Beta", description: "其他", updatedAt: "2026-01-02" },
  ] as never;
  it("唯一精确匹配命中", () => {
    const hit = selectKnownProjectHint("关于 Alpha 项目的事情", known);
    assert.equal((hit as { projectId: string }).projectId, "p1");
  });
});

describe("splitProfileFacts / stripMarkdownSyntax", () => {
  it("按标点/换行切分 + 长度过滤", () => {
    assert.deepEqual(splitProfileFacts("事实一。事实二，补充"), ["事实一", "事实二", "补充"]);
  });
  it("剥离 markdown 标记", () => {
    assert.equal(stripMarkdownSyntax("## 标题\n- 列表项 **粗体**"), "标题 列表项 粗体");
  });
});

describe("buildSyntheticProjectFollowUpCandidate", () => {
  it("无 LLM 结果时合成 project 候选", () => {
    const candidate = buildSyntheticProjectFollowUpCandidate({
      focusText: "我们继续推进专利检索系统，下一步做布尔查询",
      timestamp: "2026-01-01T00:00:00Z",
      uniqueBatchProjectName: "专利检索系统",
      explicitProjectName: "",
      explicitProjectDescriptor: "",
      explicitProjectStage: "",
      explicitTimeline: [],
      explicitGoal: "",
      explicitBlocker: "",
    });
    assert.equal(candidate?.type, "project");
    assert.equal(candidate?.name, "专利检索系统");
    assert.equal(candidate?.capturedAt, "2026-01-01T00:00:00Z");
  });
  it("泛化项目名返回 null", () => {
    const candidate = buildSyntheticProjectFollowUpCandidate({
      focusText: "继续推进",
      timestamp: "2026-01-01T00:00:00Z",
      uniqueBatchProjectName: "overview",
      explicitProjectName: "",
      explicitProjectDescriptor: "",
      explicitProjectStage: "",
      explicitTimeline: [],
      explicitGoal: "",
      explicitBlocker: "",
    });
    assert.equal(candidate, null);
  });
});
