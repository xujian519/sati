import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DreamRewriteRunner,
  MemoryRepository,
  type LlmMemoryExtractor,
  type MemoryRepositoryStage,
} from "edgeclaw-memory-core";

function makeRepository(): { root: string; workspaceDir: string; repository: MemoryRepository } {
  const root = mkdtempSync(join(tmpdir(), "sati-kernel-dream-"));
  const workspaceDir = join(root, "workspace");
  const repository = new MemoryRepository(join(root, "data", "control.sqlite"), {
    memoryDir: join(root, "data", "memory"),
    globalRootDir: join(root, "global"),
    workspaceDir,
  });
  return { root, workspaceDir, repository };
}

const MERGED_MARKDOWN = "## 决策\n- 合并后的检索与分析结论";

/** stub LLM：把全部 project 条目合并为一个文件，feedback 不合并，项目元数据保持不变。 */
function makeMergeExtractor(memberRelativePaths: string[]): LlmMemoryExtractor {
  return {
    planDreamClusters: async (input: { kind: "project" | "feedback" }) => ({
      summary: input.kind === "project" ? "合并同主题项目记忆" : "无反馈记忆需要合并",
      clusters: input.kind === "project" ? [{ memberRelativePaths, reason: "同一主题" }] : [],
    }),
    refineDreamCluster: async () => ({
      summary: "已合并为一个文件",
      file: {
        name: "检索与分析合并",
        description: "合并后的项目记忆",
        markdown: MERGED_MARKDOWN,
      },
    }),
    reviewDreamProjectMeta: async (input: {
      currentMeta: { projectName: string; description: string; status: string };
    }) => ({
      shouldUpdate: false,
      reason: "保持不变",
      projectMeta: input.currentMeta,
    }),
  } as unknown as LlmMemoryExtractor;
}

/**
 * 复刻 EdgeClawMemoryService.dream() 的提交路径：
 * stage 副本上跑 runner → 安装回滚快照 → 用 stage 内容替换 live 根目录。
 */
function commitStage(
  repository: MemoryRepository,
  stage: MemoryRepositoryStage,
  stagedSnapshot: ReturnType<MemoryRepository["captureCurrentMemorySnapshot"]>,
  input: { finishedAt: string; summary: string; workspaceDir: string },
): void {
  repository.installLastDreamSnapshot(stage.snapshot, {
    version: 1,
    capturedAt: input.finishedAt,
    sourceAction: "dream",
    sourceWorkspaceDir: input.workspaceDir,
    trigger: "manual",
    summary: input.summary,
    before: {
      workspaceVersion: stage.snapshot.workspaceVersion,
      globalVersion: stage.snapshot.globalVersion,
      counts: stage.snapshot.counts,
      runtimeState: stage.snapshot.runtimeState,
    },
    after: {
      workspaceVersion: stagedSnapshot.workspaceVersion,
      globalVersion: stagedSnapshot.globalVersion,
      counts: stagedSnapshot.counts,
      runtimeState: stagedSnapshot.runtimeState,
    },
  });
  repository.replaceLiveRootsWithStage(stage, stage.snapshot);
  stage.dispose();
  repository.getFileMemoryStore().repairManifests();
}

describe("DreamRewriteRunner + rollback（真实 sqlite + stub LLM）", () => {
  it("dream 合并两条 project 记忆；rollbackLastDreamSnapshot 恢复旧快照", async () => {
    const { workspaceDir, repository } = makeRepository();
    try {
      const store = repository.getFileMemoryStore();
      store.upsertCandidate({
        type: "project",
        scope: "project",
        name: "检索式构建",
        description: "检索式构建要点",
        body: "## 决策\n- 用 IPC 分类号收窄",
      });
      store.upsertCandidate({
        type: "project",
        scope: "project",
        name: "对比文件分析",
        description: "对比文件分析方法",
        body: "## 决策\n- 用三步法判断创造性",
      });

      const beforeEntries = repository.listMemoryEntries({ kinds: ["project"], scope: "project", limit: 100 });
      assert.equal(beforeEntries.length, 2);
      const beforePaths = beforeEntries.map(entry => entry.relativePath).sort();

      // dream：stage 副本上执行，stub LLM 产出合并决策
      const stage = repository.createDreamStage("dream");
      const runner = new DreamRewriteRunner(stage.repository, makeMergeExtractor(beforePaths));
      const outcome = await runner.run("manual");
      const stagedSnapshot = stage.repository.captureCurrentMemorySnapshot();
      stage.repository.close();

      assert.equal(outcome.isNoOp, false);
      assert.equal(outcome.reviewedFiles, 2);
      assert.equal(outcome.rewrittenProjects, 1);
      assert.equal(outcome.deletedFiles, 2);
      assert.ok(outcome.summary.includes("Refined 1 dream clusters"));

      commitStage(repository, stage, stagedSnapshot, {
        finishedAt: outcome.finishedAt,
        summary: outcome.summary,
        workspaceDir,
      });

      // live 存储：两条旧文件被删除，合并文件生效
      const afterEntries = repository.listMemoryEntries({ kinds: ["project"], scope: "project", limit: 100 });
      assert.equal(afterEntries.length, 1);
      const merged = repository.getMemoryRecordsByIds([afterEntries[0]!.relativePath], 5000)[0];
      assert.ok(merged?.content.includes("合并后的检索与分析结论"));
      assert.equal(repository.getMemoryRecordsByIds(beforePaths, 5000).length, 0);

      // 回滚：恢复 dream 前的快照
      const rollback = repository.rollbackLastDreamSnapshot();
      assert.ok(rollback.rolledBackAt.length > 0);
      repository.getFileMemoryStore().repairManifests();

      const restoredEntries = repository.listMemoryEntries({ kinds: ["project"], scope: "project", limit: 100 });
      assert.deepEqual(restoredEntries.map(entry => entry.relativePath).sort(), beforePaths);
      const restoredRecords = repository.getMemoryRecordsByIds(beforePaths, 5000);
      assert.equal(restoredRecords.length, 2);
      assert.ok(restoredRecords.some(record => record.content.includes("IPC 分类号收窄")));
      assert.ok(restoredRecords.some(record => record.content.includes("三步法判断创造性")));
    } finally {
      repository.close();
    }
  });

  it("没有可回滚快照时 rollbackLastDreamSnapshot 抛错", () => {
    const { repository } = makeRepository();
    try {
      assert.throws(() => repository.rollbackLastDreamSnapshot(), /No last Dream snapshot/);
    } finally {
      repository.close();
    }
  });
});
