import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { JsonlTranscriptWriter } from "../../../src/session/transcript/JsonlTranscriptWriter.js";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FIXED_NOW = () => new Date("2026-08-09T00:00:00.000Z");

function makeTranscriptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-jsonl-writer-"));
  tempDirs.push(dir);
  return dir;
}

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function readEntries(path: string): AgentTranscriptEntry[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as AgentTranscriptEntry);
}

describe("JsonlTranscriptWriter recordEntry 写链", () => {
  it("写入 JSONL 行：sequence 递增、parentEntryId 链式链接", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    await writer.recordAcceptedInput("s1", "t1", [userMessage("first")]);
    await writer.recordAcceptedInput("s1", "t1", [userMessage("second")]);

    const entries = readEntries(path);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map(e => e.sequence),
      [1, 2],
    );
    const e1 = entries[0]!;
    const e2 = entries[1]!;
    assert.equal(e1.type, "accepted_input");
    assert.equal(e1.parentEntryId, null);
    assert.equal(typeof e1.entryId, "string");
    assert.equal(e1.createdAt, "2026-08-09T00:00:00.000Z");
    assert.equal(e2.parentEntryId, e1.entryId);
  });

  it("并发 record 经 writeChain 串行落盘，顺序与 sequence 一致", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    // 故意不逐个 await：只 await 最后一个，验证 writeChain 串行落盘
    const _p1 = writer.recordAcceptedInput("s1", "t1", [userMessage("a")]);
    const _p2 = writer.recordAcceptedInput("s1", "t1", [userMessage("b")]);
    const p3 = writer.recordAcceptedInput("s1", "t1", [userMessage("c")]);
    await p3; // 等待最后一个即等待整条写链

    const entries = readEntries(path);
    assert.deepEqual(
      entries.map(e => e.sequence),
      [1, 2, 3],
    );
    assert.equal(entries[2]!.parentEntryId, entries[1]!.entryId);
  });

  it("嵌套路径自动 mkdir，文件以 0600 权限创建", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "nested", "deep", "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    await writer.recordAcceptedInput("s1", "t1", [userMessage("x")]);

    assert.equal(existsSync(path), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });

  it("recordEntry 保留显式 sequence（max）并链接自定义 entryId", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    const custom: AgentTranscriptEntry = {
      type: "accepted_input",
      sessionId: "s1",
      turnId: "t9",
      sequence: 5,
      createdAt: "2026-08-09T00:00:00.000Z",
      entryId: "custom-entry",
      parentEntryId: null,
      messages: [userMessage("custom")],
    };
    await writer.recordEntry(custom);
    await writer.recordAcceptedInput("s1", "t10", [userMessage("after")]);

    const entries = readEntries(path);
    assert.deepEqual(
      entries.map(e => e.sequence),
      [5, 6],
    );
    assert.equal(entries[1]!.parentEntryId, "custom-entry");
  });

  it("空 metadata 不写入条目，非空 metadata 写入", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    await writer.recordAcceptedInput("s1", "t1", [userMessage("a")], {});
    await writer.recordAcceptedInput("s1", "t1", [userMessage("b")], { title: "doc" });

    const entries = readEntries(path);
    assert.ok(!("metadata" in entries[0]!), "空 metadata 应被省略");
    assert.equal(entries[1]!.type, "accepted_input");
    if (entries[1]!.type !== "accepted_input") throw new Error("unreachable");
    assert.deepEqual(entries[1].metadata, { title: "doc" });
  });

  it("recordAgentStatusMessage 写入 event/kind/text 与可选 detail", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    await writer.recordAgentStatusMessage("s1", "t1", {
      event: "tool_call",
      kind: "status",
      text: "running",
      detail: { name: "patent_search" },
    });
    await writer.recordAgentStatusMessage("s1", "t1", { event: "done", kind: "status", text: "ok" });

    const entries = readEntries(path);
    const first = entries[0]!;
    assert.equal(first.type, "agent_status_message");
    if (first.type !== "agent_status_message") throw new Error("unreachable");
    assert.equal(first.event, "tool_call");
    assert.equal(first.kind, "status");
    assert.equal(first.text, "running");
    assert.deepEqual(first.detail, { name: "patent_search" });
    const second = entries[1]!;
    if (second.type !== "agent_status_message") throw new Error("unreachable");
    assert.ok(!("detail" in second), "空 detail 应被省略");
  });
});

describe("JsonlTranscriptWriter restoreState 续写", () => {
  it("从已有文件恢复 sequence 与 lastEntryId 后继续递增", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");

    const first = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });
    await first.recordAcceptedInput("s1", "t1", [userMessage("one")]);
    await first.recordAcceptedInput("s1", "t1", [userMessage("two")]);
    const persisted = readEntries(path);
    const lastId = persisted[1]!.entryId ?? null;
    assert.deepEqual(first.snapshotState(), { sequence: 2, lastEntryId: lastId });

    // resume：新 writer 从磁盘读取的 maxSeq / lastEntryId 恢复
    const resumed = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });
    resumed.restoreState(2, lastId);
    await resumed.recordAcceptedInput("s1", "t2", [userMessage("three")]);

    const entries = readEntries(path);
    assert.equal(entries.length, 3);
    assert.equal(entries[2]!.sequence, 3);
    assert.equal(entries[2]!.parentEntryId, lastId);
  });

  it("restoreState 不创建或覆盖文件内容", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    writer.restoreState(7, "some-id");
    assert.equal(existsSync(path), false, "restoreState 不应触发文件写入");
    assert.deepEqual(writer.snapshotState(), { sequence: 7, lastEntryId: "some-id" });

    await writer.recordAcceptedInput("s1", "t8", [userMessage("after-resume")]);
    const entries = readEntries(path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.sequence, 8);
    assert.equal(entries[0]!.parentEntryId, "some-id");
  });
});

describe("JsonlTranscriptWriter forSubagent 侧链 (C3.S2)", () => {
  it("经 subagentTranscriptPath 派生独立 writer，parent 不受影响", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const sidePath = join(dir, "subs", "sa-1.jsonl");
    const writer = new JsonlTranscriptWriter({
      path,
      now: FIXED_NOW,
      subagentTranscriptPath: id => join(dir, "subs", `${id}.jsonl`),
      flushThresholdBytes: 0,
    });

    const handle = writer.forSubagent("sa-1");
    assert.equal(handle.subagentId, "sa-1");
    assert.equal(handle.transcriptPath, sidePath);
    assert.equal(writer.relativeSubagentPath("sa-1"), join("subs", "sa-1.jsonl"));

    await handle.writer.recordAcceptedInput("sa-1", "t1", [userMessage("side")]);

    const sideEntries = readEntries(sidePath);
    assert.equal(sideEntries.length, 1);
    assert.equal(sideEntries[0]!.sequence, 1, "侧链 writer 独立计数");
    assert.equal(existsSync(path), false, "侧链写入不应触达 parent");
  });

  it("未提供 resolver 时默认 <parentStem>/subagents/<id>.jsonl", () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    const handle = writer.forSubagent("sa-2");
    assert.equal(handle.transcriptPath, join(dir, "session", "subagents", "sa-2.jsonl"));
    assert.equal(writer.relativeSubagentPath("sa-2"), join("session", "subagents", "sa-2.jsonl"));
  });
});

describe("JsonlTranscriptWriter subagent 预览截断 (C3.S1)", () => {
  it("recordSubagentStarted 对超长 prompt 截断预览并标记", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });
    const prompt = "p".repeat(2000); // > 1024 字节上限

    await writer.recordSubagentStarted("s1", "t1", {
      subagentId: "sa-1",
      subagentType: "explore",
      prompt,
      transcriptRelativePath: "subs/sa-1.jsonl",
    });

    const entry = readEntries(path)[0]!;
    assert.equal(entry.type, "subagent_started");
    if (entry.type !== "subagent_started") throw new Error("unreachable");
    assert.equal(entry.subagentId, "sa-1");
    assert.equal(entry.subagentType, "explore");
    assert.equal(entry.transcriptRelativePath, "subs/sa-1.jsonl");
    assert.equal(entry.promptTruncated, true);
    assert.ok(Buffer.byteLength(entry.promptPreview, "utf8") <= 1024);
  });

  it("短 prompt 不截断；多字节截断不切分码点", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    await writer.recordSubagentStarted("s1", "t1", {
      subagentId: "sa-1",
      subagentType: "explore",
      prompt: "hello",
      transcriptRelativePath: "subs/sa-1.jsonl",
    });
    const short = readEntries(path)[0]!;
    if (short.type !== "subagent_started") throw new Error("unreachable");
    assert.equal(short.promptPreview, "hello");
    assert.equal(short.promptTruncated, false);

    const cjk = "正".repeat(400); // 1200 字节
    await writer.recordSubagentStarted("s1", "t1", {
      subagentId: "sa-2",
      subagentType: "explore",
      prompt: cjk,
      transcriptRelativePath: "subs/sa-2.jsonl",
    });
    const entry = readEntries(path)[1]!;
    if (entry.type !== "subagent_started") throw new Error("unreachable");
    assert.equal(entry.promptTruncated, true);
    assert.ok(Buffer.byteLength(entry.promptPreview, "utf8") <= 1024);
    assert.ok(cjk.startsWith(entry.promptPreview), "预览应是原字符串的前缀（不切分 UTF-8 序列）");
    assert.ok(entry.promptPreview.length < cjk.length);
  });

  it("recordSubagentCompleted 对超长 summary 截断并记录 usage/turns/durationMs", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });
    const summary = "s".repeat(5000); // > 4096 字节上限

    await writer.recordSubagentCompleted("s1", "t1", {
      subagentId: "sa-1",
      subagentType: "explore",
      summary,
      usage: { inputTokens: 100, outputTokens: 50 },
      turns: 3,
      durationMs: 1234,
    });

    const entry = readEntries(path)[0]!;
    assert.equal(entry.type, "subagent_completed");
    if (entry.type !== "subagent_completed") throw new Error("unreachable");
    assert.equal(entry.subagentId, "sa-1");
    assert.equal(entry.subagentType, "explore");
    assert.equal(entry.summaryTruncated, true);
    assert.ok(Buffer.byteLength(entry.summaryPreview, "utf8") <= 4096);
    assert.deepEqual(entry.usage, { inputTokens: 100, outputTokens: 50 });
    assert.equal(entry.turns, 3);
    assert.equal(entry.durationMs, 1234);
  });

  it("短 summary 不截断，errored 标记透传", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    await writer.recordSubagentCompleted("s1", "t1", {
      subagentId: "sa-1",
      subagentType: "plan",
      summary: "done",
      turns: 1,
      durationMs: 5,
      errored: true,
    });

    const entry = readEntries(path)[0]!;
    assert.equal(entry.type, "subagent_completed");
    if (entry.type !== "subagent_completed") throw new Error("unreachable");
    assert.equal(entry.summaryPreview, "done");
    assert.equal(entry.summaryTruncated, false);
    assert.equal(entry.errored, true);
  });
});

describe("JsonlTranscriptWriter M3 写缓冲", () => {
  it("默认缓冲：入队不落盘，flushCheckpoint 后一次落盘", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW });

    // 缓冲模式：入队即返回（不 await 落盘，await 会等 flush 才 settle）
    void writer.recordAcceptedInput("s1", "t1", [userMessage("a")]);
    void writer.recordAcceptedInput("s1", "t1", [userMessage("b")]);
    // 条目已 accept 但仍在缓冲：文件尚未创建
    assert.equal(existsSync(path), false, "缓冲模式下未 flush 前不落盘");

    await writer.flushCheckpoint();
    const entries = readEntries(path);
    assert.deepEqual(
      entries.map(e => e.sequence),
      [1, 2],
      "flushCheckpoint 后两条一次落盘",
    );
  });

  it("turn_result 强制 flush：连同其前 pending 消息一次落盘", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW });

    void writer.recordAcceptedInput("s1", "t1", [userMessage("a")]);
    void writer.recordDurableMessage("s1", "t1", { role: "assistant", content: [{ type: "text", text: "r" }] });
    await writer.recordTurnResult("s1", "t1", {
      type: "success",
      sessionId: "s1",
      turnId: "t1",
      stopReason: "completed",
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:00.000Z",
    });

    // turn_result 触发强制 flush：无需显式 flushCheckpoint 即可读
    const entries = readEntries(path);
    assert.equal(entries.length, 3, "turn_result 落盘时连同其前消息一次写入");
  });

  it("字节阈值触发自动落盘", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 200 });

    await writer.recordAcceptedInput("s1", "t1", [userMessage("x".repeat(150))]); // ~200+ 字节 → 达阈值
    // 达阈值时已触发 flush（不依赖定时器/显式调用）
    assert.equal(existsSync(path), true, "达到阈值自动落盘");
    assert.equal(readEntries(path).length, 1);
  });

  it("flush 在途时入队 + flushCheckpoint：等全部批次排空（不提前 resolve）", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW });

    // a 触发批次 A（appendFile 异步在途）；b 在批次 A 完成前入队 → 批次 B。
    // 旧实现有 flushing 防重入守卫：b 留在 pending，flushCheckpoint 只等批次 A
    // 就 resolve（b 未落盘）——本测试固化「checkpoint resolve 时全部已落盘」。
    void writer.recordAcceptedInput("s1", "t1", [userMessage("a")]);
    void writer.recordAcceptedInput("s1", "t1", [userMessage("b")]);
    await writer.flushCheckpoint();

    const entries = readEntries(path);
    assert.deepEqual(
      entries.map(e => e.sequence),
      [1, 2],
      "flushCheckpoint resolve 时在途批次与新入队批次都已落盘",
    );
  });

  it("字节阈值按 UTF-8 字节计算（CJK 内容不晚触发）", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    // 100 个 CJK 字符 = 300 UTF-8 字节但仅 100 UTF-16 units：旧实现按 units
    // 计（< 300 不触发，中文内容阈值晚 ~3 倍），修复后按字节计立即落盘。
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 300 });

    await writer.recordAcceptedInput("s1", "t1", [userMessage("正".repeat(100))]);
    assert.equal(existsSync(path), true, "UTF-8 字节达阈值自动落盘");
  });

  it("定时器兜底：无显式 flush 时 flushIntervalMs 后落盘", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushIntervalMs: 10 });

    void writer.recordAcceptedInput("s1", "t1", [userMessage("a")]);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(existsSync(path), true, "定时器兜底落盘");
    assert.equal(readEntries(path).length, 1);
  });

  it("落盘失败错误传播：recordEntry reject，flushCheckpoint 边界可见且只报一次", async () => {
    const dir = makeTranscriptDir();
    // path 指向一个已存在的目录 → appendFile 抛 EISDIR。
    // flushThresholdBytes: 1 → 每条立即 flush（不依赖 unref 定时器）。
    const writer = new JsonlTranscriptWriter({ path: dir, now: FIXED_NOW, flushThresholdBytes: 1 });

    await assert.rejects(
      writer.recordAcceptedInput("s1", "t1", [userMessage("a")]),
      /EISDIR|illegal operation|not a file/,
    );
    // 边界级：flushCheckpoint 也报错（fail-closed，TurnRunner 工具副作用前可见）
    await assert.rejects(writer.flushCheckpoint(), /EISDIR|illegal operation|not a file/);
    // 错误传播一次后清除：后续 flushCheckpoint 不再重复报旧错
    await writer.flushCheckpoint();
  });

  it("flushCheckpoint 幂等且可多次调用", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW });

    await writer.flushCheckpoint(); // 无 pending：no-op
    void writer.recordAcceptedInput("s1", "t1", [userMessage("a")]);
    await writer.flushCheckpoint();
    await writer.flushCheckpoint();
    void writer.recordAcceptedInput("s1", "t1", [userMessage("b")]);
    await writer.flushCheckpoint();

    const entries = readEntries(path);
    assert.deepEqual(
      entries.map(e => e.sequence),
      [1, 2],
    );
  });

  it("flushThresholdBytes=0 直写（回滚）：每条立即落盘", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    await writer.recordAcceptedInput("s1", "t1", [userMessage("a")]);
    assert.equal(existsSync(path), true, "直写模式下记录即落盘");
    assert.equal(readEntries(path).length, 1);
  });
});
