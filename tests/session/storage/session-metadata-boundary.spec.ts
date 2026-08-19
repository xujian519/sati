import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { TurnRunner, type TurnRunnerResult } from "../../../src/agent/turn/TurnRunner.js";
import type { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import { SessionMetadataStore } from "../../../src/session/metadata/SessionMetadataStore.js";
import { readSessionInfo } from "../../../src/session/storage/SessionList.js";
import type { SessionMetadataValue } from "../../../src/session/transcript/TranscriptEntry.js";
import type { AgentTranscriptWriter } from "../../../src/session/transcript/TranscriptWriter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function metadataLine(sessionId: string, metadata: SessionMetadataValue, turnId = "t9"): string {
  return `${JSON.stringify({
    type: "session_metadata",
    sessionId,
    turnId,
    sequence: 9,
    createdAt: "2026-08-19T00:00:00.000Z",
    metadata,
  })}\n`;
}

function acceptedInputLine(sessionId: string, text: string): string {
  return `${JSON.stringify({
    type: "accepted_input",
    sessionId,
    turnId: "t1",
    sequence: 1,
    createdAt: "2026-08-19T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  })}\n`;
}

/** 超大 JSONL 记录（模拟 base64 图片输入），撑过 64KiB 预览窗口。 */
function oversizedLine(prefix = "a", sizeBytes = 80 * 1024): string {
  return `${JSON.stringify({
    type: "tool_result",
    sessionId: "s1",
    turnId: "t1",
    sequence: 2,
    createdAt: "2026-08-19T00:00:00.000Z",
    toolCallId: "tc-1",
    content: [{ type: "text", text: prefix.repeat(sizeBytes) }],
  })}\n`;
}

function writeSession(path: string, lines: string[]): void {
  writeFileSync(path, lines.join(""));
}

describe("SessionMetadataStore.reappendTail 快照标记", () => {
  it("reappendTail 写入 isSnapshot: true 的完整快照", async () => {
    const recorded: SessionMetadataValue[] = [];
    const transcript = {
      recordSessionMetadata: async (_sessionId: string, _turnId: string, metadata: SessionMetadataValue) => {
        recorded.push(metadata);
      },
    } as unknown as AgentTranscriptWriter;
    const store = new SessionMetadataStore({
      transcript,
      sessionId: "s1",
      now: () => new Date("2026-08-19T00:00:00Z"),
    });
    await store.record("t1", { title: "专利检索" });
    await store.reappendTail("t1");

    assert.equal(recorded.length, 2);
    assert.equal(recorded[0]?.isSnapshot, undefined, "record() 是增量 patch，不打快照标记");
    assert.equal(recorded[1]?.isSnapshot, true, "reappendTail() 必须写显式完整快照标记");
    assert.equal(recorded[1]?.title, "专利检索");
  });
});

describe("readSessionInfo 大附件会话边界", () => {
  it("小文件走 fast path：head 内 accepted_input 作为摘要", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-boundary-"));
    tempDirs.push(dir);
    const path = join(dir, "s1.jsonl");
    writeSession(path, [acceptedInputLine("s1", "普通小会话")]);

    const info = await readSessionInfo(path, "s1");
    assert.equal(info?.summary, "普通小会话");
    assert.equal(info?.firstPrompt, "普通小会话");
  });

  it("超大行撑过预览窗口时，尾部 isSnapshot 快照恢复标题", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-boundary-"));
    tempDirs.push(dir);
    const path = join(dir, "s1.jsonl");
    // head 被 80KB 的 tool_result 记录撑过 64KiB 预览；尾部 reappend 的快照含标题。
    writeSession(path, [
      oversizedLine(),
      metadataLine("s1", { title: "大附件会话标题", isSnapshot: true, updatedAt: "2026-08-19T01:00:00.000Z" }),
    ]);

    const info = await readSessionInfo(path, "s1");
    assert.equal(info?.summary, "大附件会话标题", "大文件必须从尾部快照恢复标题");
    assert.equal(info?.customTitle, "大附件会话标题");
  });

  it("尾部只有普通 patch 时，全文件分块扫描兜底恢复 lastPrompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-boundary-"));
    tempDirs.push(dir);
    const path = join(dir, "s1.jsonl");
    writeSession(path, [
      oversizedLine("b"),
      metadataLine("s1", { lastPrompt: "最新的用户请求文本", updatedAt: "2026-08-19T01:00:00.000Z" }),
    ]);

    const info = await readSessionInfo(path, "s1");
    assert.equal(info?.summary, "最新的用户请求文本", "非快照 patch 须经全文件扫描兜底恢复");
  });

  it("旧的 head 标题不掩盖更新的超大尾部记录（metadata 优先）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-boundary-"));
    tempDirs.push(dir);
    const path = join(dir, "s1.jsonl");
    // head 内 accepted_input 是旧标题；尾部快照更新为正式标题。
    writeSession(path, [
      acceptedInputLine("s1", "旧的临时标题"),
      oversizedLine(),
      metadataLine("s1", { title: "正式标题", isSnapshot: true, updatedAt: "2026-08-19T01:00:00.000Z" }),
    ]);

    const info = await readSessionInfo(path, "s1");
    assert.equal(info?.summary, "正式标题", "新尾部记录必须优先于旧 head 标题");
    assert.equal(info?.firstPrompt, "旧的临时标题", "firstPrompt 仍从 head 提取");
  });

  it("超大 metadata 行（firstPrompt 超过 128KiB 上限）仍被完整解析", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-boundary-"));
    tempDirs.push(dir);
    const path = join(dir, "s1.jsonl");
    const hugePrompt = "大输入".repeat(30_000); // ~90KB 文本，转义后整行超过 128KiB 行上限
    writeSession(path, [
      oversizedLine(),
      metadataLine("s1", { title: "大输入会话", firstPrompt: hugePrompt, isSnapshot: true }),
    ]);

    const info = await readSessionInfo(path, "s1");
    assert.equal(info?.summary, "大输入会话");
    assert.equal(info?.firstPrompt, hugePrompt, "metadata 行在超限前已识别，应完整保留");
  });

  it("超大非 metadata 行在 128KiB 后丢弃，不影响后续记录扫描", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-boundary-"));
    tempDirs.push(dir);
    const path = join(dir, "s1.jsonl");
    // 300KB 的非 metadata 垃圾记录（模拟超大图片）：超过行上限被丢弃，
    // 但行尾的 metadata 记录仍被扫到。
    writeSession(path, [oversizedLine("x", 300 * 1024), metadataLine("s1", { title: "垃圾行之后", isSnapshot: true })]);

    const info = await readSessionInfo(path, "s1");
    assert.equal(info?.summary, "垃圾行之后", "超大非 metadata 行不得阻断扫描");
  });
});

describe("TurnRunner 列表 prompt 元数据", () => {
  function makeTurnRunner(metadataStore?: SessionMetadataStore): TurnRunner {
    const loop = {
      run: async function* (): AsyncGenerator<AgentEvent, TurnRunnerResult, unknown> {
        const result: AgentTurnResult = {
          type: "success",
          sessionId: "s1",
          turnId: "t1",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 0,
          startedAt: "2026-08-19T00:00:00.000Z",
          completedAt: "2026-08-19T00:00:01.000Z",
          errors: [],
        };
        // 仅作 generator 出口：TurnRunner 收尾逻辑不依赖具体事件内容。
        yield { type: "turn_completed", sessionId: "s1", turnId: "t1", result } as AgentEvent;
        return { result, messages: [] };
      },
      snapshotFileState: () => ({}),
    } as unknown as AgentLoop;
    const transcript = {
      recordAcceptedInput: async () => {},
      recordTurnResult: async () => {},
      snapshotState: () => undefined,
    } as unknown as AgentTranscriptWriter;
    return new TurnRunner(
      loop,
      transcript,
      undefined,
      () => new Date("2026-08-19T00:00:00Z"),
      undefined,
      { cwd: "/tmp", transcriptPath: "/tmp/t.jsonl", collectFileArtifacts: false },
      metadataStore ? { metadataStore } : undefined,
    );
  }

  it("firstPrompt/lastPrompt 记录为截断到 1200 字符的列表摘要", async () => {
    const transcript = {
      recordSessionMetadata: async () => {},
      recordAcceptedInput: async () => {},
      recordTurnResult: async () => {},
      snapshotState: () => undefined,
    } as unknown as AgentTranscriptWriter;
    const store = new SessionMetadataStore({
      transcript,
      sessionId: "s1",
      now: () => new Date("2026-08-19T00:00:00Z"),
    });
    const runner = makeTurnRunner(store);
    const longPrompt = "请分析这个专利的权利要求范围。".repeat(200); // 远超过 1200 字符
    const expected = "请分析这个专利的权利要求范围。".repeat(200).slice(0, 1200);

    for await (const _event of runner.run({
      sessionId: "s1",
      turnId: "t1",
      messages: [],
      input: { type: "text", text: longPrompt },
    })) {
      // drain
    }

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.firstPrompt, expected, "firstPrompt 必须截断到 SESSION_LISTING_PROMPT_MAX_CHARS");
    assert.equal(snapshot.lastPrompt, expected);
  });

  it("第二个 turn 不再覆盖 firstPrompt，仅更新 lastPrompt", async () => {
    const transcript = {
      recordSessionMetadata: async () => {},
      recordAcceptedInput: async () => {},
      recordTurnResult: async () => {},
      snapshotState: () => undefined,
    } as unknown as AgentTranscriptWriter;
    const store = new SessionMetadataStore({
      transcript,
      sessionId: "s1",
      now: () => new Date("2026-08-19T00:00:00Z"),
    });
    const runner = makeTurnRunner(store);

    for await (const _event of runner.run({
      sessionId: "s1",
      turnId: "t1",
      messages: [],
      input: { type: "text", text: "第一轮请求" },
    })) {
      // drain
    }
    for await (const _event of runner.run({
      sessionId: "s1",
      turnId: "t2",
      messages: [],
      input: { type: "text", text: "第二轮请求" },
    })) {
      // drain
    }

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.firstPrompt, "第一轮请求", "firstPrompt 只在首轮写入");
    assert.equal(snapshot.lastPrompt, "第二轮请求", "lastPrompt 每轮更新");
  });

  it("turn 收尾 reappend 尾部快照（isSnapshot）供大文件读取侧恢复", async () => {
    const recorded: SessionMetadataValue[] = [];
    const transcript = {
      recordSessionMetadata: async (_sessionId: string, _turnId: string, metadata: SessionMetadataValue) => {
        recorded.push(metadata);
      },
      recordAcceptedInput: async () => {},
      recordTurnResult: async () => {},
      snapshotState: () => undefined,
    } as unknown as AgentTranscriptWriter;
    const store = new SessionMetadataStore({
      transcript,
      sessionId: "s1",
      now: () => new Date("2026-08-19T00:00:00Z"),
    });
    const runner = makeTurnRunner(store);

    for await (const _event of runner.run({
      sessionId: "s1",
      turnId: "t1",
      messages: [],
      input: { type: "text", text: "边界测试请求" },
    })) {
      // drain
    }

    const last = recorded.at(-1);
    assert.equal(last?.isSnapshot, true, "turn 收尾必须 reappend 完整快照");
    assert.equal(last?.lastPrompt, "边界测试请求");
  });
});
