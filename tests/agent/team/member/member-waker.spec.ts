/**
 * wakeMember：构造 GatewaySubmitTurnInput 提交成员会话，drain 事件流，状态流转 idle→working→idle。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GatewayEvent, GatewaySubmitTurnInput } from "../../../../src/gateway/protocol/types.js";
import {
  TeamDb,
  TeamMemberNotFoundError,
  TeamMemberRetiredError,
  createTeamMember,
  wakeMember,
} from "../../../../src/agent/team/index.js";

type FakeGateway = {
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
};

function makeFakeGateway(recorded: { inputs: GatewaySubmitTurnInput[] }): FakeGateway {
  return {
    async *submitTurn(input) {
      recorded.inputs.push(input);
      yield { type: "turn_completed", usage: {}, finishReason: "completed" };
    },
  };
}

function setup(): { db: TeamDb; recorded: { inputs: GatewaySubmitTurnInput[] }; gateway: FakeGateway } {
  const db = new TeamDb(":memory:");
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "patent-searcher",
    modelRoute: { provider: "deepseek", model: "deepseek-v4-flash" },
  });
  const recorded = { inputs: [] as GatewaySubmitTurnInput[] };
  return { db, recorded, gateway: makeFakeGateway(recorded) };
}

test("唤醒：以成员 sessionKey + channelKey cron + canPrompt false 提交（含快照 modelRoute）", async () => {
  const { db, recorded, gateway } = setup();
  try {
    await wakeMember(db, gateway, "m1", "请继续检索任务 T-1");
    assert.equal(recorded.inputs.length, 1);
    assert.deepEqual(recorded.inputs[0], {
      sessionKey: "team:t1:m1",
      channelKey: "cron",
      message: "请继续检索任务 T-1",
      canPrompt: false,
      modelRoute: { provider: "deepseek", model: "deepseek-v4-flash" },
    });
  } finally {
    db.close();
  }
});

test("唤醒：状态流转 working → 完成后回 idle", async () => {
  const { db } = setup();
  try {
    let seenWorking = false;
    const instrumented: FakeGateway = {
      async *submitTurn() {
        seenWorking = db.getMember("m1")?.status === "working";
        yield { type: "turn_completed", usage: {}, finishReason: "completed" };
      },
    };
    await wakeMember(db, instrumented, "m1", "go");
    assert.equal(seenWorking, true);
    assert.equal(db.getMember("m1")?.status, "idle");
  } finally {
    db.close();
  }
});

test("唤醒：成员不存在抛 TeamMemberNotFoundError", async () => {
  const { db, gateway } = setup();
  try {
    await assert.rejects(() => wakeMember(db, gateway, "missing", "go"), TeamMemberNotFoundError);
  } finally {
    db.close();
  }
});

test("唤醒：退休成员拒绝并抛 TeamMemberRetiredError", async () => {
  const { db, gateway } = setup();
  try {
    db.insertRetired("team:t1:m1", "m1", "removed");
    await assert.rejects(() => wakeMember(db, gateway, "m1", "go"), TeamMemberRetiredError);
  } finally {
    db.close();
  }
});

test("唤醒：syntheticMessages 透传", async () => {
  const { db, recorded, gateway } = setup();
  try {
    await wakeMember(db, gateway, "m1", "go", {
      syntheticMessages: [{ text: "[team] 任务 T-1 已指派给你", purpose: "team-task" }],
    });
    assert.deepEqual(recorded.inputs[0]?.syntheticMessages, [
      { text: "[team] 任务 T-1 已指派给你", purpose: "team-task" },
    ]);
  } finally {
    db.close();
  }
});

test("唤醒：submitTurn 抛出时状态仍回 idle（finally 语义）", async () => {
  const { db } = setup();
  try {
    const throwing: FakeGateway = {
      async *submitTurn() {
        yield { type: "turn_completed", usage: {}, finishReason: "completed" };
        throw new Error("boom");
      },
    };
    await assert.rejects(() => wakeMember(db, throwing, "m1", "go"), /boom/);
    assert.equal(db.getMember("m1")?.status, "idle");
  } finally {
    db.close();
  }
});

test("wakeMember：成员快照 modelRoute 传入 submitTurn input（M4 消费点）", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-waker-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "researcher",
      modelRoute: { provider: "fake-provider", model: "fake-model" },
    });
    const recorded = { inputs: [] as GatewaySubmitTurnInput[] };
    const gateway = makeFakeGateway(recorded);
    await wakeMember(db, gateway, "m1", "followup");
    assert.equal(recorded.inputs[0]?.sessionKey, "team:t1:m1");
    assert.deepEqual(recorded.inputs[0]?.modelRoute, { provider: "fake-provider", model: "fake-model" });
    // 脏数据成员（modelRouteJson 非法）降级为空对象，不抛错
    db.insertMember({
      id: "m-bad",
      teamId: "t1",
      roleSlug: "researcher",
      modelRouteJson: "{broken",
      status: "idle",
      sessionKey: "team:t1:m-bad",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    await wakeMember(db, gateway, "m-bad", "followup");
    assert.equal(
      recorded.inputs[1]?.modelRoute,
      undefined,
      "脏数据降级：不传 modelRoute（不覆盖会话模型、不阻塞唤醒）",
    );
  } finally {
    db.close();
  }
});
