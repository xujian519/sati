/**
 * 编辑/重新生成最后一条用户消息（协议 1.7，遮蔽式 append-only）。
 *
 * 覆盖：rewriteLastTurn 成功遮蔽（turn_rewrite 条目形状、parentEntryId/sequence
 * 衔接）、重放投影跳过被遮蔽条目（旧消息从模型可见序列消失、usage 仍合并）、
 * 可叠加遮蔽、前置校验（空会话 / turn 未收尾 / 压缩尾巴 / 非文本 / 无 entryId）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { replayTranscriptEntries } from "../../src/session/transcript/TranscriptReplay.js";
import { rewriteLastTurn } from "../../src/web/server/editLastTurn.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";

const SESSION = "web:s_edit-1";

function turnResult(turnId: string): AgentTurnResult {
  return {
    type: "success",
    sessionId: SESSION,
    turnId,
    stopReason: "completed",
    usage: { inputTokens: 10, outputTokens: 5 },
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-04T00:00:00.000Z",
    completedAt: "2026-09-04T00:00:01.000Z",
  };
}

function baseEntry(type: string, turnId: string, sequence: number, entryId: string) {
  return {
    type,
    sessionId: SESSION,
    turnId,
    sequence,
    createdAt: "2026-09-04T00:00:00.000Z",
    entryId,
    parentEntryId: null,
  };
}

/** 两 turn 完整会话：t1（hello → hi there）+ t2（second → second reply）。 */
function twoTurnEntries(): AgentTranscriptEntry[] {
  return [
    {
      ...baseEntry("accepted_input", "t1", 1, "a1"),
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    } as AgentTranscriptEntry,
    {
      ...baseEntry("assistant_message", "t1", 2, "m1"),
      message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    } as AgentTranscriptEntry,
    { ...baseEntry("turn_result", "t1", 3, "r1"), result: turnResult("t1") } as AgentTranscriptEntry,
    {
      ...baseEntry("accepted_input", "t2", 4, "a2"),
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
    } as AgentTranscriptEntry,
    {
      ...baseEntry("assistant_message", "t2", 5, "m2"),
      message: { role: "assistant", content: [{ type: "text", text: "second reply" }] },
    } as AgentTranscriptEntry,
    { ...baseEntry("turn_result", "t2", 6, "r2"), result: turnResult("t2") } as AgentTranscriptEntry,
  ];
}

async function writeEntries(root: string, entries: AgentTranscriptEntry[]): Promise<void> {
  const chatDir = getPilotProjectChatDir(root, root);
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    join(chatDir, `${sanitizeSessionIdForPath(SESSION)}.jsonl`),
    entries.map(entry => JSON.stringify(entry)).join("\n") + "\n",
  );
}

async function readEntries(root: string): Promise<AgentTranscriptEntry[]> {
  const chatDir = getPilotProjectChatDir(root, root);
  const { entries } = await readTranscript(join(chatDir, `${sanitizeSessionIdForPath(SESSION)}.jsonl`));
  return entries;
}

function messageTexts(entries: AgentTranscriptEntry[]): string[] {
  return replayTranscriptEntries(entries).messages.flatMap(message =>
    message.content.filter(block => block.type === "text").map(block => (block.type === "text" ? block.text : "")),
  );
}

test("regenerate：追加 turn_rewrite 遮蔽最后 turn，重放投影只剩第一 turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-edit-last-"));
  try {
    await writeEntries(root, twoTurnEntries());

    const result = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "regenerate_last_turn" },
      { projectRoot: root, pilotHome: root },
    );
    assert.equal(result.rewritten, true);
    assert.equal(result.originalText, "second");
    assert.equal(result.turnId, "t2");
    // 遮蔽集 = accepted_input a2 + assistant m2（turn_result 不遮蔽：usage 合并依赖它）
    assert.equal(result.shadowedEntryCount, 2);

    const entries = await readEntries(root);
    const last = entries[entries.length - 1]!;
    assert.equal(last.type, "turn_rewrite");
    assert.equal(last.turnId, "t2");
    assert.equal(last.sequence, 7);
    assert.equal(last.parentEntryId, "r2");
    if (last.type !== "turn_rewrite") throw new Error("unreachable");
    assert.deepEqual([...last.rewrite.shadowFromEntryIds].sort(), ["a2", "m2"]);
    assert.equal(last.rewrite.reason, "regenerate_last_turn");
    assert.equal(last.rewrite.newText, undefined);

    const texts = messageTexts(entries);
    assert.deepEqual(texts, ["hello", "hi there"]);
    // usage 仍合并两个 turn（turn_result 未被遮蔽）
    const replayed = replayTranscriptEntries(entries);
    assert.equal(replayed.usage.inputTokens, 20);
    assert.ok(!replayed.events.some(event => event.type === "input_accepted" && event.turnId === "t2"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit_last_turn：turn_rewrite 记录 newText；重复编辑可叠加遮蔽", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-edit-last-"));
  try {
    await writeEntries(root, twoTurnEntries());
    const first = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "edit_last_turn", newText: "second v2" },
      { projectRoot: root, pilotHome: root },
    );
    assert.equal(first.rewritten, true);

    // 追加新 accepted_input 模拟重发后再次编辑最后一条（t2'）
    const extended = await readEntries(root);
    extended.push(
      {
        ...baseEntry("accepted_input", "t3", 8, "a3"),
        messages: [{ role: "user", content: [{ type: "text", text: "second v2" }] }],
      } as AgentTranscriptEntry,
      {
        ...baseEntry("assistant_message", "t3", 9, "m3"),
        message: { role: "assistant", content: [{ type: "text", text: "v2 reply" }] },
      } as AgentTranscriptEntry,
      { ...baseEntry("turn_result", "t3", 10, "r3"), result: turnResult("t3") } as AgentTranscriptEntry,
    );
    await writeEntries(root, extended);

    const second = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "edit_last_turn", newText: "second v3" },
      { projectRoot: root, pilotHome: root },
    );
    assert.equal(second.rewritten, true);
    assert.equal(second.originalText, "second v2");

    const entries = await readEntries(root);
    const rewrites = entries.filter(entry => entry.type === "turn_rewrite");
    assert.equal(rewrites.length, 2);
    // 叠加：t2 与 t3 的输入/回复全部消失，只剩 t1
    assert.deepEqual(messageTexts(entries), ["hello", "hi there"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("前置校验：空会话 / turn 未收尾 / 压缩尾巴 / 非文本 / 无 entryId", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-edit-last-"));
  try {
    // 空会话（无转录文件）
    const empty = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "regenerate_last_turn" },
      { projectRoot: root, pilotHome: root },
    );
    assert.deepEqual(empty, { rewritten: false, reason: "no_last_turn" });

    // turn 未收尾（无 turn_result）
    await writeEntries(root, [
      {
        ...baseEntry("accepted_input", "t1", 1, "a1"),
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      } as AgentTranscriptEntry,
    ]);
    const incomplete = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "regenerate_last_turn" },
      { projectRoot: root, pilotHome: root },
    );
    assert.deepEqual(incomplete, { rewritten: false, reason: "no_last_turn" });

    // 压缩尾巴：最后 accepted_input 在 compact_boundary 之前
    await writeEntries(root, [
      {
        ...baseEntry("accepted_input", "t1", 1, "a1"),
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      } as AgentTranscriptEntry,
      {
        ...baseEntry("control_boundary", "compact-1", 2, "c1"),
        boundary: {
          kind: "compact",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "manual", preTokens: 100 },
        },
      } as AgentTranscriptEntry,
      { ...baseEntry("turn_result", "t1", 3, "r1"), result: turnResult("t1") } as AgentTranscriptEntry,
    ]);
    const compacted = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "regenerate_last_turn" },
      { projectRoot: root, pilotHome: root },
    );
    assert.deepEqual(compacted, { rewritten: false, reason: "compact_tail" });

    // 非文本内容
    await writeEntries(root, [
      {
        ...baseEntry("accepted_input", "t1", 1, "a1"),
        messages: [{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }],
      } as unknown as AgentTranscriptEntry,
      { ...baseEntry("turn_result", "t1", 2, "r1"), result: turnResult("t1") } as AgentTranscriptEntry,
    ]);
    const attached = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "regenerate_last_turn" },
      { projectRoot: root, pilotHome: root },
    );
    assert.deepEqual(attached, { rewritten: false, reason: "unsupported_content" });

    // 无 entryId 的旧条目
    await writeEntries(root, [
      {
        type: "accepted_input",
        sessionId: SESSION,
        turnId: "t1",
        sequence: 1,
        createdAt: "2026-09-04T00:00:00.000Z",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      } as AgentTranscriptEntry,
      { ...baseEntry("turn_result", "t1", 2, "r1"), result: turnResult("t1") } as AgentTranscriptEntry,
    ]);
    const legacy = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "regenerate_last_turn" },
      { projectRoot: root, pilotHome: root },
    );
    assert.deepEqual(legacy, { rewritten: false, reason: "no_last_turn" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("遮蔽不跨会话：shadowFromEntryIds 只含本 turn 条目", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-edit-last-"));
  try {
    const otherId = randomUUID();
    const entries: AgentTranscriptEntry[] = [
      {
        ...baseEntry("accepted_input", "t1", 1, "a1"),
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      } as AgentTranscriptEntry,
      {
        ...baseEntry("accepted_input", "t2", 2, otherId),
        messages: [{ role: "user", content: [{ type: "text", text: "别的 turn 同文本" }] }],
      } as AgentTranscriptEntry,
      { ...baseEntry("turn_result", "t1", 3, "r1"), result: turnResult("t1") } as AgentTranscriptEntry,
      { ...baseEntry("turn_result", "t2", 4, "r2"), result: turnResult("t2") } as AgentTranscriptEntry,
    ];
    await writeEntries(root, entries);

    const result = await rewriteLastTurn(
      { sessionKey: SESSION, reason: "regenerate_last_turn" },
      { projectRoot: root, pilotHome: root },
    );
    assert.equal(result.rewritten, true);
    const after = await readEntries(root);
    const last = after[after.length - 1]!;
    if (last.type !== "turn_rewrite") throw new Error("expected turn_rewrite");
    // 只遮蔽 t2 的 accepted_input（无消息条目），t1 完好
    assert.deepEqual(last.rewrite.shadowFromEntryIds, [otherId]);
    assert.deepEqual(messageTexts(after), ["hello"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("并发 rewrite 串行化：同一会话两个 edit 不产生重复 sequence / 过时 parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-edit-last-"));
  try {
    await writeEntries(root, twoTurnEntries());

    const [first, second] = await Promise.all([
      rewriteLastTurn(
        { sessionKey: SESSION, reason: "edit_last_turn", newText: "second v2" },
        { projectRoot: root, pilotHome: root },
      ),
      rewriteLastTurn(
        { sessionKey: SESSION, reason: "edit_last_turn", newText: "second v3" },
        { projectRoot: root, pilotHome: root },
      ),
    ]);
    assert.equal(first.rewritten, true);
    assert.equal(second.rewritten, true);

    const entries = await readEntries(root);
    const rewrites = entries.filter(entry => entry.type === "turn_rewrite");
    // 同一调用方后续独立 append 会产生 sequence 冲突；锁串行化后依次递增且 parent 衔接。
    assert.equal(rewrites.length, 2);
    assert.notEqual(rewrites[0]!.sequence, rewrites[1]!.sequence);
    assert.equal(rewrites[1]!.parentEntryId, rewrites[0]!.entryId);
    assert.equal(rewrites[0]!.parentEntryId, "r2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
