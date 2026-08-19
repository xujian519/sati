/**
 * 集成：createLocalGateway 真实接线——成员创建 → 唤醒（fake model 驱动）→ 转录落盘 → 冷恢复扫描。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../../src/cli/createLocalGateway.js";
import { createTeamMember, wakeMember, type TeamTaskRow } from "../../../src/agent/team/index.js";
import type { ModelRuntime } from "../../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";

test("集成：成员唤醒经 submitTurn 整条链产出转录，冷恢复可续", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-integration-"));
  // createLocalGateway 对空目录启动要求 config 含 agent/model 段（缺失为致命诊断），
  // 写最小 sati.yaml 满足合法性；真实模型层被 __testModelFactory 替换，provider 仅为占位。
  await writeFile(
    join(root, "sati.yaml"),
    [
      "schemaVersion: 1",
      "agent:",
      "  model: deepseek/deepseek-v4-flash",
      "model:",
      "  providers:",
      "    deepseek:",
      "      apiKey: test-key",
      "      models:",
      "        deepseek-v4-flash: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    // 隔离外部环境（SATI_TEAMS_DB 等）：teams.db 必须落在 mkdtemp 临时目录内
    env: {},
    __testModelFactory: (): ModelRuntime => ({
      // 一次工具调用也不做的单轮模型：直接产出文本后结束
      stream: async function* () {
        yield { type: "text_delta", text: "已完成检索。" };
      },
      complete: async () => {
        throw new Error("unused");
      },
      getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
      getMultimodal: () => ({ input: ["text"] }),
      getProviderProtocol: () => undefined,
      getProviderBaseUrl: () => undefined,
    }),
  });
  try {
    // 接线：createLocalGateway 结果新增 team 子系统句柄（本任务加入）
    const team = result.teamSubsystem;
    assert.ok(team, "teamSubsystem 未接线");
    team.db.upsertTeam({
      id: "t1",
      name: "专利团队",
      captainSessionKey: "cap-1",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    createTeamMember(team.db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "patent-searcher",
      modelRoute: { provider: "fake", model: "fake-model" },
    });

    await wakeMember(team.db, result.gateway, "m1", "检索任务 T-1");
    assert.equal(team.db.getMember("m1")?.status, "idle");

    // 成员转录由 gateway 内部写入（team: 前缀 sessionKey → chatDir 根 .jsonl）
    const { readTranscript } = await import("../../../src/session/transcript/TranscriptReader.js");
    const { getPilotProjectChatDir } = await import("../../../src/pilot/index.js");
    const { sanitizeSessionIdForPath } = await import("../../../src/session/storage/ProjectSessionStorage.js");
    const chatDir = getPilotProjectChatDir(root, root);
    const transcript = await readTranscript(join(chatDir, `${sanitizeSessionIdForPath("team:t1:m1")}.jsonl`));
    assert.ok(transcript.entries.length > 0, "成员转录应有条目");
    assert.ok(transcript.entries.some(entry => entry.type === "accepted_input"));

    // 主会话扫描看不到成员（转录隔离生效）
    const { listProjectSessions } = await import("../../../src/session/storage/SessionList.js");
    const sessions = await listProjectSessions({ projectRoot: root, pilotHome: root });
    assert.ok(!sessions.some(session => session.sessionId === "team:t1:m1"));

    // 健康成员不会被冷恢复误扫（走接线面句柄，覆盖 hasPendingApprovals 闭包与日志路径）
    const scan = await team.runMemberScan();
    assert.equal(scan.resumed, 0);
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("集成：任务图变更 → 调度器原子认领 → 成员转录产出（fake model）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-integration2-"));
  // 最小 sati.yaml 与 M1 测试相同：createLocalGateway 对空目录要求 agent/model 段合法。
  await writeFile(
    join(root, "sati.yaml"),
    [
      "schemaVersion: 1",
      "agent:",
      "  model: deepseek/deepseek-v4-flash",
      "model:",
      "  providers:",
      "    deepseek:",
      "      apiKey: test-key",
      "      models:",
      "        deepseek-v4-flash: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: {},
    __testModelFactory: (): ModelRuntime => ({
      stream: async function* () {
        yield { type: "text_delta", text: "已完成。" };
      },
      complete: async () => {
        throw new Error("unused");
      },
      getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
      getMultimodal: () => ({ input: ["text"] }),
      getProviderProtocol: () => undefined,
      getProviderBaseUrl: () => undefined,
    }),
  });
  try {
    const team = result.teamSubsystem;
    team.db.upsertTeam({
      id: "t1",
      name: "专利团队",
      captainSessionKey: "cap-1",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    createTeamMember(team.db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "researcher",
      modelRoute: { provider: "fake", model: "fake-model" },
    });
    team.db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "检索 D2",
      description: "",
      status: "pending",
      dependencies: [],
      attempt: 0,
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });

    // onTaskGraphChanged 整条链：锁内原子认领 → wake 包装层 → wakeMember → submitTurn。
    // 注意：此调用会 await 完整成员回合（wake 全程持有团队锁——M2 既定锁语义）。
    await team.scheduler.onTaskGraphChanged("t1");

    // C2 后 re-claim 循环有界：M2 无 team 工具在回合内完成任务，回合结束 onMemberIdle
    // 会 re-claim 同一任务；attempt 达 maxAttempts（3）仍无进展 → 置 failed 终止循环。
    // 后台链在 microtask/事件循环推进（fire-and-forget），断言不依赖"返回后已完成 N 轮"
    // 的时序假设——轮询等待任务收敛到 failed（上限 400×25ms=10s：测试环境每轮回合
    // 触发 auto-compaction 需 1-2s，窗口须覆盖 3 轮）。
    let task: TeamTaskRow | undefined;
    for (let i = 0; i < 400; i += 1) {
      task = team.db.getTask("t1", "t1");
      if (task?.status === "failed") {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(task?.status, "failed", "attempt 达 maxAttempts 后任务置 failed（有界 re-claim 循环）");
    assert.ok(
      task !== undefined && task.attempt >= 1 && task.attempt <= task.maxAttempts,
      `attempt 应在 [1, maxAttempts] 内（实际 ${task?.attempt}）`,
    );

    // 成员回合真实跑完（fake model 单轮结束，含 re-claim 各轮）→ 转录落盘
    //（回合完成权威条目 turn_result；转录无 turn_completed 条目——那是 GatewayEvent
    // 类型，与 transcript entry 不同名）。
    const { readTranscript } = await import("../../../src/session/transcript/TranscriptReader.js");
    const { getPilotProjectChatDir } = await import("../../../src/pilot/index.js");
    const { sanitizeSessionIdForPath } = await import("../../../src/session/storage/ProjectSessionStorage.js");
    const chatDir = getPilotProjectChatDir(root, root);
    const transcript = await readTranscript(join(chatDir, `${sanitizeSessionIdForPath("team:t1:m1")}.jsonl`));
    assert.ok(transcript.entries.length > 0, "成员转录应有条目");
    assert.ok(
      transcript.entries.some(entry => entry.type === "turn_result"),
      "回合完成应落 turn_result",
    );
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("集成：stranded 任务（claimed + 成员 idle）→ runStrandedScan invalidate + re-claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-integration3-"));
  await writeFile(
    join(root, "sati.yaml"),
    [
      "schemaVersion: 1",
      "agent:",
      "  model: deepseek/deepseek-v4-flash",
      "model:",
      "  providers:",
      "    deepseek:",
      "      apiKey: test-key",
      "      models:",
      "        deepseek-v4-flash: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: {},
    __testModelFactory: (): ModelRuntime => ({
      stream: async function* () {
        yield { type: "text_delta", text: "已完成。" };
      },
      complete: async () => {
        throw new Error("unused");
      },
      getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
      getMultimodal: () => ({ input: ["text"] }),
      getProviderProtocol: () => undefined,
      getProviderBaseUrl: () => undefined,
    }),
  });
  try {
    const team = result.teamSubsystem;
    team.db.upsertTeam({
      id: "t1",
      name: "专利团队",
      captainSessionKey: "cap-1",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    createTeamMember(team.db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "researcher",
      modelRoute: { provider: "fake", model: "fake-model" },
    });
    // 制造 stranded 任务：claimed + assignee 成员 idle（进程崩溃残留形态）
    team.db.insertTask({
      id: "t1",
      teamId: "t1",
      subject: "检索 D2",
      description: "",
      status: "claimed",
      assigneeId: "m1",
      dependencies: [],
      attempt: 1,
      attemptId: "old-attempt",
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });

    const scan = await team.runStrandedScan();
    assert.equal(scan.stranded, 1);

    // invalidate（回 pending + 新 handoffId）→ kickMember 锁内 re-claim；C2 后有界循环：
    // re-claim 回合结束 turn_completed → onMemberIdle 继续 re-claim，attempt 达 maxAttempts
    // 仍无进展 → 置 failed 终止。后台链在 microtask/事件循环推进，断言不依赖时序假设——
    // 轮询等待任务收敛到 failed（上限 400×25ms=10s：测试环境每轮回合触发
    // auto-compaction 需 1-2s，窗口须覆盖 re-claim 各轮）。
    let task: TeamTaskRow | undefined;
    for (let i = 0; i < 400; i += 1) {
      task = team.db.getTask("t1", "t1");
      if (task?.status === "failed") {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(task?.status, "failed", "re-claim 有界循环后任务 failed");
    assert.ok(
      task !== undefined && task.attempt >= 2 && task.attempt <= task.maxAttempts,
      `attempt 应至少 re-claim 一轮且不超 maxAttempts（实际 ${task?.attempt}）`,
    );
    assert.ok(
      task?.attemptId !== undefined && task?.attemptId !== "old-attempt",
      "attemptId 应被替换（新 attempt 生效）",
    );
    assert.equal(task?.handoffId, undefined);
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
