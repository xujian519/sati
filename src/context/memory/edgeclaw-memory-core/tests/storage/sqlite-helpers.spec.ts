// sqlite-helpers 行为基线测试（从 sqlite.ts 拆出，逐字搬移）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MemoryBundleValidationError,
  clampInt,
  isGlobalRelativePath,
  isPathWithinRoot,
  normalizeIndexTraceRecord,
  normalizeL0Row,
  normalizeMemoryBundle,
  normalizeMessages,
  normalizeSnapshotRelativePath,
  readSnapshotFiles,
  sanitizeIndexingSettings,
  sanitizeTraceArray,
  snapshotVersionFromFiles,
  sortManifestEntries,
  toExposedGlobalRelativePath,
  toInternalGlobalRelativePath,
} from "../../src/core/storage/sqlite-helpers.js";

describe("normalizeMessages", () => {
  it("过滤非对象、默认 role=user/content 空串", () => {
    assert.deepEqual(normalizeMessages([{ role: "user", content: "a" }, "x", null]), [{ role: "user", content: "a" }]);
  });
  it("msgId 空白则不携带", () => {
    const messages = normalizeMessages([{ msgId: " ", role: "user", content: "a" }]);
    assert.equal("msgId" in (messages[0] ?? {}), false);
  });
});

describe("normalizeL0Row", () => {
  it("行记录归一为 L0SessionRecord", () => {
    const row = normalizeL0Row({
      l0_index_id: "1",
      session_key: "sk",
      timestamp: "2026-01-01",
      messages_json: JSON.stringify([{ role: "user", content: "a" }]),
      source: "sati",
      indexed: 1,
      created_at: "2026-01-01",
    });
    assert.equal(row.l0IndexId, "1");
    assert.equal(row.messages.length, 1);
    assert.equal(row.indexed, true);
  });
});

describe("normalizeSnapshotRelativePath 路径穿越防护", () => {
  it("空路径抛错", () => {
    assert.throws(() => normalizeSnapshotRelativePath("  ", 0), MemoryBundleValidationError);
  });
  it("绝对路径抛错", () => {
    assert.throws(() => normalizeSnapshotRelativePath("/etc/passwd", 0), MemoryBundleValidationError);
  });
  it("../ 段抛错", () => {
    assert.throws(() => normalizeSnapshotRelativePath("../escape.md", 0), MemoryBundleValidationError);
    assert.throws(() => normalizeSnapshotRelativePath("a/../b.md", 0), MemoryBundleValidationError);
  });
  it("合法相对路径归一（反斜杠→正斜杠）", () => {
    assert.equal(normalizeSnapshotRelativePath("projects\\p1\\a.md", 0), "projects/p1/a.md");
  });
});

describe("normalizeMemoryBundle 校验", () => {
  const base = {
    formatVersion: "clawxmemory-memory-snapshot.v4",
    scope: "current_project",
    exportedAt: "2026-01-01",
    files: [],
  };
  it("合法空 bundle 通过", () => {
    assert.deepEqual(normalizeMemoryBundle(base).files, []);
  });
  it("非 current_project scope 抛错", () => {
    assert.throws(() => normalizeMemoryBundle({ ...base, scope: "global" }), /Unsupported memory bundle scope/);
  });
  it("重复文件路径抛错", () => {
    assert.throws(
      () =>
        normalizeMemoryBundle({
          ...base,
          files: [
            { relativePath: "a.md", content: "1" },
            { relativePath: "a.md", content: "2" },
          ],
        }),
      /Duplicate imported snapshot file path/,
    );
  });
  it("legacy multi-project 路径抛错", () => {
    assert.throws(
      () =>
        normalizeMemoryBundle({
          ...base,
          files: [{ relativePath: "projects/p1/memory.md", content: "1" }],
        }),
      /Legacy multi-project memory bundles/,
    );
  });
  it("未知 formatVersion 抛错", () => {
    assert.throws(
      () => normalizeMemoryBundle({ ...base, formatVersion: "clawxmemory-memory-snapshot.v99" }),
      /Unsupported memory bundle formatVersion/,
    );
  });
});

describe("isPathWithinRoot 路径穿越守卫", () => {
  it("目录内路径放行", () => {
    assert.equal(isPathWithinRoot("/root", "/root/a/b.md"), true);
  });
  it("目录外路径拒绝", () => {
    assert.equal(isPathWithinRoot("/root", "/etc/passwd"), false);
    assert.equal(isPathWithinRoot("/root", "/root/../escape.md"), false);
  });
});

describe("sanitizeTraceArray", () => {
  it("过滤缺键项 + 按 sortKey 降序 + 按 key 去重", () => {
    const result = sanitizeTraceArray<{ id: string; t: string }>(
      [{ id: "b", t: "2026-02" }, { id: "a", t: "2026-03" }, { id: "a", t: "2026-01" }, { bad: true }],
      "id",
      "t",
    );
    assert.deepEqual(result, [
      { id: "a", t: "2026-03" },
      { id: "b", t: "2026-02" },
    ]);
  });
});

describe("normalizeIndexTraceRecord 派生字段", () => {
  it("completed+空结果 → isNoOp=true, displayStatus=No-op", () => {
    const record = normalizeIndexTraceRecord({
      status: "completed",
      storedResults: [],
    } as never);
    assert.equal(record.isNoOp, true);
    assert.equal(record.displayStatus, "No-op");
  });
  it("显式 isNoOp 优先", () => {
    const record = normalizeIndexTraceRecord({
      status: "completed",
      isNoOp: false,
      storedResults: [],
    } as never);
    assert.equal(record.isNoOp, false);
  });
});

describe("clampInt / sanitizeIndexingSettings", () => {
  it("clampInt 钳制范围 + fallback", () => {
    assert.equal(clampInt(500, 0, 0, 100), 100);
    assert.equal(clampInt("50", 0, 0, 100), 50);
    assert.equal(clampInt("abc", 7, 0, 100), 7);
  });
  it("reasoningMode 非法值回退默认", () => {
    const settings = sanitizeIndexingSettings({ reasoningMode: "bogus" }, {
      reasoningMode: "answer_first",
      autoIndexIntervalMinutes: 60,
      autoDreamIntervalMinutes: 1440,
    } as never);
    assert.equal(settings.reasoningMode, "answer_first");
  });
});

describe("global 路径归一", () => {
  it("isGlobalRelativePath / toExposed / toInternal 往返", () => {
    assert.equal(isGlobalRelativePath("global/a.md"), true);
    assert.equal(isGlobalRelativePath("a.md"), false);
    assert.equal(toExposedGlobalRelativePath("a.md"), "global/a.md");
    assert.equal(toInternalGlobalRelativePath("global/a.md"), "a.md");
  });
});

describe("排序与快照工具", () => {
  it("sortManifestEntries updatedAt 降序 + path tiebreak", () => {
    const sorted = sortManifestEntries([
      { relativePath: "b.md", updatedAt: "2026-01-02" },
      { relativePath: "a.md", updatedAt: "2026-01-02" },
    ] as never);
    assert.deepEqual(
      sorted.map(e => (e as { relativePath: string }).relativePath),
      ["a.md", "b.md"],
    );
  });
  it("snapshotVersionFromFiles 确定性（同文件同哈希，MEMORY.md 排除）", () => {
    const files = [
      { relativePath: "a.md", content: "1" },
      { relativePath: "MEMORY.md", content: "ignored" },
    ];
    assert.equal(snapshotVersionFromFiles(files), snapshotVersionFromFiles([...files].reverse()));
  });
  it("readSnapshotFiles 递归读取目录", () => {
    const root = mkdtempSync(join(tmpdir(), "sati-sqlite-helpers-"));
    try {
      writeFileSync(join(root, "a.md"), "a");
      mkdirSync(join(root, "sub"), { recursive: true });
      writeFileSync(join(root, "sub", "b.md"), "b");
      const files = readSnapshotFiles(root);
      assert.equal(files.length, 2);
      assert.ok(files.some(f => f.relativePath === "sub/b.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
