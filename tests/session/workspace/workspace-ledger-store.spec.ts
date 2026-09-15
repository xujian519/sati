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
  AgentWorkspaceStateTranscriptEntry,
} from "../../../src/session/transcript/TranscriptEntry.js";
import {
  readLatestWorkspaceState,
  scanLatestWorkspaceState,
} from "../../../src/session/workspace/WorkspaceLedgerReader.js";
import { WorkspaceLedgerStore } from "../../../src/session/workspace/WorkspaceLedgerStore.js";
import type { WorkspaceLedgerState } from "../../../src/session/workspace/WorkspaceLedger.js";

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
