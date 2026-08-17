// llm-normalizers 行为基线测试（从 llm-extraction.ts G6 拆出，逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseBestRecallProjectFallback,
  clampConfidence,
  normalizeBoolean,
  normalizeDreamCluster,
  normalizeDreamFileEntryIds,
  normalizeDreamFileGlobalPlanProject,
  normalizeDreamFileMergeReason,
  normalizeDreamFileProjectId,
  normalizeDreamFileProjectRewriteFile,
  normalizeDreamFileProjectStatus,
  normalizeGeneralProjectMetaMergeGroup,
  normalizeMemoryRoute,
  normalizeStringArray,
} from "../../src/core/skills/llm-normalizers.js";

describe("clampConfidence", () => {
  it("钳制 0-1 + NaN 兜底", () => {
    assert.equal(clampConfidence(1.5, 0), 1);
    assert.equal(clampConfidence(-1, 0), 0);
    assert.equal(clampConfidence(Number.NaN, 0.5), 0.5);
  });
});

describe("normalizeDreamFileProjectId / EntryIds 白名单", () => {
  const allowed = new Set(["p1", "p2"]);
  it("白名单命中返回、未命中 undefined", () => {
    assert.equal(normalizeDreamFileProjectId(" p1 ", allowed), "p1");
    assert.equal(normalizeDreamFileProjectId("p9", allowed), undefined);
  });
  it("entry ids 白名单过滤 + 去重 + 上限", () => {
    assert.deepEqual(normalizeDreamFileEntryIds(["a", "a", "b", "z"], new Set(["a", "b"]), 10), ["a", "b"]);
    assert.deepEqual(normalizeDreamFileEntryIds(["a", "b"], new Set(["a", "b"]), 1), ["a"]);
  });
});

describe("normalizeDreamFileProjectStatus / MergeReason", () => {
  it("status 默认 active 且截断 80", () => {
    assert.equal(normalizeDreamFileProjectStatus(undefined), "active");
    assert.equal(normalizeDreamFileProjectStatus("done"), "done");
  });
  it("merge_reason 三枚举（大小写不敏感）", () => {
    assert.equal(normalizeDreamFileMergeReason("RENAME"), "rename");
    assert.equal(normalizeDreamFileMergeReason("alias_equivalence"), "alias_equivalence");
    assert.equal(normalizeDreamFileMergeReason("other"), undefined);
  });
});

describe("normalizeDreamFileGlobalPlanProject", () => {
  const allowedEntries = new Set(["a.md", "b.md"]);
  const allowedProjects = new Set(["p1"]);
  it("retained 为空返回 null", () => {
    assert.equal(
      normalizeDreamFileGlobalPlanProject({ retained_entry_ids: [] }, allowedEntries, allowedProjects, 0),
      null,
    );
  });
  it("planKey 兜底 dream-plan-N + projectName/description 必需", () => {
    const result = normalizeDreamFileGlobalPlanProject(
      { retained_entry_ids: ["a.md"], project_name: "P", description: "D" },
      allowedEntries,
      allowedProjects,
      2,
    );
    assert.equal(result?.planKey, "dream-plan-3");
    assert.equal(result?.projectName, "P");
    assert.equal(result?.status, "active");
  });
  it("缺 project_name 或 description 返回 null", () => {
    assert.equal(
      normalizeDreamFileGlobalPlanProject(
        { retained_entry_ids: ["a.md"], project_name: "P" },
        allowedEntries,
        allowedProjects,
        0,
      ),
      null,
    );
  });
});

describe("normalizeDreamFileProjectRewriteFile", () => {
  const allowed = new Set(["a.md"]);
  it("project 分支：必填 name/description + 数组上限 20", () => {
    const result = normalizeDreamFileProjectRewriteFile(
      { type: "project", name: "N", description: "D", source_entry_ids: ["a.md"], decisions: ["d1"] },
      allowed,
    );
    assert.equal(result?.type, "project");
    assert.deepEqual(result?.decisions, ["d1"]);
  });
  it("feedback 分支：rule 必需，无 rule 返回 null", () => {
    assert.equal(
      normalizeDreamFileProjectRewriteFile(
        { type: "feedback", name: "N", description: "D", source_entry_ids: ["a.md"] },
        allowed,
      ),
      null,
    );
  });
  it("非法 type 或空 source_entry_ids 返回 null", () => {
    assert.equal(
      normalizeDreamFileProjectRewriteFile(
        { type: "bogus", name: "N", description: "D", source_entry_ids: ["a.md"] },
        allowed,
      ),
      null,
    );
  });
});

describe("normalizeDreamCluster / normalizeGeneralProjectMetaMergeGroup", () => {
  it("cluster 白名单 32 + reason 截断", () => {
    const result = normalizeDreamCluster({ member_relative_paths: ["a.md"], reason: "overlap" }, new Set(["a.md"]));
    assert.equal(result?.reason, "overlap");
  });
  it("merge group：keeper/duplicates 必需，去重", () => {
    const result = normalizeGeneralProjectMetaMergeGroup({
      keeper_project_id: "p1",
      duplicate_project_ids: ["p2", "p2"],
      reason: "r",
    });
    assert.deepEqual(result?.duplicateProjectIds, ["p2"]);
  });
});

describe("chooseBestRecallProjectFallback 四级排序", () => {
  const shortlist = [
    { projectId: "a", projectName: "A", exact: 0, score: 1, sourceType: "general_local", updatedAt: "2026-01-01" },
    { projectId: "b", projectName: "B", exact: 1, score: 0, sourceType: "workspace_external", updatedAt: "2026-01-02" },
    { projectId: "c", projectName: "C", exact: 1, score: 5, sourceType: "general_local", updatedAt: "2026-01-03" },
  ] as never;
  it("exact → score → sourcePriority → updatedAt 优先级", () => {
    const best = chooseBestRecallProjectFallback(shortlist);
    assert.equal((best as { projectId: string }).projectId, "c");
  });
});

describe("normalizeMemoryRoute / normalizeBoolean / normalizeStringArray", () => {
  it("route 四值 + 非法回退 none", () => {
    assert.equal(normalizeMemoryRoute("user"), "user");
    assert.equal(normalizeMemoryRoute("bogus"), "none");
  });
  it("boolean 字符串归一", () => {
    assert.equal(normalizeBoolean("TRUE"), true);
    assert.equal(normalizeBoolean("no", true), true);
  });
  it("string 单值或数组截断", () => {
    assert.deepEqual(normalizeStringArray("single", 5), ["single"]);
    assert.deepEqual(normalizeStringArray(["a", " b ", ""], 1), ["a"]);
  });
});
