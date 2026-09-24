/**
 * WorkspaceLedgerStore / WorkspaceLedgerReader 直测（账本持久化边界，TD-SESSION-N04）。
 *
 * 锁定两件事：
 *  - TD-SESSION-N01 / TD-WORKSPACE-N01 / #344：扫描游标只走新增尾部，且以
 *    **条目对象身份**而非数组长度作失效信号——transcript 被整体重写后会重新
 *    解析成新对象，游标必须失效并从头重扫（只比长度会漏掉「同长度替换」）；
 *  - TD-WORKSPACE-N02 / #364：transcript 读不到（超 50MB）时**不得**静默回退
 *    内存态，必须报 unavailable 让调用方区分「真的没写过」与「读不到」，
 *    且诊断只上报一次。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryTranscriptWriter } from "../../../src/session/transcript/InMemoryTranscriptWriter.js";
import { JsonlTranscriptWriter } from "../../../src/session/transcript/JsonlTranscriptWriter.js";
import type {
  AgentTranscriptEntry,
  AgentWorkspaceStateDeltaTranscriptEntry,
  AgentWorkspaceStateTranscriptEntry,
} from "../../../src/session/transcript/TranscriptEntry.js";
import {
  readLatestWorkspaceState,
  scanLatestWorkspaceState,
} from "../../../src/session/workspace/WorkspaceLedgerReader.js";
import {
  WorkspaceLedgerStore,
  WORKSPACE_LEDGER_ANCHOR_INTERVAL,
} from "../../../src/session/workspace/WorkspaceLedgerStore.js";
import {
  applyWorkspaceNote,
  type WorkspaceLedgerState,
  type WorkspaceNoteInput,
} from "../../../src/session/workspace/WorkspaceLedger.js";
import { createWorkspaceNoteTool } from "../../../src/tool/builtin/workspace/WorkspaceNoteTool.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function ledger(goal: string, next = "n"): WorkspaceLedgerState {
  return { goal, core: [], verified: [], open: [], next };
}

function ledgerEntry(sequence: number, goal: string): AgentWorkspaceStateTranscriptEntry {
  return {
    type: "workspace_state",
    sessionId: "s1",
    turnId: "t1",
    sequence,
    createdAt: "2026-09-15T00:00:00.000Z",
    state: ledger(goal),
  };
}

function messageEntry(sequence: number): AgentTranscriptEntry {
  return {
    type: "accepted_input",
    sessionId: "s1",
    turnId: "t1",
    sequence,
    createdAt: "2026-09-15T00:00:00.000Z",
    messages: [],
  };
}

/** 落盘型 store + 其 transcript 路径；用完删除临时目录。 */
async function fileStore(): Promise<{ store: WorkspaceLedgerStore; path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "sati-ledger-"));
  const path = join(dir, "session.jsonl");
  // flushThresholdBytes: 0 = 每条 recordEntry 立即落盘，测试无需等兜底定时器。
  const writer = new JsonlTranscriptWriter({ path, flushThresholdBytes: 0 });
  return {
    store: new WorkspaceLedgerStore(writer, "s1", path),
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("readLatestWorkspaceState 取最后一条 workspace_state 并返回克隆", () => {
  const first = ledgerEntry(1, "first");
  const last = ledgerEntry(3, "last");
  const state = readLatestWorkspaceState([first, messageEntry(2), last]);
  assert.equal(state?.goal, "last");
  assert.notEqual(state, last.state, "必须返回克隆，不得交出内部引用");
  assert.deepEqual(state, last.state);
});

test("scanLatestWorkspaceState 游标复用：跳过已扫前缀，只读新增尾部", () => {
  // 前缀里本身就有一条 workspace_state。游标声称前缀已扫完且结果是 cached——
  // 若实现从头重扫，读到的会是前缀里那条「prefix」，而不是 cached。
  const head = ledgerEntry(1, "prefix");
  const cached = ledger("cached");
  const first = scanLatestWorkspaceState([head], { scanned: 1, anchor: head, state: cached });
  assert.equal(first.state, cached, "前缀应被跳过（否则会读到 prefix）");
  assert.equal(first.cursor.scanned, 1);

  const tail = ledgerEntry(2, "tail");
  const second = scanLatestWorkspaceState([head, tail], first.cursor);
  assert.equal(second.state?.goal, "tail", "新增尾部应被扫到");
  assert.equal(second.cursor.scanned, 2);
  assert.equal(second.cursor.anchor, tail);
});

test("scanLatestWorkspaceState 锚不一致 → 全量重扫（同长度替换也不放过）", () => {
  const covered = ledgerEntry(1, "prefix");
  // 同形状、同长度，但是**另一个对象**——模拟 transcript 被整体重解析。
  const reparsed = ledgerEntry(1, "prefix");
  const scan = scanLatestWorkspaceState([reparsed], { scanned: 1, anchor: covered, state: ledger("cached") });
  assert.equal(scan.state?.goal, "prefix", "对象身份不同即失效，必须从头重扫");
});

test("scanLatestWorkspaceState 数组变短 → 全量重扫", () => {
  const a = ledgerEntry(1, "a");
  const b = ledgerEntry(2, "b");
  const scan = scanLatestWorkspaceState([a], { scanned: 2, anchor: b, state: ledger("cached") });
  assert.equal(scan.state?.goal, "a", "回退后的数组必须重扫");
});

test("file-backed：未写过账本时读为空态而非失败，且诊断走日志（warning 级）", async t => {
  const { store, cleanup } = await fileStore();
  const mockWarn = t.mock.method(console, "warn", () => undefined);
  const mockError = t.mock.method(console, "error", () => undefined);
  try {
    // transcript 文件尚不存在 → transcript_missing 属正常（不是读失败）。
    const snapshot = await store.read();
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.status === "ok" ? snapshot.state : undefined, undefined);
    assert.equal(mockWarn.mock.calls.length, 1, "缺失诊断应上报一次");
    assert.ok(String(mockWarn.mock.calls[0]!.arguments[0]).includes("transcript_missing"));
    assert.equal(mockError.mock.calls.length, 0, "缺失不是 error 级");
  } finally {
    await cleanup();
  }
});

test("file-backed：write → read 往返，且每次读返回独立克隆", async () => {
  const { store, cleanup } = await fileStore();
  try {
    await store.write(ledger("g"), { sessionId: "s1", turnId: "t1" });
    const snapshot = await store.read();
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.status === "ok" ? snapshot.state?.goal : undefined, "g");

    const again = await store.read();
    assert.equal(again.status, "ok");
    if (snapshot.status !== "ok" || again.status !== "ok") throw new Error("unreachable");
    assert.deepEqual(again.state, snapshot.state);
    assert.notEqual(again.state, snapshot.state, "两次读不得共享同一对象");
  } finally {
    await cleanup();
  }
});

test("file-backed：transcript 被整体重写后读到新账本（游标失效）", async () => {
  const { store, path, cleanup } = await fileStore();
  try {
    await store.write(ledger("original"), { sessionId: "s1", turnId: "t1" });
    const before = await store.read();
    assert.equal(before.status === "ok" ? before.state?.goal : undefined, "original");

    // 外部替换整个 transcript（模拟重写/回滚）：这里刻意构造**字节等长**的新
    // 内容（只在原文里把 goal 值换掉），只剩对象身份能识别出替换。
    const original = await readFile(path, "utf8");
    const replacement = original.replace('"goal":"original"', '"goal":"replaced"');
    assert.notEqual(replacement, original);
    assert.equal(
      Buffer.byteLength(replacement, "utf8"),
      Buffer.byteLength(original, "utf8"),
      "本用例依赖两次等长——长度一变，任何只比长度的游标都会失效，就测不到身份锚了",
    );
    await writeFile(path, replacement);
    const after = await store.read();
    assert.equal(after.status, "ok");
    assert.equal(after.status === "ok" ? after.state?.goal : undefined, "replaced", "必须重扫并读到新账本");
  } finally {
    await cleanup();
  }
});

test("transcript 超限：报 unavailable、不回退陈旧内存态、诊断只上报一次", async t => {
  const { store, path, cleanup } = await fileStore();
  try {
    await store.write(ledger("stale"), { sessionId: "s1", turnId: "t1" });
    const healthy = await store.read();
    assert.equal(healthy.status === "ok" ? healthy.state?.goal : undefined, "stale");

    // 稀疏文件撑到超过 DEFAULT_MAX_TRANSCRIPT_READ_BYTES（50MB），瞬时完成。
    await truncate(path, 50 * 1024 * 1024 + 1);
    const mockError = t.mock.method(console, "error", () => undefined);

    const degraded = await store.read();
    assert.equal(degraded.status, "unavailable");
    assert.equal(degraded.status === "unavailable" ? degraded.code : undefined, "transcript_too_large");
    assert.ok(!("state" in degraded), "不得回退内存态：陈旧态冒充真值比缺失更危险");

    // 每轮模型调用都会读一次；同一诊断不得每轮刷屏。
    await store.read();
    assert.equal(mockError.mock.calls.length, 1, "同一诊断只上报一次");
  } finally {
    await cleanup();
  }
});

test("无 transcript 路径（内存 writer）：账本只存在于本进程", async () => {
  const store = new WorkspaceLedgerStore(new InMemoryTranscriptWriter(), "s1");
  const empty = await store.read();
  assert.equal(empty.status, "ok");
  assert.equal(empty.status === "ok" ? empty.state : undefined, undefined);

  await store.write(ledger("mem"), { sessionId: "s1", turnId: "t1" });
  const snapshot = await store.read();
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.status === "ok" ? snapshot.state?.goal : undefined, "mem");
});

// ─────────────────────────────────────────────────────────────────────────────
// #537 / TD-SESSION-N02：锚点 + 增量重放（账本快照不再二次增长）
//
// 写侧把「每笔写入落全量快照」改为「每 K 笔一个自足锚点 + 其间 O(1) 增量」，
// 读侧从最近锚点用同一套 applyWorkspaceNote 顺序重放。下列用例锁定四件事：
//  ① 单条 workspace_state 锚点即可重建该时刻完整账本（格式级自足护栏，PR #378 硬前提）；
//  ② 增量重放与写时状态逐字一致；
//  ③ 全量快照数 ≈ N/K 而非 N（二次增长根治）；
//  ④ 新会话冷读 / resume 冷读 / 跨锚点边界读三条路径都重建出同一账本。
// 负控制：若把锚点改成非自足（只落增量），①④ 立即转红。
// ─────────────────────────────────────────────────────────────────────────────

const K = WORKSPACE_LEDGER_ANCHOR_INTERVAL;

function wsEntry(sequence: number, state: WorkspaceLedgerState): AgentWorkspaceStateTranscriptEntry {
  return {
    type: "workspace_state",
    sessionId: "s1",
    turnId: "t1",
    sequence,
    createdAt: "2026-09-24T00:00:00.000Z",
    state,
  };
}

function deltaEntry(sequence: number, note: WorkspaceNoteInput): AgentWorkspaceStateDeltaTranscriptEntry {
  return {
    type: "workspace_state_delta",
    sessionId: "s1",
    turnId: "t1",
    sequence,
    createdAt: "2026-09-24T00:00:00.000Z",
    note,
  };
}

function toolContext(store: WorkspaceLedgerStore): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/tmp",
    permissionMode: "default",
    permissionContext: {} as never,
    workspaceLedger: store,
  };
}

/** 统计已落盘 transcript 里各类型条目数（增量 vs 全量锚点）。 */
async function countEntries(path: string): Promise<Record<string, number>> {
  const raw = await readFile(path, "utf8");
  const counts: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as { type: string };
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;
  }
  return counts;
}

/** N 笔写入在「1 锚点 + K 增量」节奏下的全量锚点数：ceil(N / (K+1))。 */
function expectedAnchors(n: number): number {
  return Math.ceil(n / (K + 1));
}

test("#537 ①：单条 workspace_state 锚点即可重建完整账本（格式级自足断言）", () => {
  const anchorState: WorkspaceLedgerState = {
    goal: "ship the ledger fix",
    core: [{ text: "transcript — the durable carrier", live: true }],
    verified: [
      { number: 1, text: "reader replays", by: "all cold-read paths" },
      { number: 2, text: "writer anchors", by: "each K-th write" },
    ],
    open: [{ number: 1, text: "does K=32 hold?", settledBy: "byte-growth test" }],
    next: "merge",
  };
  // 冷读**只**给这一条锚点：必须重建出完整账本，不依赖任何其它条目。
  // 负控制——若锚点不是自足全量（改成只落增量），此断言立即红。
  const rebuilt = readLatestWorkspaceState([wsEntry(1, anchorState)]);
  assert.deepEqual(rebuilt, anchorState);
});

test("#537 ②：锚点 + 增量重放 == applyWorkspaceNote（逐字一致）", () => {
  const anchorState = ledger("g");
  const note: WorkspaceNoteInput = { check: "parser holds", by: "all cases pass" };
  const expected = applyWorkspaceNote(anchorState, note).state;
  const rebuilt = readLatestWorkspaceState([wsEntry(1, anchorState), deltaEntry(2, note)]);
  assert.deepEqual(rebuilt, expected);
  assert.equal(rebuilt?.verified.length, 1);
  assert.equal(rebuilt?.verified[0]?.text, "parser holds");
});

test("#537 防御：增量出现在任何锚点之前 → 跳过，不凭空构造基座", () => {
  // 无前导锚点的增量无法重建（被裁剪/损坏的 transcript）：宁可返回 undefined，
  // 也不能把增量应用到臆造的空基座上得到错误账本。
  const rebuilt = readLatestWorkspaceState([deltaEntry(1, { goal: "x", next: "y" })]);
  assert.equal(rebuilt, undefined);
});

test("#537 ④：多锚点只认最后一个 + 其后增量（跨锚点边界读）", () => {
  const a1 = wsEntry(1, ledger("first"));
  const d1 = deltaEntry(2, { check: "c1", by: "all cases" });
  const a2State = ledger("second");
  const a2 = wsEntry(3, a2State); // 后一个全量锚点重置累积
  const d2 = deltaEntry(4, { check: "c2", by: "each input" });
  const expected = applyWorkspaceNote(a2State, { check: "c2", by: "each input" }).state;
  const rebuilt = readLatestWorkspaceState([a1, d1, a2, d2]);
  assert.equal(rebuilt?.goal, "second", "后一个锚点必须覆盖此前累积");
  assert.deepEqual(rebuilt, expected);
  assert.equal(rebuilt?.verified.length, 1, "a1/d1 的历史不得泄漏到 a2 之后");
});

test("#537 节奏信号：scan 返回 deltasSinceAnchor，遇锚点清零", () => {
  const a = wsEntry(1, ledger("g"));
  const d1 = deltaEntry(2, { next: "n1" });
  const d2 = deltaEntry(3, { next: "n2" });
  const scan = scanLatestWorkspaceState([a, d1, d2]);
  assert.equal(scan.deltasSinceAnchor, 2);
  assert.equal(scan.cursor.deltasSinceAnchor, 2);
  // 尾部再来一个全量锚点 → 计数清零。
  const scan2 = scanLatestWorkspaceState([a, d1, d2, wsEntry(4, ledger("g2"))]);
  assert.equal(scan2.deltasSinceAnchor, 0);
});

test("#537 ③：store 首笔落锚点、其后落增量（文件级往返 + 冷读重建）", async () => {
  const { store, path, cleanup } = await fileStore();
  try {
    const tool = createWorkspaceNoteTool();
    const ctx = toolContext(store);
    await tool.execute({ goal: "g", next: "n" }, ctx); // 首笔：锚点（无基座可重放）
    await tool.execute({ check: "c1", by: "all cases pass" }, ctx); // 增量
    await tool.execute({ check: "c2", by: "all cases pass" }, ctx); // 增量
    const counts = await countEntries(path);
    assert.equal(counts.workspace_state, 1, "3 笔写入只应有 1 个全量锚点");
    assert.equal(counts.workspace_state_delta, 2);
    const snapshot = await store.read();
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.status === "ok" ? snapshot.state?.verified.length : -1, 2);
  } finally {
    await cleanup();
  }
});

test("#537 ③：跨 K 笔重新锚定，冷读跨锚点边界仍重建完整账本", async () => {
  const { store, path, cleanup } = await fileStore();
  try {
    const tool = createWorkspaceNoteTool();
    const ctx = toolContext(store);
    const total = K + 2; // 触发第二个锚点：写 1 锚 + K 增量 + 写 K+2 锚
    await tool.execute({ goal: "g", next: "n" }, ctx);
    for (let i = 1; i <= total - 1; i += 1) {
      await tool.execute({ check: `c${i}`, by: "all cases pass" }, ctx);
    }
    const counts = await countEntries(path);
    assert.equal(counts.workspace_state, expectedAnchors(total), "每 K 笔重新锚定一次");
    assert.equal(counts.workspace_state_delta, total - expectedAnchors(total));
    // resume 冷读：全新 store 读同一文件，须重建出写时会话的等价账本。
    const fresh = new WorkspaceLedgerStore(new JsonlTranscriptWriter({ path, flushThresholdBytes: 0 }), "s1", path);
    const cold = await fresh.read();
    const live = await store.read();
    assert.equal(cold.status, "ok");
    assert.equal(cold.status === "ok" ? cold.state?.verified.length : -1, total - 1);
    assert.deepEqual(
      cold.status === "ok" ? cold.state : null,
      live.status === "ok" ? live.state : null,
      "冷读必须与写时会话等价",
    );
  } finally {
    await cleanup();
  }
});

test("#537 ③：N 笔笔记的全量快照数 ≈ N/K 而非 N（二次增长根治）", async () => {
  const n = 100;
  const { store, path, cleanup } = await fileStore();
  try {
    const tool = createWorkspaceNoteTool();
    const ctx = toolContext(store);
    await tool.execute({ goal: "g", next: "n" }, ctx);
    for (let i = 1; i <= n - 1; i += 1) {
      // 每笔追加一条 verified（append-only）——正是 issue 实测的二次增长场景。
      await tool.execute({ check: `checkpoint ${i} holds`, by: "all cases pass" }, ctx);
    }
    const counts = await countEntries(path);
    assert.equal(counts.workspace_state, expectedAnchors(n), "全量快照数必须 ~N/K");
    assert.equal(counts.workspace_state_delta, n - expectedAnchors(n));
    assert.ok(
      counts.workspace_state! <= Math.ceil(n / K) + 1,
      `全量快照数 ${counts.workspace_state} 远超 N/K 上界——二次增长未根治`,
    );
    // 冷读仍能重建全部 N-1 条 verified。
    const fresh = new WorkspaceLedgerStore(new JsonlTranscriptWriter({ path, flushThresholdBytes: 0 }), "s1", path);
    const cold = await fresh.read();
    assert.equal(cold.status === "ok" ? cold.state?.verified.length : -1, n - 1);
  } finally {
    await cleanup();
  }
});

test("#537 ①：无变化写入不增长 transcript（文件级）", async () => {
  const { store, path, cleanup } = await fileStore();
  try {
    const tool = createWorkspaceNoteTool();
    const ctx = toolContext(store);
    await tool.execute({ goal: "g", next: "n" }, ctx);
    const before = Buffer.byteLength(await readFile(path, "utf8"), "utf8");
    // 完全相同的 note → applyWorkspaceNote 报 changed=false → 工具不落任何条目。
    await tool.execute({ goal: "g", next: "n" }, ctx);
    await tool.execute({ goal: "g", next: "n" }, ctx);
    const after = Buffer.byteLength(await readFile(path, "utf8"), "utf8");
    assert.equal(after, before, "无变化写入不得增长 transcript");
  } finally {
    await cleanup();
  }
});

test("#537：内存 writer 也走锚点+增量，且 write 无 note 时退回全量锚点", async () => {
  const writer = new InMemoryTranscriptWriter();
  const store = new WorkspaceLedgerStore(writer, "s1");
  // 无 note（旧调用面 / 防御路径）→ 始终落全量锚点。
  await store.write(ledger("a"), { sessionId: "s1", turnId: "t1" });
  await store.write(ledger("b"), { sessionId: "s1", turnId: "t1" });
  assert.equal(writer.entries.filter(entry => entry.type === "workspace_state").length, 2);
  assert.equal(writer.entries.filter(entry => entry.type === "workspace_state_delta").length, 0);
  // 带 note 且已有基座 → 落增量。
  await store.write(ledger("c"), { sessionId: "s1", turnId: "t1", note: { goal: "c" } });
  assert.equal(writer.entries.filter(entry => entry.type === "workspace_state_delta").length, 1);
});
