/**
 * 内部会话过滤：成员会话（team: 前缀）不出现在 listProjectSessions（includeInternal: false）。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPilotProjectChatDir } from "../../../src/pilot/index.js";
import { listProjectSessions } from "../../../src/session/storage/SessionList.js";
import { sanitizeSessionIdForPath } from "../../../src/session/storage/ProjectSessionStorage.js";
import { isInternalSession } from "../../../src/session/storage/SessionList.js";

test("isInternalSession：成员会话与 always-on 内部会话均识别", () => {
  assert.equal(isInternalSession("team:t1:m1"), true);
  assert.equal(isInternalSession("team-t1-m1"), true); // Windows 净化形态（sanitizeSessionIdForPath 替换冒号）
  assert.equal(isInternalSession("always-on-discovery:x"), true);
  assert.equal(isInternalSession("web:abc"), false);
  assert.equal(isInternalSession(""), false);
});

test("listProjectSessions：成员转录不出现（includeInternal: false）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-session-list-"));
  try {
    const chatDir = getPilotProjectChatDir(root, root);
    await mkdir(chatDir, { recursive: true });
    const line = (sessionId: string): string =>
      JSON.stringify({
        type: "accepted_input",
        sessionId,
        turnId: "t1",
        sequence: 1,
        createdAt: "2026-08-19T00:00:00.000Z",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }) + "\n";
    await writeFile(join(chatDir, `${sanitizeSessionIdForPath("web:abc")}.jsonl`), line("web:abc"));
    await writeFile(join(chatDir, `${sanitizeSessionIdForPath("team:t1:m1")}.jsonl`), line("team:t1:m1"));

    const sessions = await listProjectSessions({ projectRoot: root, pilotHome: root });
    const ids = sessions.map(session => session.sessionId);
    assert.ok(ids.includes("web:abc"));
    assert.ok(!ids.includes("team:t1:m1"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
