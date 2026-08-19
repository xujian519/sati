/**
 * searchChatHistory：团队会话（team: 前缀）在 includeInternal=false 时被过滤（M1 遗留 #3）。
 * fixture 参照 tests/agent/team/member/member-scanner.spec.ts 的写转录方式。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPilotProjectChatDir } from "../../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../../src/session/storage/ProjectSessionStorage.js";
import { searchChatHistory } from "../../../src/session/index.js";

type JsonEntry = Record<string, unknown>;

function acceptedInput(sessionId: string, text: string): JsonEntry {
  return {
    type: "accepted_input",
    sessionId,
    turnId: "t1",
    sequence: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

async function writeTranscript(root: string, sessionKey: string, lines: JsonEntry[]): Promise<void> {
  const chatDir = getPilotProjectChatDir(root, root);
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`),
    lines.map(l => JSON.stringify(l)).join("\n") + "\n",
  );
}

test("searchChatHistory：includeInternal=false 过滤 team: 前缀会话（目录扫描路径）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-chat-search-"));
  try {
    await writeTranscript(root, "team:t1:m1", [acceptedInput("team:t1:m1", "专利检索")]);
    await writeTranscript(root, "normal-s1", [acceptedInput("normal-s1", "专利检索")]);

    const result = await searchChatHistory({
      pilotHome: root,
      projectRoot: root,
      query: "专利检索",
      includeInternal: false,
    });
    assert.equal(result.sessionsScanned, 1);
    assert.equal(
      result.matches.some(m => m.sessionId === "team:t1:m1"),
      false,
    );
    assert.equal(
      result.matches.some(m => m.sessionId === "normal-s1"),
      true,
    );

    // 对照：includeInternal=true 时 team 会话可被扫描
    const all = await searchChatHistory({
      pilotHome: root,
      projectRoot: root,
      query: "专利检索",
      includeInternal: true,
    });
    assert.equal(all.sessionsScanned, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchChatHistory：显式指定 team 会话 id 时 includeInternal=false 直接不扫描", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-chat-search-"));
  try {
    await writeTranscript(root, "team:t1:m1", [acceptedInput("team:t1:m1", "专利检索")]);

    const result = await searchChatHistory({
      pilotHome: root,
      projectRoot: root,
      query: "专利检索",
      sessionId: "team:t1:m1",
      includeInternal: false,
    });
    assert.equal(result.sessionsScanned, 0);
    assert.deepEqual(result.matches, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
