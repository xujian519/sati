// LlmMemoryExtractor Dream 步骤容错测试：LLM 空响应（Empty extraction response）
// 时降级为「跳过该步骤」的安全结果，而非让整次 Dream 维护失败。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmMemoryExtractor } from "../../src/core/index.js";
import type {
  LlmDreamClusterPlanInput,
  LlmDreamClusterRefineInput,
  LlmDreamProjectMetaReviewInput,
} from "../../src/core/skills/llm-extraction.js";

const CONFIG = {
  agents: {
    defaults: {
      model: { primary: "sati/deepseek-v4-flash" },
    },
  },
  models: {
    providers: {
      sati: {
        baseUrl: "https://fake.example",
        apiKey: "test-key",
        models: [{ id: "deepseek-v4-flash" }],
      },
    },
  },
};

/** mock LLM 返回空 content（等价真实场景：模型空响应，重试后仍空）。 */
function stubEmptyLlmResponse(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const planInput: LlmDreamClusterPlanInput = {
  kind: "project",
  headers: [
    { relativePath: "a.md", name: "A", description: "desc-a", updatedAt: "2026-01-01" },
    { relativePath: "b.md", name: "B", description: "desc-b", updatedAt: "2026-01-02" },
  ],
};

const refineInput: LlmDreamClusterRefineInput = {
  kind: "project",
  records: [
    {
      entryId: "e1",
      relativePath: "a.md",
      type: "project",
      scope: "project",
      isTmp: false,
      name: "A",
      description: "desc-a",
      updatedAt: "2026-01-01",
      content: "content",
    },
  ],
};

const reviewInput: LlmDreamProjectMetaReviewInput = {
  currentMeta: {
    projectId: "p1",
    projectName: "P1",
    description: "D1",
    status: "active",
    updatedAt: "2026-01-01",
  },
  recentProjectRecords: [],
  recentFeedbackRecords: [],
};

describe("LlmMemoryExtractor Dream 空响应降级", () => {
  it("planDreamClusters 空响应 → 跳过规划（clusters 空，不抛）", async () => {
    const restore = stubEmptyLlmResponse();
    const extractor = new LlmMemoryExtractor(CONFIG, undefined);
    try {
      const result = await extractor.planDreamClusters(planInput);
      assert.deepEqual(result.clusters, [], "空响应应降级为空簇列表");
      assert.ok(result.summary.includes("skipped"), "summary 应标注降级跳过");
    } finally {
      restore();
    }
  });

  it("refineDreamCluster 空响应 → 跳过精炼（file null，不抛）", async () => {
    const restore = stubEmptyLlmResponse();
    const extractor = new LlmMemoryExtractor(CONFIG, undefined);
    try {
      const result = await extractor.refineDreamCluster(refineInput);
      assert.equal(result.file, null, "空响应应降级为不产出文件");
      assert.ok(result.summary.includes("skipped"), "summary 应标注降级跳过");
    } finally {
      restore();
    }
  });

  it("reviewDreamProjectMeta 空响应 → 保持原 meta（shouldUpdate false，不抛）", async () => {
    const restore = stubEmptyLlmResponse();
    const extractor = new LlmMemoryExtractor(CONFIG, undefined);
    try {
      const result = await extractor.reviewDreamProjectMeta(reviewInput);
      assert.equal(result.shouldUpdate, false, "空响应不应触发 meta 更新");
      assert.deepEqual(result.projectMeta, {
        projectName: "P1",
        description: "D1",
        status: "active",
      });
    } finally {
      restore();
    }
  });

  it("非解析类错误（网络）不被吞掉，仍向上抛", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("boom");
    };
    const extractor = new LlmMemoryExtractor(CONFIG, undefined);
    try {
      await assert.rejects(() => extractor.planDreamClusters(planInput), /boom/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
