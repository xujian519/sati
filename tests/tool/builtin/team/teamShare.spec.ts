/**
 * 团队共享黑板工具测试（P1-4）：team_share_write / team_share_read。
 * 覆盖：写读回环、JSONL 落盘、去重幂等、身份/同队校验 fail-closed、事件发出、limit/key 读取。
 * 黑板路径经 context.cwd 派生（{cwd}/.sati/team-workspace/{teamId}/share.jsonl）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, createTeamMember, type TeamEvent, type TeamEventEmitter } from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import { teamSharePath } from "../../../../src/tool/builtin/team/teamShare.js";
import { createTeamShareWriteTool, createTeamShareReadTool } from "../../../../src/tool/builtin/team/index.js";

type Ctx = { sessionId: string; cwd: string; turnId?: string; currentToolCallId?: string };

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "sati-team-share-tool-"));
  const db = new TeamDb(join(cwd, "teams.db"));
  const events: TeamEvent[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const write = createTeamShareWriteTool({ db, emit });
  const read = createTeamShareReadTool({ db, emit });
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  return { cwd, db, events, write, read };
}

test("team_share_write：captain 写入 + 事件 + JSONL 落盘；team_share_read 读回", async () => {
  const { cwd, events, write, read } = setup();
  const ctx: Ctx = { sessionId: "cap-1", cwd, turnId: "turn-1", currentToolCallId: "call-1" };
  const out = await write.execute({ teamId: "t1", key: "检索范围", value: "CPC: A61K" }, ctx as never);
  const data = out.data as { key: string; writer: string; teamId: string; count: number };
  assert.equal(data.key, "检索范围");
  assert.equal(data.writer, "captain");
  assert.equal(data.teamId, "t1");
  assert.equal(data.count, 1);
  // 事件：team_share_updated 发出（含 teamId/writer/key）
  assert.equal(events.length, 1);
  const evt = events[0]!;
  assert.equal(evt.type, "team_share_updated");
  if (evt.type === "team_share_updated") {
    assert.equal(evt.teamId, "t1");
    assert.equal(evt.writer, "captain");
    assert.equal(evt.key, "检索范围");
  }
  // 落盘：teamSharePath 文件存在
  assert.ok(existsSync(teamSharePath(cwd, "t1")), "黑板 JSONL 落盘");

  // read（captain）读回
  const readOut = await read.execute({ teamId: "t1", key: "检索范围" }, ctx as never);
  const rdata = readOut.data as { entries: Array<{ key: string; value: string; writer: string }> };
  assert.equal(rdata.entries.length, 1);
  assert.equal(rdata.entries[0]!.value, "CPC: A61K");
  assert.equal(rdata.entries[0]!.writer, "captain");
});

test("team_share_write：成员写入（writer=memberId）；同 key 同 toolCallId 去重幂等", async () => {
  const { cwd, write, read } = setup();
  const ctx: Ctx = { sessionId: "team:t1:m1", cwd, turnId: "turn-1", currentToolCallId: "call-1" };
  await write.execute({ teamId: "t1", key: "结论", value: "D2 单独对比不覆盖区别特征" }, ctx as never);
  await write.execute({ teamId: "t1", key: "结论", value: "D2 单独对比不覆盖区别特征" }, ctx as never); // 完全重复
  const all = await read.execute({ teamId: "t1" }, ctx as never);
  const data = all.data as { keys: string[] };
  assert.deepEqual(data.keys, ["结论"], "去重后仅 1 键");
  const latest = await read.execute({ teamId: "t1", key: "结论" }, ctx as never);
  const ldata = latest.data as { entries: Array<{ writer: string }> };
  assert.equal(ldata.entries[0]!.writer, "m1", "成员写入 writer=memberId");
});

test("team_share_read：无 key 返回最新 limit 条（倒排）；limit 生效", async () => {
  const { cwd, write, read } = setup();
  const ctx: Ctx = { sessionId: "cap-1", cwd, turnId: "turn-1", currentToolCallId: "call-1" };
  for (let i = 0; i < 5; i += 1) {
    await write.execute({ teamId: "t1", key: `k${i}`, value: `v${i}` }, {
      ...ctx,
      currentToolCallId: `call-${i}`,
    } as never);
  }
  const all = await read.execute({ teamId: "t1" }, ctx as never);
  const data = all.data as { keys: string[] };
  assert.deepEqual(data.keys, ["k0", "k1", "k2", "k3", "k4"], "keys 首次出现序");
  const limited = await read.execute({ teamId: "t1", limit: 2 }, ctx as never);
  const ldata = limited.data as { entries: Array<{ key: string }> };
  assert.deepEqual(
    ldata.entries.map(e => e.key),
    ["k4", "k3"],
    "limit=2 返回最新 2 条（倒排）",
  );
});

test("team_share_read：无 key 同 key 多版本只返回最新值（不混入历史）", async () => {
  const { cwd, write, read } = setup();
  const base: Ctx = { sessionId: "team:t1:m1", cwd, turnId: "turn-1" };
  await write.execute({ teamId: "t1", key: "结论", value: "v1" }, { ...base, currentToolCallId: "call-1" } as never);
  await write.execute({ teamId: "t1", key: "结论", value: "v2" }, { ...base, currentToolCallId: "call-2" } as never);
  const all = await read.execute({ teamId: "t1" }, base as never);
  const data = all.data as { entries: Array<{ value: string }> };
  assert.equal(data.entries.length, 1, "同 key 覆盖后仅保留最新值");
  assert.equal(data.entries[0]!.value, "v2", "无 key 返回每 key 最新值");
});

test("team_share_write：校验与身份 fail-closed（空 key / 未知团队 / 畸形成员会话 / 异队成员 / 异队队长）", async () => {
  const { cwd, db, write } = setup();
  const base = { cwd, turnId: "turn-1", currentToolCallId: "call-1" };
  const capCtx = { sessionId: "cap-1", ...base } as Ctx;
  const memberCtx = { sessionId: "team:t1:m1", ...base } as Ctx;
  // 空 key / 纯空白
  await assert.rejects(
    () => write.execute({ teamId: "t1", key: "   ", value: "v" }, capCtx as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "invalid_tool_input",
  );
  // 未知团队
  await assert.rejects(
    () => write.execute({ teamId: "t9", key: "k", value: "v" }, capCtx as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  // 畸形成员会话（team:t1:）fail-closed
  await assert.rejects(
    () => write.execute({ teamId: "t1", key: "k", value: "v" }, { sessionId: "team:t1:", ...base } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_actor_unknown",
  );
  // 异队成员（m1 属于 t1，用 t2 写入）必须拒绝——t2 只需存在（write 路径先验团队，
  // 再 resolveWriter 判同队）；m1 全局唯一已在 setup 建，不能重复 createTeamMember。
  db.upsertTeam({ id: "t2", name: "t2", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
  await assert.rejects(
    () => write.execute({ teamId: "t2", key: "k", value: "v" }, memberCtx as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
  // 异队队长（cap-1 属于 t1，用 t2 写入）必须拒绝（requireTeamCaptain 同队校验）
  await assert.rejects(
    () => write.execute({ teamId: "t2", key: "k", value: "v" }, capCtx as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_share_read：畸形会话/异队成员/未知团队同样 fail-closed", async () => {
  const { cwd, db, read } = setup();
  const capCtx = { sessionId: "cap-1", cwd } as Ctx;
  await assert.rejects(
    () => read.execute({ teamId: "t1" }, { sessionId: "team:t1:", cwd } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_actor_unknown",
  );
  await assert.rejects(
    () => read.execute({ teamId: "t9" }, capCtx as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  // 异队成员读取拒绝（read 路径先 requireTeamMember 判同队，t2 无需存在）
  db.upsertTeam({ id: "t2", name: "t2", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z" });
  await assert.rejects(
    () => read.execute({ teamId: "t2" }, { sessionId: "team:t1:m1", cwd } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
});
