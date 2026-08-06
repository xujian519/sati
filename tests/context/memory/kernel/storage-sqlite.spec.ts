import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MemoryRepository, type L0SessionRecord } from "edgeclaw-memory-core";

/** tmp 目录起真实 sqlite；globalRootDir 显式放进 tmp，避免落到共享临时目录。 */
function makeRepository(): { root: string; repository: MemoryRepository } {
  const root = mkdtempSync(join(tmpdir(), "sati-kernel-storage-"));
  const repository = new MemoryRepository(join(root, "data", "control.sqlite"), {
    memoryDir: join(root, "data", "memory"),
    globalRootDir: join(root, "global"),
    workspaceDir: join(root, "workspace"),
  });
  return { root, repository };
}

function makeL0(sessionKey: string, timestamp: string, content: string): L0SessionRecord {
  return {
    l0IndexId: `l0-${sessionKey}-${timestamp}`,
    sessionKey,
    timestamp,
    messages: [
      { role: "user", content },
      { role: "assistant", content: `reply:${content}` },
    ],
    source: "sati-test",
    indexed: false,
    createdAt: timestamp,
  };
}

describe("MemoryRepository（真实 sqlite）", () => {
  it("L0 session 写入/读取，markL0Indexed 后不再 pending", () => {
    const { repository } = makeRepository();
    try {
      repository.insertL0Session(makeL0("s1", "2026-08-01T10:00:00.000Z", "第一条"));
      repository.insertL0Session(makeL0("s1", "2026-08-01T11:00:00.000Z", "第二条"));

      const pending = repository.listUnindexedL0BySession("s1");
      assert.equal(pending.length, 2);
      // 按 timestamp 升序
      assert.equal(pending[0]?.messages[0]?.content, "第一条");
      assert.equal(pending[1]?.messages[0]?.content, "第二条");
      assert.deepEqual(repository.listPendingSessionKeys(), ["s1"]);

      const fetched = repository.getL0ByIds([pending[1]!.l0IndexId]);
      assert.equal(fetched.length, 1);
      assert.equal(fetched[0]?.sessionKey, "s1");
      assert.equal(fetched[0]?.messages.length, 2);
      assert.equal(fetched[0]?.source, "sati-test");

      repository.markL0Indexed([pending[0]!.l0IndexId, pending[1]!.l0IndexId]);
      assert.equal(repository.listUnindexedL0BySession("s1").length, 0);
      assert.deepEqual(repository.listPendingSessionKeys(), []);
    } finally {
      repository.close();
    }
  });

  it("manifest 条目 list/get：upsertCandidate 后可列出并按 id 取回正文", () => {
    const { repository } = makeRepository();
    try {
      const written = repository.getFileMemoryStore().upsertCandidate({
        type: "project",
        scope: "project",
        name: "检索系统重构",
        description: "检索系统重构的关键决策",
        body: "## 决策\n- 存储层改用 sqlite",
      });
      assert.ok(written.relativePath.length > 0);

      const entries = repository.listMemoryEntries({ kinds: ["project"], scope: "project", limit: 100 });
      const entry = entries.find(item => item.relativePath === written.relativePath);
      assert.ok(entry, "manifest 中应能找到刚写入的条目");
      assert.equal(entry.name, "检索系统重构");
      assert.equal(entry.type, "project");

      const records = repository.getMemoryRecordsByIds([written.relativePath]);
      assert.equal(records.length, 1);
      assert.ok(records[0]?.content.includes("存储层改用 sqlite"));
    } finally {
      repository.close();
    }
  });

  it("snapshot version 随记忆文件变化而递增", () => {
    const { repository } = makeRepository();
    try {
      const v0 = repository.getSnapshotVersion();
      repository.getFileMemoryStore().upsertCandidate({
        type: "project",
        scope: "project",
        name: "条目甲",
        description: "甲",
        body: "内容甲",
      });
      const v1 = repository.getSnapshotVersion();
      assert.notEqual(v1, v0);

      repository.getFileMemoryStore().upsertCandidate({
        type: "feedback",
        scope: "project",
        name: "条目乙",
        description: "乙",
        body: "内容乙",
        rule: "总是先给结论",
      });
      const v2 = repository.getSnapshotVersion();
      assert.notEqual(v2, v1);

      // 无变更时版本稳定
      assert.equal(repository.getSnapshotVersion(), v2);
    } finally {
      repository.close();
    }
  });
});
