/**
 * scanTeamMembers：冷恢复——db 枚举成员 → 读成员转录 → findOpenRequest 断点 → 重唤醒。
 * fixture 参照 tests/session/resume/task-resume-scanner.spec.ts（手写 JSON 条目）。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPilotProjectChatDir } from "../../../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../../../src/session/storage/ProjectSessionStorage.js";
import type { GatewayEvent, GatewaySubmitTurnInput } from "../../../../src/gateway/protocol/types.js";
import type { TeamEvent } from "../../../../src/agent/team/protocol/events.js";
import { TeamDb, createTeamMember, scanTeamMembers } from "../../../../src/agent/team/index.js";

type JsonEntry = Record<string, unknown>;

function baseEntry(
  sessionId: string,
  turnId: string,
  sequence: number,
  type: string,
  extra: JsonEntry = {},
): JsonEntry {
  return { type, sessionId, turnId, sequence, createdAt: "2026-08-19T00:00:00.000Z", ...extra };
}

function acceptedInput(sessionId: string, turnId: string, sequence: number, text: string): JsonEntry {
  return baseEntry(sessionId, turnId, sequence, "accepted_input", {
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
}

function requestHeader(sessionId: string, turnId: string, sequence: number): JsonEntry {
  return baseEntry(sessionId, turnId, sequence, "request_header", {
    header: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      systemPromptDigest: "abc",
      toolSchemaDigest: "def",
      messageCount: 1,
    },
  });
}

async function writeMemberTranscript(root: string, sessionKey: string, lines: JsonEntry[]): Promise<void> {
  const chatDir = getPilotProjectChatDir(root, root);
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`),
    lines.map(l => JSON.stringify(l)).join("\n") + "\n",
  );
}

function makeGateway(recorded: { messages: string[] }): {
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
} {
  return {
    async *submitTurn(input) {
      recorded.messages.push(input.message);
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
  };
}

test("冷恢复：(a) 形态断点成员被重唤醒，健康成员跳过", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-broken",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-healthy",
      roleSlug: "y",
      modelRoute: { provider: "p", model: "m" },
    });
    // 断点形态：request_header 已落、响应未到
    await writeMemberTranscript(root, "team:t1:m-broken", [
      acceptedInput("team:t1:m-broken", "t1", 1, "开始检索"),
      requestHeader("team:t1:m-broken", "t1", 2),
    ]);
    // 健康形态：accepted_input 后无 request_header（回合已正常结束）
    await writeMemberTranscript(root, "team:t1:m-healthy", [acceptedInput("team:t1:m-healthy", "t1", 1, "检索完成")]);

    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
      resumeMessage: "[team-resume] 继续未完成的工作",
    });
    assert.equal(result.scanned, 2);
    assert.equal(result.resumed, 1);
    assert.deepEqual(recorded.messages, ["[team-resume] 继续未完成的工作"]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("冷恢复：无转录的成员（从未唤醒）不报错跳过", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-fresh",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 0);
    assert.deepEqual(recorded.messages, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("冷恢复：退休成员不扫描", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-gone",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    db.insertRetired("team:t1:m-gone", "m-gone", "removed");
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
    });
    assert.equal(result.scanned, 0);
    assert.equal(result.resumed, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("冷恢复：有挂起审批的断点成员跳过", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-wait",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    await writeMemberTranscript(root, "team:t1:m-wait", [
      acceptedInput("team:t1:m-wait", "t1", 1, "开始撰写"),
      requestHeader("team:t1:m-wait", "t1", 2),
    ]);
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
      hasPendingApprovals: sessionKey => sessionKey === "team:t1:m-wait",
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 0);
    assert.deepEqual(recorded.messages, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("冷恢复：working 成员跳过（可能在跑回合，不得并发唤醒）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-working",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    db.updateMemberStatus("m-working", "working");
    // 转录是 (a) 形态断点——若没有状态检查会被误唤醒
    await writeMemberTranscript(root, "team:t1:m-working", [
      acceptedInput("team:t1:m-working", "t1", 1, "开始检索"),
      requestHeader("team:t1:m-working", "t1", 2),
    ]);
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
    });
    // scanned 为扫描范围数（同 hasPendingApprovals 跳过语义），working 成员在范围内但被跳过
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 0);
    assert.deepEqual(recorded.messages, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("冷恢复：onEvent 透传成员回合事件（I1 审批冒泡接线点）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  const seen: Array<{ memberId: string; eventType: string }> = [];
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-broken",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    // (a) 形态断点：request_header 已落、响应未到
    await writeMemberTranscript(root, "team:t1:m-broken", [
      acceptedInput("team:t1:m-broken", "t1", 1, "开始检索"),
      requestHeader("team:t1:m-broken", "t1", 2),
    ]);
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
      resumeMessage: "[team-resume] 继续未完成的工作",
      onEvent: (member, event) => seen.push({ memberId: member.id, eventType: event.type }),
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 1);
    // 唤醒成员回合的每事件透传给 onEvent（宿主接 TeamApprovalForwarder.handleMemberEvent
    // 即冷恢复 turn 的 approval_pending 冒泡到队长 watcher——M1 限制闭环）
    assert.deepEqual(seen, [{ memberId: "m-broken", eventType: "turn_completed" }]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("冷恢复：(b) 形态断点成员（流式残片）跳过，不自动续算", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-partial",
      roleSlug: "x",
      modelRoute: { provider: "p", model: "m" },
    });
    // (b) 形态：request_header 后已有部分 durable 消息（append-only 无法删除残片，不自动续算）
    await writeMemberTranscript(root, "team:t1:m-partial", [
      acceptedInput("team:t1:m-partial", "t1", 1, "开始撰写"),
      requestHeader("team:t1:m-partial", "t1", 2),
      baseEntry("team:t1:m-partial", "t1", 3, "durable_message", {
        message: { role: "assistant", content: [{ type: "text", text: "部分响应" }] },
      }),
    ]);
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 0);
    assert.deepEqual(recorded.messages, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("冷恢复：挂起审批成员（含 (b) 形态）emit member_stalled_approval 冒泡队长并跳过（P0-3）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-scan-"));
  const db = new TeamDb(join(root, "teams.db"));
  const recorded = { messages: [] as string[] };
  const stalled: Array<{ captain: string; event: TeamEvent }> = [];
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m-wait",
      roleSlug: "searcher",
      modelRoute: { provider: "p", model: "m" },
    });
    // 挂起审批成员几乎总是 (b) 形态（审批消息已持久化入库）——P0-3 前移审批判定前它会在
    // form 检查处被静默 continue。此处断言 emit member_stalled_approval 而非静默跳过。
    await writeMemberTranscript(root, "team:t1:m-wait", [
      acceptedInput("team:t1:m-wait", "t1", 1, "开始撰写"),
      requestHeader("team:t1:m-wait", "t1", 2),
      baseEntry("team:t1:m-wait", "t1", 3, "durable_message", {
        message: { role: "assistant", content: [{ type: "text", text: "部分响应" }] },
      }),
    ]);
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
      hasPendingApprovals: sessionKey => sessionKey === "team:t1:m-wait",
      emitTeamEvent: (captainSessionKey, event) => {
        stalled.push({ captain: captainSessionKey, event });
        return true;
      },
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 0);
    assert.deepEqual(recorded.messages, []);
    // 冒泡到队长会话（cap-1），成员来源 + 角色定位透传
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.captain, "cap-1");
    assert.equal(stalled[0]?.event.type, "member_stalled_approval");
    const stalledEvent = stalled[0]?.event as Extract<TeamEvent, { type: "member_stalled_approval" }>;
    assert.equal(stalledEvent.teamId, "t1");
    assert.equal(stalledEvent.memberId, "m-wait");
    assert.equal(stalledEvent.roleSlug, "searcher");
    assert.equal(stalledEvent.sessionKey, "team:t1:m-wait");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
