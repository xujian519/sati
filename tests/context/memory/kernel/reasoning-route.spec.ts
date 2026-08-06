import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReasoningRetriever,
  type LlmMemoryExtractor,
  type MemoryRepository,
  type MemoryRoute,
} from "edgeclaw-memory-core";

type ManifestEntry = {
  name: string;
  description: string;
  type: "project" | "user";
  scope: "project" | "global";
  updatedAt: string;
  file: string;
  relativePath: string;
  absolutePath: string;
};

function makeEntry(relativePath: string, type: "project" | "user"): ManifestEntry {
  return {
    name: relativePath.split("/").pop() ?? relativePath,
    description: `desc ${relativePath}`,
    type,
    scope: type === "user" ? "global" : "project",
    updatedAt: "2026-08-01",
    file: relativePath,
    relativePath,
    absolutePath: `/mem/${relativePath}`,
  };
}

function makeRecord(relativePath: string, type: "project" | "user") {
  return {
    ...makeEntry(relativePath, type),
    content: `内容:${relativePath}`,
    preview: "",
  };
}

/** 组装 stub（不复用真实 sqlite）：route 由 stub 路由决定，验证门控后的召回行为。 */
function makeRetriever(input: {
  route: MemoryRoute;
  manifest?: ManifestEntry[];
  onListMemoryEntries?: (options: unknown) => void;
  onSelect?: (selectInput: { limit?: number }) => void;
}) {
  const manifest = input.manifest ?? [];
  const repository = {
    getSnapshotVersion: () => `snap-${input.route}`,
    getWorkspaceMode: () => "single",
    getFileMemoryStore: () => ({ getProjectMeta: () => null }),
    getUserSummary: () => ({
      identityBackground: ["用户是专利代理师，主攻电学领域"],
      files: [makeRecord("global/UserIdentity/user-profile.md", "user")],
    }),
    listMemoryEntries: (options: unknown) => {
      input.onListMemoryEntries?.(options);
      return manifest;
    },
    getMemoryRecordsByIds: (ids: string[]) =>
      ids.map(id => makeRecord(id, id.startsWith("global/") ? "user" : "project")),
  } as unknown as MemoryRepository;

  const extractor = {
    decideFileMemoryRoute: async () => input.route,
    selectFileManifestEntries: async (selectInput: { limit?: number }) => {
      input.onSelect?.(selectInput);
      return manifest.slice(0, 1).map(entry => entry.relativePath);
    },
  } as unknown as LlmMemoryExtractor;

  return new ReasoningRetriever(repository, extractor);
}

describe("ReasoningRetriever 路由门控", () => {
  it("route=none：空召回，且不触发 manifest 选择", async () => {
    let selectCalled = false;
    let listCalled = false;
    const retriever = makeRetriever({
      route: "none",
      onSelect: () => {
        selectCalled = true;
      },
      onListMemoryEntries: () => {
        listCalled = true;
      },
    });

    const result = await retriever.retrieve("今天天气怎么样", { recentMessages: [] });

    assert.equal(result.context, "");
    assert.equal(result.intent, "none");
    assert.equal(result.debug?.route, "none");
    assert.equal(result.debug?.mode, "none");
    assert.equal(selectCalled, false);
    assert.equal(listCalled, false);
  });

  it("route=project：扫描项目 manifest 并注入选中文件正文", async () => {
    const retriever = makeRetriever({
      route: "project",
      manifest: [makeEntry("Project/decisions.md", "project"), makeEntry("Project/timeline.md", "project")],
    });

    const result = await retriever.retrieve("之前定的存储方案是什么", { recentMessages: [] });

    assert.equal(result.debug?.route, "project");
    assert.ok(result.context?.includes("route=project"));
    assert.ok(result.context?.includes("内容:Project/decisions.md"));
    assert.equal(result.debug?.manifestCount, 2);
    assert.deepEqual(result.debug?.selectedFileIds, ["Project/decisions.md"]);
  });

  it("route=user：注入全局用户画像，manifest 取自 global 范围且选择上限为 1", async () => {
    let listOptions: unknown;
    let selectLimit: number | undefined;
    const retriever = makeRetriever({
      route: "user",
      manifest: [makeEntry("global/UserIdentityNotes/writing-style.md", "user")],
      onListMemoryEntries: options => {
        listOptions = options;
      },
      onSelect: selectInput => {
        selectLimit = selectInput.limit;
      },
    });

    const result = await retriever.retrieve("我的写作偏好是什么", { recentMessages: [] });

    assert.equal(result.debug?.route, "user");
    assert.ok(result.context?.includes("route=user"));
    // 用户画像块被注入
    assert.ok(result.context?.includes("用户是专利代理师，主攻电学领域"));
    // manifest 查询限定 global 用户条目，选择上限 1
    assert.deepEqual(listOptions, {
      kinds: ["user"],
      scope: "global",
      limit: 200,
      includeDeprecated: false,
    });
    assert.equal(selectLimit, 1);
  });
});
