// llm-prompts 行为基线测试（从 llm-extraction.ts G2/G3 拆出，逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSelectIndexProjectPrompt,
  buildSelectRecallProjectPrompt,
  DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS,
  DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
  DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT,
  MEMORY_CLASSIFICATION_SYSTEM_PROMPT,
  USER_PROFILE_REWRITE_SYSTEM_PROMPT,
  buildConversationTurns,
  buildDreamClusterPlanPrompt,
  buildDreamClusterPlanSystemPrompt,
  buildDreamFileGlobalPlanPrompt,
  buildGeneralProjectMetaMergePrompt,
  buildIndexPromptWindow,
  buildRewrittenUserProfileCandidate,
  buildUserProfileRewritePrompt,
  findFocusTurnIndex,
  serializeTurnsForPrompt,
} from "../../src/core/skills/llm-prompts.js";
import type { MemoryMessage, MemoryUserSummary } from "../../src/core/types.js";

const msg = (role: "user" | "assistant", content: string): MemoryMessage => ({ role, content }) as MemoryMessage;

describe("提示词常量（业务语义快照）", () => {
  it("分类提示词含核心指令与 JSON 形状", () => {
    assert.ok(MEMORY_CLASSIFICATION_SYSTEM_PROMPT.includes("JSON"));
    assert.ok(MEMORY_CLASSIFICATION_SYSTEM_PROMPT.includes("should_store"));
  });
  it("Dream 全局规划提示词含审计规划语义", () => {
    assert.ok(DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT.includes("global audit planner"));
    assert.ok(DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT.includes("reorganization plan"));
  });
  it("画像重写提示词存在", () => {
    assert.ok(USER_PROFILE_REWRITE_SYSTEM_PROMPT.length > 100);
  });
  it("超时常量值", () => {
    assert.equal(DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS, 600_000);
    assert.equal(DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS, 75_000);
  });
});

describe("buildDreamClusterPlanSystemPrompt kind 参数化", () => {
  it("project/feedback 双模式含对应类别描述", () => {
    const project = buildDreamClusterPlanSystemPrompt("project");
    const feedback = buildDreamClusterPlanSystemPrompt("feedback");
    assert.ok(project.includes("Project memory files"));
    assert.ok(feedback.includes("Feedback memory files"));
  });
});

describe("buildConversationTurns / findFocusTurnIndex", () => {
  const messages = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
  it("按 user 切分为 turn 组", () => {
    const turns = buildConversationTurns(messages);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0], [msg("user", "a"), msg("assistant", "b")]);
    assert.deepEqual(turns[1], [msg("user", "c")]);
  });
  it("findFocusTurnIndex 定位包含 focus 消息的 turn", () => {
    const turns = buildConversationTurns(messages);
    assert.equal(findFocusTurnIndex(turns, msg("user", "c")), 1);
    assert.equal(findFocusTurnIndex(turns, msg("user", "not-there")), -1);
  });
});

describe("serializeTurnsForPrompt", () => {
  it("返回 {turn_index, messages[]} 数组，content 截断 320", () => {
    const turns = buildConversationTurns([msg("user", "你好"), msg("assistant", "你好，有什么可以帮你？")]);
    const serialized = serializeTurnsForPrompt(turns);
    assert.equal(serialized.length, 1);
    assert.equal(serialized[0]?.turn_index, 1);
    assert.equal(serialized[0]?.messages[0]?.content, "你好");
  });
});

describe("buildIndexPromptWindow", () => {
  it("构造分类上下文窗口（前后各 2 turn + meta，JSON 字符串）", () => {
    const window = buildIndexPromptWindow({
      batchContextMessages: [msg("user", "a"), msg("assistant", "b"), msg("user", "focus"), msg("assistant", "c")],
      focusUserTurn: msg("user", "focus"),
      currentProjectMeta: {
        projectId: "p1",
        projectName: "P",
        description: "D",
        status: "active",
        updatedAt: "2026-01-01",
        createdAt: "2026-01-01",
        relativePath: "p1",
        absolutePath: "/projects/p1",
      },
    });
    assert.ok(window.includes("current_project_meta"));
    assert.ok(window.includes("focus"));
  });
  it("无 meta 时 current_project_meta 为 null", () => {
    const window = buildIndexPromptWindow({
      batchContextMessages: [msg("user", "a")],
      focusUserTurn: msg("user", "a"),
      currentProjectMeta: null,
    });
    assert.ok(window.includes('"current_project_meta": null') || window.includes('"current_project_meta":null'));
  });
});

describe("buildDreamFileGlobalPlanPrompt", () => {
  it("governance_scope 大对象 + projects 映射", () => {
    const prompt = buildDreamFileGlobalPlanPrompt({
      currentProjects: [
        { projectId: "p1", projectName: "P", description: "D", status: "active", updatedAt: "2026-01-01" },
      ],
      records: [],
      agentId: "agent-1",
    } as never);
    assert.ok(prompt.includes("governance_scope"));
    assert.ok(prompt.includes("project_id"));
  });
});

describe("buildUserProfileRewritePrompt", () => {
  const existingProfile: MemoryUserSummary = {
    scope: "global",
    relativePath: "global/UserIdentity/user-profile.md",
    files: [{ relativePath: "p.md", content: "x".repeat(5000), type: "user" }],
  } as never;
  it("existing profile 截断 3200 + candidates 参与", () => {
    const prompt = buildUserProfileRewritePrompt({
      existingProfile,
      candidates: [{ type: "user", scope: "global", name: "U", description: "D" }],
    } as never);
    assert.ok(prompt.length < 5000, "existing profile 超出截断预算");
    assert.ok(prompt.includes("existing_profile_markdown"));
  });
  it("无 existing profile 时字段为 null", () => {
    const prompt = buildUserProfileRewritePrompt({ existingProfile: null, candidates: [] } as never);
    assert.ok(prompt.includes("null"));
  });
});

describe("buildRewrittenUserProfileCandidate", () => {
  it("section markdown → MemoryCandidate（facts 提取）", () => {
    const candidate = buildRewrittenUserProfileCandidate({
      sectionMarkdown: "- 事实一\n- 事实二",
      latestCandidate: {
        type: "user",
        scope: "global",
        name: "U",
        description: "D",
        capturedAt: "2026-01-01T00:00:00Z",
      },
    });
    assert.equal(candidate?.type, "user");
    assert.equal(candidate?.scope, "global");
  });
  it("空 section 返回 null", () => {
    assert.equal(buildRewrittenUserProfileCandidate({ sectionMarkdown: null }), null);
  });
});

describe("buildGeneralProjectMetaMergePrompt", () => {
  it("JSON 结构含 governance_scope 与 project_metas", () => {
    const prompt = buildGeneralProjectMetaMergePrompt({
      projectMetas: [
        { projectId: "p1", projectName: "P", description: "D", status: "active", updatedAt: "2026-01-01" },
      ],
    } as never);
    assert.ok(prompt.includes("general_project_meta_merge_plan"));
    assert.ok(prompt.includes('"project_id": "p1"'));
  });
});

describe("buildDreamClusterPlanPrompt", () => {
  it("聚类规划 prompt 含 headers", () => {
    const prompt = buildDreamClusterPlanPrompt({
      kind: "project",
      headers: [{ relativePath: "a.md", name: "A", description: "D", updatedAt: "2026-01-01" }],
    } as never);
    assert.ok(prompt.includes("a.md"));
  });
});

describe("buildSelectRecallProjectPrompt", () => {
  const input = {
    query: "q",
    recentUserMessages: [msg("user", "recent")],
    shortlist: [
      {
        projectId: "p1",
        projectName: "Alpha",
        description: "D",
        status: "active",
        updatedAt: "2026-01-01",
        score: 1,
        exact: 0,
        source: "recent",
        matchedText: "",
      },
    ],
    allowEmpty: true,
  } satisfies Parameters<typeof buildSelectRecallProjectPrompt>[0];
  it("allowEmpty 模式含空选择指令", () => {
    const { systemPrompt } = buildSelectRecallProjectPrompt(input);
    assert.ok(systemPrompt.includes("empty selected_project_id"));
  });
  it("userPrompt 含 query 与 shortlist 映射", () => {
    const { userPrompt } = buildSelectRecallProjectPrompt(input);
    assert.ok(userPrompt.includes('"query": "q"'));
    assert.ok(userPrompt.includes("shortlist_score"));
  });
});

describe("buildSelectIndexProjectPrompt", () => {
  const input = {
    candidate: { type: "project", scope: "project", name: "P", description: "D" },
    candidatePreview: "preview",
    focusTurn: msg("user", "focus"),
    recentUserMessages: [],
    shortlist: [
      {
        projectId: "p1",
        projectName: "Alpha",
        description: "D",
        status: "active",
        updatedAt: "2026-01-01",
        score: 1,
        exact: 0,
        source: "recent",
        matchedText: "",
      },
    ],
  } satisfies Parameters<typeof buildSelectIndexProjectPrompt>[0];
  it("systemPrompt 含 attach_existing/create_new 语义", () => {
    const { systemPrompt } = buildSelectIndexProjectPrompt(input);
    assert.ok(systemPrompt.includes("attach_existing"));
    assert.ok(systemPrompt.includes("create_new"));
  });
  it("userPrompt 含 candidate_memory_preview", () => {
    const { userPrompt } = buildSelectIndexProjectPrompt(input as never);
    assert.ok(userPrompt.includes("candidate_memory_preview"));
  });
});
