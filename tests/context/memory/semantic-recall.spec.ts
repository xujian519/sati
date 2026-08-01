import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LlmMemoryExtractor, MemoryRepository } from "edgeclaw-memory-core";
import { ReasoningRetriever } from "edgeclaw-memory-core";
import type { EmbeddingClient } from "../../../src/model/embedding/types.js";
import { MemorySemanticIndex, type MemorySemanticIndexOptions } from "../../../src/context/memory/semantic-index.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-semantic-"));
}

/** 确定性 stub embedding client（共享字符越多越接近）。 */
function makeStubEmbeddingClient(dims = 8): { client: EmbeddingClient; embedCalls: string[][] } {
  const embedCalls: string[][] = [];
  const client: EmbeddingClient = {
    dimensions: dims,
    async embed(texts: string[]): Promise<number[][]> {
      embedCalls.push([...texts]);
      return texts.map(text => {
        const vector = new Array<number>(dims).fill(0);
        for (let i = 0; i < text.length; i += 1) {
          vector[i % dims] = (vector[i % dims]! + (text.charCodeAt(i) % 10) + 0.01) % 5;
        }
        return vector;
      });
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
  return { client, embedCalls };
}

type ManifestEntry = {
  name: string;
  description: string;
  type: "project";
  scope: "project";
  updatedAt: string;
  file: string;
  relativePath: string;
  absolutePath: string;
};

function makeEntry(relativePath: string, updatedAt: string): ManifestEntry {
  return {
    name: relativePath.split("/").pop() ?? relativePath,
    description: `desc ${relativePath}`,
    type: "project",
    scope: "project",
    updatedAt,
    file: relativePath,
    relativePath,
    absolutePath: `/mem/${relativePath}`,
  };
}

describe("ReasoningRetriever 语义融合", () => {
  it("语义独有命中被 RRF 融合进 LLM 候选清单", async () => {
    const manifest = [makeEntry("recent-a.md", "2026-08-01"), makeEntry("recent-b.md", "2026-07-01")];

    let capturedManifest: unknown;
    const repository = {
      getSnapshotVersion: () => "snap-1",
      getWorkspaceMode: () => "project",
      getFileMemoryStore: () => ({ getProjectMeta: () => null }),
      listMemoryEntries: () => manifest,
      getMemoryRecordsByIds: (ids: string[]) =>
        ids.map(id => ({ ...makeEntry(id, "2026-06-01"), content: `内容:${id}`, preview: "" })),
    } as unknown as MemoryRepository;

    const extractor = {
      decideFileMemoryRoute: async () => "project",
      selectFileManifestEntries: async (input: { manifest: unknown }) => {
        capturedManifest = input.manifest;
        return [];
      },
    } as unknown as LlmMemoryExtractor;

    const retriever = new ReasoningRetriever(repository, extractor, {
      semanticSearch: async () => [{ relativePath: "semantic-only.md", score: 0.9 }],
    });

    const result = await retriever.retrieve("某个旧记忆里的关键结论", { recentMessages: [] });

    // 语义独有命中（不在 manifest 200 上限内）被加入 LLM 候选
    const captured = capturedManifest as Array<{ relativePath: string }>;
    assert.ok(captured.some(entry => entry.relativePath === "semantic-only.md"));
    assert.ok(captured.some(entry => entry.relativePath === "recent-a.md"));

    // trace 记录 semantic_recall step
    assert.ok(result.trace?.steps.some(step => step.kind === "semantic_recall"));

    // 融合后 fallback 选择会命中语义条目正文
    assert.ok(result.context?.includes("内容:semantic-only.md"));
  });

  it("未配置 semanticSearch 时行为与现状一致（manifest 原样）", async () => {
    const manifest = [makeEntry("recent-a.md", "2026-08-01")];
    let capturedManifest: unknown;
    const repository = {
      getSnapshotVersion: () => "snap-2",
      getWorkspaceMode: () => "project",
      getFileMemoryStore: () => ({ getProjectMeta: () => null }),
      listMemoryEntries: () => manifest,
      getMemoryRecordsByIds: (ids: string[]) =>
        ids.map(id => ({ ...makeEntry(id, "2026-06-01"), content: `内容:${id}`, preview: "" })),
    } as unknown as MemoryRepository;
    const extractor = {
      decideFileMemoryRoute: async () => "project",
      selectFileManifestEntries: async (input: { manifest: unknown }) => {
        capturedManifest = input.manifest;
        return [];
      },
    } as unknown as LlmMemoryExtractor;

    const retriever = new ReasoningRetriever(repository, extractor);
    await retriever.retrieve("查询", { recentMessages: [] });

    const captured = capturedManifest as Array<{ relativePath: string }>;
    assert.deepEqual(
      captured.map(entry => entry.relativePath),
      ["recent-a.md"],
    );
  });

  it("语义检索抛错时降级为纯 keyword（不阻断）", async () => {
    const manifest = [makeEntry("recent-a.md", "2026-08-01")];
    let capturedManifest: unknown;
    const repository = {
      getSnapshotVersion: () => "snap-3",
      getWorkspaceMode: () => "project",
      getFileMemoryStore: () => ({ getProjectMeta: () => null }),
      listMemoryEntries: () => manifest,
      getMemoryRecordsByIds: (ids: string[]) =>
        ids.map(id => ({ ...makeEntry(id, "2026-06-01"), content: `内容:${id}`, preview: "" })),
    } as unknown as MemoryRepository;
    const extractor = {
      decideFileMemoryRoute: async () => "project",
      selectFileManifestEntries: async (input: { manifest: unknown }) => {
        capturedManifest = input.manifest;
        return ["recent-a.md"];
      },
    } as unknown as LlmMemoryExtractor;

    const retriever = new ReasoningRetriever(repository, extractor, {
      semanticSearch: async () => {
        throw new Error("embedding service down");
      },
    });

    const result = await retriever.retrieve("查询", { recentMessages: [] });
    assert.ok(result.context?.includes("内容:recent-a.md"));
    const captured = capturedManifest as Array<{ relativePath: string }>;
    assert.deepEqual(
      captured.map(entry => entry.relativePath),
      ["recent-a.md"],
    );
  });
});

describe("MemorySemanticIndex", () => {
  function makeStubService(initial: Array<[string, string]>) {
    const records = new Map(initial);
    let version = 0;
    return {
      list: () => Array.from(records.keys()).map(relativePath => ({ relativePath })),
      get: (ids: string[]) =>
        ids
          .map(id => (records.has(id) ? { relativePath: id, content: records.get(id) } : undefined))
          .filter((record): record is { relativePath: string; content: string } => record !== undefined),
      getSnapshotVersion: () => `snap-${version}`,
      _set: (id: string, content: string) => {
        records.set(id, content);
        version += 1;
      },
      _delete: (id: string) => {
        records.delete(id);
        version += 1;
      },
    };
  }

  type ServiceLike = MemorySemanticIndexOptions["service"];

  it("sync 后按内容可语义检索；快照未变化只 embed 查询", async () => {
    const service = makeStubService([
      ["a.md", "关于创造性判断的结论"],
      ["b.md", "apple banana cherry"],
    ]);
    const { client, embedCalls } = makeStubEmbeddingClient();
    const index = new MemorySemanticIndex({
      service: service as unknown as ServiceLike,
      client,
      storePath: join(makeTempDir(), "memory.jsonl"),
    });

    const hits = await index.search("创造性", 2);
    assert.equal(hits.length, 2);
    assert.equal(index.size, 2);
    assert.ok(embedCalls.length >= 1);

    // 快照未变化：第二次检索仅 embed 查询本身（1 次调用）
    const before = embedCalls.length;
    await index.search("创造性", 2);
    assert.equal(embedCalls.length, before + 1);
  });

  it("内容变化后仅重嵌入变更条目", async () => {
    const service = makeStubService([
      ["a.md", "关于创造性判断的结论"],
      ["b.md", "apple banana cherry"],
    ]);
    const { client, embedCalls } = makeStubEmbeddingClient();
    const index = new MemorySemanticIndex({
      service: service as unknown as ServiceLike,
      client,
      storePath: join(makeTempDir(), "memory.jsonl"),
    });
    await index.search("任意", 1);

    service._set("a.md", "完全不同的新内容");
    const before = embedCalls.length;
    await index.search("任意", 1);
    // upsert 只含 a.md 一条 + 查询一条
    assert.ok(embedCalls.length >= before + 1);
    const upsertCall = embedCalls.slice(before).find(call => call.length === 1 && call[0] === "完全不同的新内容");
    assert.ok(upsertCall, "变更条目应被重嵌入");
  });

  it("文件删除后条目被移除", async () => {
    const service = makeStubService([
      ["a.md", "内容甲"],
      ["b.md", "内容乙"],
    ]);
    const { client } = makeStubEmbeddingClient();
    const index = new MemorySemanticIndex({
      service: service as unknown as ServiceLike,
      client,
      storePath: join(makeTempDir(), "memory.jsonl"),
    });
    await index.search("任意", 2);
    assert.equal(index.size, 2);

    service._delete("a.md");
    await index.search("任意", 2);
    assert.equal(index.size, 1);
  });
});
