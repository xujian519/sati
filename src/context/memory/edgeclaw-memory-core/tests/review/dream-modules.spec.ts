// dream-review 子模块行为基线测试（G2-G6 从 dream-review.ts 拆出，函数体逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDreamUserNotePath, isDreamUserProfilePath } from "../../src/core/review/dream-paths.js";
import { previewMarkdown, sortEntries, truncate } from "../../src/core/review/dream-detail.js";
import { createDreamTrace, mutation, pushStep } from "../../src/core/review/dream-trace.js";
import { toDreamMetaInput, toHeaderInput, toRefinedCandidate } from "../../src/core/review/dream-mappers.js";
import {
  selectUserNoteWindow,
  validateExclusiveClusters,
  validateGeneralProjectMergeGroups,
} from "../../src/core/review/dream-validators.js";

describe("dream-paths 用户路径保护", () => {
  it("识别内部/暴露两种 user-profile 路径", () => {
    assert.equal(isDreamUserProfilePath("UserIdentity/user-profile.md"), true);
    assert.equal(isDreamUserProfilePath("global/UserIdentity/user-profile.md"), true);
  });
  it("普通项目路径不是用户画像", () => {
    assert.equal(isDreamUserProfilePath("projects/p1/memory.md"), false);
  });
  it("识别 UserIdentityNotes 前缀（含 global 暴露形态）", () => {
    assert.equal(isDreamUserNotePath("UserIdentityNotes/a.md"), true);
    assert.equal(isDreamUserNotePath("global/UserIdentityNotes/a.md"), true);
  });
  it("反斜杠路径归一化后仍被保护", () => {
    assert.equal(isDreamUserProfilePath("UserIdentity\\user-profile.md"), true);
  });
});

describe("dream-detail 文本工具", () => {
  it("truncate 截断并追加省略号（trim 语义，省略号为 ... 与 utils 默认一致）", () => {
    assert.equal(truncate("  hello world  ", 5), "hel...");
  });
  it("previewMarkdown 去标题+折叠空白", () => {
    assert.equal(previewMarkdown("## 标题\n内容  行", 200), "标题 内容 行");
  });
  it("sortEntries updatedAt 降序 + 路径升序 tiebreak", () => {
    const entries = [
      { relativePath: "b.md", updatedAt: "2026-01-02" },
      { relativePath: "a.md", updatedAt: "2026-01-02" },
      { relativePath: "c.md", updatedAt: "2026-01-03" },
    ] as never;
    const sorted = sortEntries(entries);
    assert.deepEqual(
      sorted.map(e => (e as { relativePath: string }).relativePath),
      ["c.md", "a.md", "b.md"],
    );
  });
});

describe("dream-trace 基建", () => {
  it("createDreamTrace 骨架（running/空 steps/零值 outcome）", () => {
    const trace = createDreamTrace("manual");
    assert.equal(trace.status, "running");
    assert.equal(trace.steps.length, 0);
    assert.equal(trace.mutations.length, 0);
    assert.equal(trace.outcome.rewrittenProjects, 0);
  });
  it("pushStep 追加并递增 stepId", () => {
    const trace = createDreamTrace("manual");
    pushStep(trace, "project_header_scan", "Review", "success", "in", "out");
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0]?.stepId, `${trace.dreamTraceId}:step:1`);
    pushStep(trace, "project_cluster_plan", "Finish", "success", "in", "out");
    assert.equal(trace.steps[1]?.stepId, `${trace.dreamTraceId}:step:2`);
  });
  it("mutation 构造审计条目", () => {
    const m = mutation("delete", "projects/p1/memory.md", { name: "n" });
    assert.equal(m.action, "delete");
    assert.equal(m.relativePath, "projects/p1/memory.md");
    assert.equal(m.name, "n");
  });
});

describe("dream-mappers 数据映射", () => {
  it("toDreamMetaInput 透传字段 + 可选字段条件展开", () => {
    const meta = {
      projectId: "p1",
      projectName: "Alpha",
      description: "desc",
      status: "in_progress",
      updatedAt: "2026-01-01",
      sourceKind: "general_local",
    } as never;
    const input = toDreamMetaInput(meta);
    assert.equal(input.projectId, "p1");
    assert.equal(input.sourceKind, "general_local");
    assert.equal("dreamUpdatedAt" in input, false);
  });
  it("toHeaderInput 四字段映射", () => {
    const input = toHeaderInput({
      relativePath: "p.md",
      name: "N",
      description: "D",
      updatedAt: "2026-01-01",
    } as never);
    assert.deepEqual(input, { relativePath: "p.md", name: "N", description: "D", updatedAt: "2026-01-01" });
  });
  it("toRefinedCandidate 生成 project 候选（body 补换行）", () => {
    const candidate = toRefinedCandidate({
      kind: "project",
      name: "N",
      description: "D",
      markdown: "body",
      sourceRecord: { capturedAt: "2026-01-01" } as never,
    });
    assert.equal(candidate.type, "project");
    assert.equal(candidate.body, "body\n");
    assert.equal(candidate.capturedAt, "2026-01-01");
  });
});

describe("validateExclusiveClusters 丢弃规则", () => {
  const allowed = new Set(["a.md", "b.md", "c.md", "d.md"]);
  it("少于 2 个合法文件被丢弃", () => {
    const result = validateExclusiveClusters([{ memberRelativePaths: ["a.md"], reason: "x" }], allowed, 8);
    assert.equal(result.clusters.length, 0);
    assert.ok(result.droppedWarnings[0]?.includes("fewer than 2"));
  });
  it("超过 maxFiles 被丢弃", () => {
    const result = validateExclusiveClusters(
      [{ memberRelativePaths: ["a.md", "b.md", "c.md", "d.md"], reason: "x" }],
      allowed,
      2,
    );
    assert.equal(result.clusters.length, 0);
    assert.ok(result.droppedWarnings[0]?.includes("exceeded"));
  });
  it("跨簇重叠成员被丢弃", () => {
    const result = validateExclusiveClusters(
      [
        { memberRelativePaths: ["a.md", "b.md"], reason: "overlap" },
        { memberRelativePaths: ["b.md", "c.md"], reason: "duplicate" },
      ],
      allowed,
      8,
    );
    assert.equal(result.clusters.length, 1);
    assert.ok(result.droppedWarnings.some(w => w.includes("overlapping")));
  });
  it("仅同项目理由（无具体语义）被丢弃（中文）", () => {
    const result = validateExclusiveClusters(
      [{ memberRelativePaths: ["a.md", "b.md"], reason: "都属于同一个项目" }],
      allowed,
      8,
    );
    assert.equal(result.clusters.length, 0);
    assert.ok(result.droppedWarnings[0]?.includes("low-quality"));
  });
  it("同项目+语义理由（重复/重叠）被接受", () => {
    const result = validateExclusiveClusters(
      [{ memberRelativePaths: ["a.md", "b.md"], reason: "同一项目且内容重复" }],
      allowed,
      8,
    );
    assert.equal(result.clusters.length, 1);
  });
  it("合法聚类保留（去重 + 白名单过滤）", () => {
    const result = validateExclusiveClusters(
      [{ memberRelativePaths: ["a.md", "a.md", "unknown.md", "b.md"], reason: "overlap" }],
      allowed,
      8,
    );
    assert.deepEqual(result.clusters[0]?.memberRelativePaths, ["a.md", "b.md"]);
  });
});

describe("selectUserNoteWindow 预算", () => {
  const note = (path: string, content: string, updatedAt: string) =>
    ({ relativePath: path, content, updatedAt }) as never;
  it("按预算选择 + 超预算单条跳过不饿死窗口", () => {
    const records = [
      note("big.md", "x".repeat(121_000), "2026-01-03"),
      note("a.md", "abc", "2026-01-02"),
      note("b.md", "def", "2026-01-01"),
    ];
    const result = selectUserNoteWindow(records);
    assert.deepEqual(
      result.selectedRecords.map(r => (r as { relativePath: string }).relativePath),
      ["a.md", "b.md"],
    );
    assert.ok(result.keptRecords.some(r => (r as { relativePath: string }).relativePath === "big.md"));
  });
});

describe("validateGeneralProjectMergeGroups keeper 规则", () => {
  const metas = [
    { projectId: "p1", projectName: "A", description: "", status: "active", updatedAt: "2026-01-01" },
    { projectId: "p2", projectName: "B", description: "", status: "active", updatedAt: "2026-01-01" },
    { projectId: "p3", projectName: "C", description: "", status: "active", updatedAt: "2026-01-01" },
  ] as never;
  it("未知 keeper 整组丢弃", () => {
    const result = validateGeneralProjectMergeGroups({
      metas,
      groups: [{ keeperProjectId: "unknown", duplicateProjectIds: ["p2"], reason: "r" }],
    });
    assert.equal(result.acceptedGroups.length, 0);
    assert.ok(result.droppedWarnings[0]?.includes("unknown keeper"));
  });
  it("keeper 同时也是 duplicate 被丢弃", () => {
    const result = validateGeneralProjectMergeGroups({
      metas,
      groups: [{ keeperProjectId: "p1", duplicateProjectIds: ["p1", "p2"], reason: "r" }],
    });
    assert.equal(result.acceptedGroups.length, 0);
  });
  it("无 duplicate 被丢弃", () => {
    const result = validateGeneralProjectMergeGroups({
      metas,
      groups: [{ keeperProjectId: "p1", duplicateProjectIds: [], reason: "r" }],
    });
    assert.equal(result.acceptedGroups.length, 0);
  });
  it("项目 id 跨组重用被丢弃", () => {
    const result = validateGeneralProjectMergeGroups({
      metas,
      groups: [
        { keeperProjectId: "p1", duplicateProjectIds: ["p2"], reason: "r" },
        { keeperProjectId: "p2", duplicateProjectIds: ["p3"], reason: "r" },
      ],
    });
    assert.equal(result.acceptedGroups.length, 1);
    assert.ok(result.droppedWarnings.some(w => w.includes("already used")));
  });
  it("合法组合通过（keeper 存在/duplicate 非空且不含 keeper/不重用）", () => {
    const result = validateGeneralProjectMergeGroups({
      metas,
      groups: [{ keeperProjectId: "p1", duplicateProjectIds: ["p2"], reason: "r" }],
    });
    assert.equal(result.acceptedGroups.length, 1);
    assert.equal(result.acceptedGroups[0]?.keeperProjectId, "p1");
  });
});
