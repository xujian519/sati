import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getPilotProjectChatDir } from "../../../src/pilot/index.js";
import { listProjectSessions } from "../../../src/session/storage/SessionList.js";

const tempDirs: string[] = [];

function makeProject(): { pilotHome: string; projectRoot: string } {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-session-list-"));
  tempDirs.push(pilotHome);
  return { pilotHome, projectRoot: "/tmp/project" };
}

function acceptedInputLine(sessionId: string, text: string, sequence = 1): string {
  return `${JSON.stringify({
    type: "accepted_input",
    sessionId,
    turnId: `t${sequence}`,
    sequence,
    createdAt: "2026-08-09T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  })}\n`;
}

function chatDirOf(project: { pilotHome: string; projectRoot: string }): string {
  return getPilotProjectChatDir(project.projectRoot, project.pilotHome);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SessionList 目录快照缓存", () => {
  it("空目录返回空列表", async () => {
    const project = makeProject();
    const sessions = await listProjectSessions(project);
    assert.deepEqual(sessions, []);
  });

  it("首次扫描返回会话摘要（accepted_input 文本）", async () => {
    const project = makeProject();
    const chatDir = chatDirOf(project);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "s1.jsonl"), acceptedInputLine("s1", "第一条消息"));

    const sessions = await listProjectSessions(project);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "s1");
    assert.equal(sessions[0]?.summary, "第一条消息");
  });

  it("TTL 内文件内容变化（文件名不变）仍返回缓存列表", async t => {
    // 固定 Date 时钟：避免真实时间越过 5s TTL 边界导致 flaky。
    const mock = t.mock.timers;
    mock.enable({ apis: ["Date"] });
    try {
      const project = makeProject();
      const chatDir = chatDirOf(project);
      mkdirSync(chatDir, { recursive: true });
      writeFileSync(join(chatDir, "s1.jsonl"), acceptedInputLine("s1", "旧标题"));

      const first = await listProjectSessions(project);
      assert.equal(first[0]?.summary, "旧标题");

      // 修改文件内容但保持文件名不变：TTL 内应命中缓存，不重新扫描文件。
      writeFileSync(join(chatDir, "s1.jsonl"), acceptedInputLine("s1", "新标题"));

      const second = await listProjectSessions(project);
      assert.equal(second[0]?.summary, "旧标题", "缓存命中时应返回旧摘要");
    } finally {
      mock.reset();
    }
  });

  it("新增会话文件触发快照失效，立即可见新会话", async () => {
    const project = makeProject();
    const chatDir = chatDirOf(project);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "s1.jsonl"), acceptedInputLine("s1", "第一个"));

    await listProjectSessions(project);
    writeFileSync(join(chatDir, "s2.jsonl"), acceptedInputLine("s2", "第二个"));

    const sessions = await listProjectSessions(project);
    assert.equal(sessions.length, 2, "新增文件应使快照失效并重新扫描");
    const ids = sessions.map(session => session.sessionId).sort();
    assert.deepEqual(ids, ["s1", "s2"]);
  });

  it("删除会话文件触发快照失效，列表同步减少", async () => {
    const project = makeProject();
    const chatDir = chatDirOf(project);
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "s1.jsonl"), acceptedInputLine("s1", "第一个"));
    writeFileSync(join(chatDir, "s2.jsonl"), acceptedInputLine("s2", "第二个"));

    await listProjectSessions(project);
    rmSync(join(chatDir, "s1.jsonl"));

    const sessions = await listProjectSessions(project);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "s2");
  });

  it("limit/offset 分页正确", async () => {
    const project = makeProject();
    const chatDir = chatDirOf(project);
    mkdirSync(chatDir, { recursive: true });
    // 设置递增 mtime：同一毫秒创建的文件 mtime 相同会导致排序不稳定（flaky）。
    for (let index = 1; index <= 5; index += 1) {
      const file = join(chatDir, `s${index}.jsonl`);
      writeFileSync(file, acceptedInputLine(`s${index}`, `会话${index}`));
      utimesSync(file, new Date(2026, 7, 9, 0, 0, index), new Date(2026, 7, 9, 0, 0, index));
    }

    // mtime 降序：s5 最新 → [s5, s4, s3, s2, s1]
    const page1 = await listProjectSessions({ ...project, limit: 2, offset: 0 });
    const page2 = await listProjectSessions({ ...project, limit: 2, offset: 2 });
    assert.deepEqual(
      page1.map(session => session.sessionId),
      ["s5", "s4"],
    );
    assert.deepEqual(
      page2.map(session => session.sessionId),
      ["s3", "s2"],
    );
  });
});
