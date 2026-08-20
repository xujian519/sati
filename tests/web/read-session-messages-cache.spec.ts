import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

/**
 * P2-C 构建缓存（readSessionMessages.ts）：
 *  - transcript 未变时二次调用命中缓存（元素引用共享，跳过 extract+flatten+inject）；
 *  - transcript 追加后 mtime+size 变化 → 重建，新消息可见；
 *  - incomplete turn status 依赖当前时间 → 每请求重建（时间戳更新）；
 *  - 分页语义：status 只出现在最后一页，nextCursor 翻页与全量一致。
 */

function makeFixture() {
  const projectRoot = mkdtemp(join(tmpdir(), "sati-rsm-cache-project-"));
  const pilotHome = mkdtemp(join(tmpdir(), "sati-rsm-cache-home-"));
  return Promise.all([projectRoot, pilotHome]);
}

async function seedSession(sessionKey: string, projectRoot: string, pilotHome: string, turns: number): Promise<void> {
  const storage = createAgentProjectSessionStorage({
    flushThresholdBytes: 0,
    projectRoot,
    pilotHome,
    sessionId: sessionKey,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  for (let turn = 1; turn <= turns; turn += 1) {
    await storage.transcript.recordAcceptedInput(sessionKey, `turn-${turn}`, [
      { role: "user", content: [{ type: "text", text: `request ${turn}` }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, `turn-${turn}`, {
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn}` }],
    });
    await storage.transcript.recordTurnResult(sessionKey, `turn-${turn}`, {
      type: "success",
      sessionId: sessionKey,
      turnId: `turn-${turn}`,
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-08-02T00:00:01.000Z",
      completedAt: "2026-08-02T00:00:02.000Z",
    });
  }
}

test("P2-C: transcript 未变时二次调用命中缓存（元素引用共享）", async () => {
  const [projectRoot, pilotHome] = await makeFixture();
  try {
    const sessionKey = "web:s_rsm_cache_hit";
    await seedSession(sessionKey, projectRoot, pilotHome, 2);

    const first = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    const second = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });

    assert.equal(second.total, first.total, "total 一致");
    assert.deepEqual(second.messages, first.messages, "内容一致");
    assert.ok(second.messages.length > 0);
    assert.equal(second.messages[0], first.messages[0], "缓存命中应共享元素引用（未重建）");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("P2-C: transcript 追加后缓存失效重建，新消息可见", async () => {
  const [projectRoot, pilotHome] = await makeFixture();
  try {
    const sessionKey = "web:s_rsm_cache_invalidated";
    // 复用同一 storage 实例（sequence 连续），先写 turn-1
    const storage = createAgentProjectSessionStorage({
      flushThresholdBytes: 0,
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [
      { role: "user", content: [{ type: "text", text: "request 1" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
      role: "assistant",
      content: [{ type: "text", text: "answer 1" }],
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-1", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-08-02T00:00:01.000Z",
      completedAt: "2026-08-02T00:00:02.000Z",
    });
    const first = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    assert.equal(first.total, 2, "初始 2 条（input + assistant）");

    // 只追加第二个 turn → mtime+size 变化 → 重建
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-2", [
      { role: "user", content: [{ type: "text", text: "request 2" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-2", {
      role: "assistant",
      content: [{ type: "text", text: "answer 2" }],
    });
    await storage.transcript.recordTurnResult(sessionKey, "turn-2", {
      type: "success",
      sessionId: sessionKey,
      turnId: "turn-2",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-08-02T00:00:01.000Z",
      completedAt: "2026-08-02T00:00:02.000Z",
    });
    const second = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });

    assert.equal(second.total, 4, "追加后 4 条");
    assert.deepEqual(
      second.messages.map(m => String(m.text ?? m.kind)).filter(Boolean),
      ["request 1", "answer 1", "request 2", "answer 2"],
      "追加后顺序保持 transcript 写入序",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("P2-C: incomplete turn status 每请求重建（时间戳随 now 更新）", async () => {
  const [projectRoot, pilotHome] = await makeFixture();
  try {
    const sessionKey = "web:s_rsm_cache_status";
    const storage = createAgentProjectSessionStorage({
      flushThresholdBytes: 0,
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-x", [
      { role: "user", content: [{ type: "text", text: "interrupted" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-x", {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    });

    const nowA = () => new Date("2026-08-02T10:00:00.000Z");
    const nowB = () => new Date("2026-08-02T11:00:00.000Z");
    const first = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome, now: nowA });
    const second = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome, now: nowB });

    const statusA = first.messages.find(m => m.kind === "status");
    const statusB = second.messages.find(m => m.kind === "status");
    assert.ok(statusA && statusB, "两请求都应含 status");
    assert.equal(statusA.createdAt, "2026-08-02T10:00:00.000Z", "status 时间戳来自当前 now");
    assert.equal(statusB.createdAt, "2026-08-02T11:00:00.000Z", "命中缓存仍重建 status（时间戳更新）");
    assert.equal(first.total, 3, "total 含 status");
    assert.equal(second.total, 3);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("P2-C: 分页语义——status 只在末页，翻页链与全量一致", async () => {
  const [projectRoot, pilotHome] = await makeFixture();
  try {
    const sessionKey = "web:s_rsm_cache_paging";
    const storage = createAgentProjectSessionStorage({
      flushThresholdBytes: 0,
      projectRoot,
      pilotHome,
      sessionId: sessionKey,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    // 2 个完整 turn + 1 个中断 turn（status 在末尾）
    await seedSession(sessionKey, projectRoot, pilotHome, 2);
    await storage.transcript.recordAcceptedInput(sessionKey, "turn-x", [
      { role: "user", content: [{ type: "text", text: "interrupted" }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, "turn-x", {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    });

    const full = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });
    assert.equal(full.total, 7, "6 条消息 + 1 条 status");
    assert.equal(full.messages.length, 7, "全量取回含 status");
    assert.equal(full.messages.at(-1)?.kind, "status", "status 在末尾");

    // 翻页链：limit=3 逐页取回，与全量一致（status 只出现在末页，
    // 末页 = 3 条消息 + status；nextCursor 跳过 status，因此 2 页取完）。
    const collected: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = await readWebSessionMessages({ sessionKey, cursor, limit: 3 }, { projectRoot, pilotHome });
      collected.push(...page.messages.map(m => String(m.text ?? m.kind)));
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor !== undefined);
    assert.equal(pageCount, 2, "6 条消息 / limit 3 → 2 页（status 附在末页，不占分页）");
    assert.deepEqual(
      collected,
      full.messages.map(m => String(m.text ?? m.kind)),
      "翻页内容与全量一致且无重复",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
