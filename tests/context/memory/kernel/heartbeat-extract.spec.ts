import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  HeartbeatIndexer,
  MemoryRepository,
  type IndexingSettings,
  type LlmMemoryExtractor,
  type MemoryCandidate,
} from "edgeclaw-memory-core";

const SETTINGS: IndexingSettings = {
  reasoningMode: "answer_first",
  autoIndexIntervalMinutes: 60,
  autoDreamIntervalMinutes: 1440,
};

function makeIndexer(extractor: LlmMemoryExtractor): {
  repository: MemoryRepository;
  indexer: HeartbeatIndexer;
} {
  const root = mkdtempSync(join(tmpdir(), "sati-kernel-heartbeat-"));
  const repository = new MemoryRepository(join(root, "data", "control.sqlite"), {
    memoryDir: join(root, "data", "memory"),
    globalRootDir: join(root, "global"),
    workspaceDir: join(root, "workspace"),
  });
  const indexer = new HeartbeatIndexer(repository, extractor, { settings: SETTINGS, source: "sati-test" });
  return { repository, indexer };
}

const PROJECT_NOTE: MemoryCandidate = {
  type: "project",
  scope: "project",
  name: "检索系统存储方案",
  description: "检索系统存储层的关键决策",
  body: "## 决策\n- 存储层改用 sqlite",
};

describe("HeartbeatIndexer（真实 sqlite + stub LLM extractor）", () => {
  it("对构造的 L0 会话跑一轮索引：写入项目记忆文件并标记 indexed", async () => {
    const classifyCalls: string[] = [];
    const extractor = {
      classifyMemoryTurn: async (input: { focusUserTurn: { content: string } }) => {
        classifyCalls.push(input.focusUserTurn.content);
        return {
          shouldStore: true,
          labels: [{ type: "project", reason: "包含项目决策", evidence: "存储层改用 sqlite" }],
        };
      },
      createProjectMemoryNote: async () => ({ ...PROJECT_NOTE }),
      createUserMemoryNote: async () => null,
      createFeedbackMemoryNote: async () => null,
    } as unknown as LlmMemoryExtractor;

    const { repository, indexer } = makeIndexer(extractor);
    try {
      const captured = indexer.captureL0Session({
        sessionKey: "s1",
        timestamp: "2026-08-01T10:00:00.000Z",
        messages: [
          { role: "user", content: "我们决定了，检索系统的存储层改用 sqlite" },
          { role: "assistant", content: "好的，记下了。" },
        ],
      });
      assert.ok(captured, "首条 L0 应被捕获");

      const stats = await indexer.runHeartbeat({ reason: "manual" });

      assert.equal(stats.capturedSessions, 1);
      assert.equal(stats.failedSessions, 0);
      assert.equal(stats.writtenProjectFiles, 1);
      assert.ok(stats.writtenFiles >= 1);
      // 分类器以用户 turn 为焦点被调用一次
      assert.deepEqual(classifyCalls, ["我们决定了，检索系统的存储层改用 sqlite"]);

      // L0 已标记 indexed
      assert.equal(repository.listUnindexedL0BySession("s1").length, 0);

      // 记忆文件写入并可经 manifest 检索到正文
      const entries = repository.listMemoryEntries({ kinds: ["project"], scope: "project", limit: 100 });
      const entry = entries.find(item => item.name === "检索系统存储方案");
      assert.ok(entry, "manifest 中应存在写入的项目记忆");
      const records = repository.getMemoryRecordsByIds([entry.relativePath]);
      assert.ok(records[0]?.content.includes("存储层改用 sqlite"));

      // 再跑一轮：无 pending，全部为零
      const second = await indexer.runHeartbeat({ reason: "manual" });
      assert.equal(second.capturedSessions, 0);
      assert.equal(second.writtenFiles, 0);
    } finally {
      repository.close();
    }
  });

  it("分类结果为不存储：会话标记 indexed 但不写文件", async () => {
    let createCalled = false;
    const extractor = {
      classifyMemoryTurn: async () => ({ shouldStore: false, labels: [] }),
      createProjectMemoryNote: async () => {
        createCalled = true;
        return null;
      },
      createUserMemoryNote: async () => null,
      createFeedbackMemoryNote: async () => null,
    } as unknown as LlmMemoryExtractor;

    const { repository, indexer } = makeIndexer(extractor);
    try {
      indexer.captureL0Session({
        sessionKey: "s2",
        timestamp: "2026-08-01T12:00:00.000Z",
        messages: [{ role: "user", content: "今天天气不错" }],
      });

      const stats = await indexer.runHeartbeat({ reason: "manual" });

      assert.equal(stats.capturedSessions, 1);
      assert.equal(stats.failedSessions, 0);
      assert.equal(stats.writtenFiles, 0);
      assert.equal(createCalled, false);
      assert.equal(repository.listUnindexedL0BySession("s2").length, 0);
      assert.equal(repository.listMemoryEntries({ kinds: ["project"], scope: "project", limit: 100 }).length, 0);
    } finally {
      repository.close();
    }
  });
});
