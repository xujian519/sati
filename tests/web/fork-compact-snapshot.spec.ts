/**
 * fork 会话时压缩快照的重定向（上游 #599 后半）。
 *
 * 快照形态下压缩产物内联在 control_boundary 里，不再是独立消息条目：fork 的
 * 条目级重写若只认三类消息条目，快照内的媒体/工具结果引用会继续指向**源会话
 * 目录**，分叉会话读到的就是别的会话的溢出文件。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { readCompactSnapshot } from "../../src/session/transcript/CompactSnapshot.js";
import type { AgentTranscriptEntry } from "../../src/session/transcript/TranscriptEntry.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";

const SOURCE_SESSION = "web:s_fork-snapshot-src";
const createdAt = "2026-09-20T00:00:00.000Z";

function entries(sourceSessionDir: string): AgentTranscriptEntry[] {
  return [
    {
      type: "accepted_input",
      sessionId: SOURCE_SESSION,
      turnId: "t1",
      sequence: 1,
      createdAt,
      entryId: "a1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "第一问" }] }],
    },
    {
      type: "assistant_message",
      sessionId: SOURCE_SESSION,
      turnId: "t1",
      sequence: 2,
      createdAt,
      entryId: "m1",
      parentEntryId: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "第一答" }] },
    },
    {
      type: "turn_result",
      sessionId: SOURCE_SESSION,
      turnId: "t1",
      sequence: 3,
      createdAt,
      entryId: "r1",
      parentEntryId: "m1",
      result: {
        type: "success",
        sessionId: SOURCE_SESSION,
        turnId: "t1",
        stopReason: "completed",
        usage: {},
        permissionDenials: [],
        turns: 1,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    },
    {
      type: "control_boundary",
      sessionId: SOURCE_SESSION,
      turnId: "t1",
      sequence: 4,
      createdAt,
      entryId: "b1",
      parentEntryId: "r1",
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 20, messagesSummarized: 2 },
        snapshot: {
          version: 1,
          messages: [
            {
              role: "user",
              metadata: { compactReplacement: true },
              content: [
                { type: "text", text: "[CONTEXT COMPACTION - REFERENCE ONLY]\n摘要" },
                {
                  type: "media_reference",
                  path: resolve(sourceSessionDir, "media", "figure.png"),
                  originalBytes: 2048,
                  preview: "[图片] figure.png",
                  hasMore: true,
                  mimeType: "image/png",
                  mediaType: "image",
                },
              ],
            },
          ],
        },
      },
    },
    {
      type: "accepted_input",
      sessionId: SOURCE_SESSION,
      turnId: "t2",
      sequence: 5,
      createdAt,
      entryId: "a2",
      parentEntryId: "r1",
      messages: [{ role: "user", content: [{ type: "text", text: "第二问（分叉点）" }] }],
    },
  ];
}

test("fork 时压缩快照内的会话内路径随分叉重定向，且保留 carryover 标记", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-fork-snapshot-"));
  try {
    const chatDir = getPilotProjectChatDir(root, root);
    const sourceSafeId = sanitizeSessionIdForPath(SOURCE_SESSION);
    const sourceSessionDir = resolve(chatDir, sourceSafeId);
    await mkdir(sourceSessionDir, { recursive: true });
    await writeFile(
      resolve(chatDir, `${sourceSafeId}.jsonl`),
      `${entries(sourceSessionDir)
        .map(entry => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );

    const result = await forkWebSession(
      { sessionKey: SOURCE_SESSION, fromEntryId: "a2" },
      { projectRoot: root, pilotHome: root },
    );

    const targetSafeId = sanitizeSessionIdForPath(result.newSessionKey);
    const targetSessionDir = resolve(chatDir, targetSafeId);
    const { entries: forked } = await readTranscript(resolve(chatDir, `${targetSafeId}.jsonl`));

    const boundary = forked.find(entry => entry.type === "control_boundary");
    assert.ok(boundary !== undefined, "分叉转录应保留压缩边界");
    assert.equal(boundary.sessionId, result.newSessionKey, "边界条目须改挂到新会话");

    const snapshot = readCompactSnapshot(boundary);
    assert.ok(snapshot !== undefined, "分叉后快照仍应可校验（否则重放会丢历史）");
    const media = snapshot[0]!.content.find(block => block.type === "media_reference");
    assert.ok(media !== undefined && media.type === "media_reference");
    assert.equal(media.path, resolve(targetSessionDir, "media", "figure.png"), "快照内的媒体引用须指向分叉后会话目录");
    assert.equal(
      snapshot[0]!.metadata?.forkCarryover?.sourceSessionId,
      SOURCE_SESSION,
      "快照消息须带 fork carryover 标记",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
