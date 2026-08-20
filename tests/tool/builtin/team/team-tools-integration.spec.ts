/**
 * M3 Task 12：工具驱动全链集成——真实 createLocalGateway（fake model）驱动完整 agent 回路
 * + 工具 factory 直调 execute。三个测试：
 *
 * 1. 工具驱动全链：建队 → 招募（team_add_member）→ 建任务 A（无依赖）+ 任务 B（依赖 A）→
 *    调度器认领 → 成员回合内 fake model 发 tool_call 调 team_update_task(completed) →
 *    A 终结 + 下游 B 解锁 → 有界重派收敛 failed → 归档（团队归档 + 成员退休）。
 * 2. isCaptainOnline 离线暂停：captain 显式离线（presence touch+close 超宽限窗）→
 *    新任务不被认领（正对照：在线期任务被认领）。
 * 3. scanner 冷恢复回合结束续派：手写 form "a" 断点转录 + 已认领任务（attemptId "old-attempt"）→
 *    runMemberScan 重唤醒 → 回合结束后 handleMemberTurnCompleted → 任务被 re-claim 并最终
 *    failed 收敛（钉住 createLocalGateway runMemberScan 的 onEvent 实参映射 member.teamId/member.id）。
 *
 * 关键接线点（与既有 M1/M2 集成用例同源）：
 * - fake model 实现完整 ModelRuntime 契约（stream/complete/getCapabilities/getMultimodal/
 *   getProviderProtocol/getProviderBaseUrl）；DEFAULT_MODEL_CAPABILITIES.supportsToolUse=false，
 *   需要发工具调用的模型显式覆盖为 true。
 * - attemptId 闭包注入：模型 factory 在 createLocalGateway 内被调用，此时 db 句柄尚不可得——
 *   用 let 绑定 + getAttemptId 闭包在调度器 beginTaskAttempt 写入后读取；取不到时以空串哨兵
 *   让 execute 报 stale-attempt（宁可失败暴露，不静默通过）。
 * - 角色注册：syncRoleDefinitions 在首个会话准备时整体重注册；team_add_member 之前的显式
 *   registerRoleDefinition 使用真实 skill 角色 patent-retriever（重注册后仍存活）。
 * - 权限：DEFAULT skipPermissions=true → bypassPermissions，成员回合内非只读工具可执行。
 * - 事件：factory 工具 emit 用 `() => true`（事件链路由 gateway 集成用例覆盖）。
 * - 轮询 400×25ms（10s 上限）与既有团队集成用例同款。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway, type CreateLocalGatewayResult } from "../../../../src/cli/createLocalGateway.js";
import { TeamDb, createTeamMember, memberSessionKey, type TeamScheduler } from "../../../../src/agent/team/index.js";
import type { TeamEventEmitter } from "../../../../src/agent/team/protocol/events.js";
import { SESSION_PRESENCE_GRACE_MS } from "../../../../src/gateway/server/sessionPresence.js";
import type { ModelRuntime } from "../../../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../../src/model/protocol/capabilities.js";
import type { CanonicalModelRequest } from "../../../../src/model/protocol/canonical.js";
import { registerRoleDefinition } from "../../../../src/agent/sub/builtinSubagentTypes.js";
import {
  createTeamAddMemberTool,
  createTeamArchiveTool,
  createTeamCreateTaskTool,
  createTeamCreateTool,
  createTeamUpdateTaskTool,
} from "../../../../src/tool/builtin/team/index.js";
import { getPilotProjectChatDir } from "../../../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../../../src/session/storage/ProjectSessionStorage.js";

const TEAM_ID = "t1";
const CAPTAIN_SESSION = "cap-1";
const ROLE_SLUG = "patent-retriever"; // 真实 skill 角色：首会话 syncRoleDefinitions 重注册后仍存活

/**
 * 挂起等待上限：与 pollUntil 默认 400×25ms（10s）轮询上限同值。hang 链条
 * （ticket 已设置 → 首调必发 tool_call → 回填续调必走 hangCount===1 分支）当前
 * 是确定的，若未来重构使续调不挂起，裸 await 会无限挂起等 CI 超时——故带超时等待。
 */
const HANG_TIMEOUT_MS = 10_000;

const SATI_YAML = [
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
].join("\n");

/** 最小 pilot 工程 + 真实 gateway（fake model）。 */
async function makeGateway(
  label: string,
  modelFactory: () => ModelRuntime,
): Promise<{ result: CreateLocalGatewayResult; root: string }> {
  const root = await mkdtemp(join(tmpdir(), `sati-team-tools-${label}-`));
  await writeFile(join(root, "sati.yaml"), SATI_YAML, "utf8");
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: {},
    __testModelFactory: modelFactory,
  });
  return { result, root };
}

async function disposeGateway(result: CreateLocalGatewayResult, root: string): Promise<void> {
  result.dispose();
  await rm(root, { recursive: true, force: true });
}

async function pollUntil(condition: () => boolean | undefined, iterations = 400, intervalMs = 25): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`pollUntil 超时（${iterations}×${intervalMs}ms）`);
}

/** 纯文本模型：不发工具调用（M1/M2 集成用例同款）。 */
function textOnlyModel(): ModelRuntime {
  return {
    stream: async function* () {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "已完成检索，本回合结束。" };
      yield { type: "message_end", finishReason: "stop" };
    },
    complete: async () => {
      throw new Error("unused");
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

/**
 * 成员回合内完成任务模型：新回合首调发 tool_call 调 team_update_task(completed)，
 * ticket 由 getTicket 闭包在成员回合流式构造时读取（beginTaskAttempt 写入 attemptId 之后）：
 * - ticket 未就绪（任务尚未创建）或末条消息为 tool_result（工具结果回填后的续调）→
 *   只回文本 stop，避免无限工具循环；
 * - attemptId 取不到（调度时序竞态）→ 空串哨兵让 execute 报 stale-attempt，
 *   宁可失败暴露也不静默通过。
 * 模型实例在 createLocalGateway 内 resolve 时一次性创建（runtime 缓存）——
 * teamId/taskId 此刻尚不可知，故一律经闭包在请求时刻读取。
 */
function completingMemberModel(
  getTicket: () => { teamId: string; taskId: string; attemptId: string | undefined } | undefined,
): ModelRuntime {
  return {
    stream: async function* (request: CanonicalModelRequest) {
      yield { type: "message_start", role: "assistant" };
      const last = request.messages[request.messages.length - 1];
      const lastHasToolResult = last?.content.some(block => block.type === "tool_result") ?? false;
      const ticket = getTicket();
      if (!lastHasToolResult && ticket !== undefined) {
        yield {
          type: "tool_call_end",
          toolCall: {
            id: "team-tools-integration-call",
            name: "team_update_task",
            input: {
              teamId: ticket.teamId,
              taskId: ticket.taskId,
              status: "completed",
              attemptId: ticket.attemptId ?? "",
              output: `集成测试完成任务 ${ticket.taskId}`,
            },
          },
        };
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        yield { type: "text_delta", text: "任务已完成，本回合结束。" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
    complete: async () => {
      throw new Error("unused");
    },
    getCapabilities: () => ({
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: false,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 64000,
      maxOutputTokens: 8192,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

/**
 * 成员回合内失败→转派后完成模型（M4 Task 11 自动转派全链）：新回合首调发 tool_call
 * 调 team_update_task——attempt 1 发 failed（未耗尽 maxAttempts，可自动转派），
 * attempt >= 2 发 completed（接手成员认领后完成）；工具结果回填后的首个续调
 * await hang 挂起（成员回合未结束、成员保持 working——测试线程在转派完成后
 * releaseHang 放行，避免接手成员的回合在同一 hang 上死锁：仅首个回填挂起，
 * 后续回合直接通过）。其余语义与 completingMemberModel 同款（ticket 闭包实时
 * 读 attemptId/attempt、空串哨兵 fail-closed）。
 */
function retryThenCompleteModel(
  getTicket:
    | (() =>
        | {
            teamId: string;
            taskId: string;
            attemptId: string | undefined;
            attempt: number;
          }
        | undefined)
    | undefined,
  hang: Promise<void>,
  onFirstHang: () => void,
): ModelRuntime {
  let hangCount = 0;
  return {
    stream: async function* (request: CanonicalModelRequest) {
      yield { type: "message_start", role: "assistant" };
      const last = request.messages[request.messages.length - 1];
      const lastHasToolResult = last?.content.some(block => block.type === "tool_result") ?? false;
      const ticket = getTicket?.();
      if (!lastHasToolResult && ticket !== undefined) {
        const status = ticket.attempt <= 1 ? "failed" : "completed";
        yield {
          type: "tool_call_end",
          toolCall: {
            id: "retry-member-call",
            name: "team_update_task",
            input: {
              teamId: ticket.teamId,
              taskId: ticket.taskId,
              status,
              attemptId: ticket.attemptId ?? "",
              ...(status === "failed"
                ? { reason: "集成测试模拟失败（未耗尽，可自动转派）" }
                : { output: `集成测试转派后完成任务 ${ticket.taskId}` }),
            },
          },
        };
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        hangCount += 1;
        if (hangCount === 1) {
          onFirstHang();
          await hang; // 首个回填挂起：m1 回合停在此处，等测试触发转派后放行
        }
        yield { type: "text_delta", text: "本回合结束。" };
        yield { type: "message_end", finishReason: "stop" };
      }
    },
    complete: async () => {
      throw new Error("unused");
    },
    getCapabilities: () => ({
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: false,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 64000,
      maxOutputTokens: 8192,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

/** 团队工具 factory 直调（事件链路由 emit 用 no-op，由 gateway 集成用例覆盖）。 */
function makeTools(db: TeamDb, scheduler: TeamScheduler) {
  const emit: TeamEventEmitter = () => true;
  return {
    teamCreate: createTeamCreateTool({ db, scheduler, emit }),
    teamAddMember: createTeamAddMemberTool({ db, scheduler, emit }),
    teamCreateTask: createTeamCreateTaskTool({ db, scheduler, emit }),
    teamUpdateTask: createTeamUpdateTaskTool({ db, scheduler, emit }),
    teamArchive: createTeamArchiveTool({ db, scheduler, emit }),
  };
}

// 转录断点条目（form "a"：request_header 已落、无任何 durable 消息）——member-scanner 用例同款
type JsonEntry = Record<string, unknown>;

function baseEntry(sessionId: string, turnId: string, sequence: number, type: string): JsonEntry {
  return { type, sessionId, turnId, sequence, createdAt: "2026-08-19T00:00:00.000Z" };
}

async function writeMemberTranscript(root: string, sessionKey: string, lines: JsonEntry[]): Promise<void> {
  const chatDir = getPilotProjectChatDir(root, root);
  await mkdir(chatDir, { recursive: true });
  await writeFile(
    join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`),
    lines.map(l => JSON.stringify(l)).join("\n") + "\n",
  );
}

test("工具驱动全链：建队→招募→建任务→调度器认领→成员回合 team_update_task 完成→下游解锁→归档", async () => {
  // 模型实例在 createLocalGateway 内 resolve 时一次性创建（runtime 缓存）——teamId/taskId
  // 此刻尚不可知：经 getTicket 闭包在成员回合流式构造时读取（届时 db 句柄与任务均已就绪）。
  // eslint-disable-next-line prefer-const -- assigned once later; closures above reference the binding before assignment
  let teamDb: TeamDb;
  let ticket: { teamId: string; taskId: string } | undefined;
  const memberModel = completingMemberModel(() => {
    if (ticket === undefined) return undefined;
    // attemptId 由调度器 beginTaskAttempt 在认领时写入，此处每次请求实时读取
    return { ...ticket, attemptId: teamDb.getTask(ticket.teamId, ticket.taskId)?.attemptId };
  });
  const { result, root } = await makeGateway("fullchain", () => memberModel);
  teamDb = result.teamSubsystem.db;
  const teamScheduler = result.teamSubsystem.scheduler;
  const tools = makeTools(teamDb, teamScheduler);
  // 会话准备前角色表尚未从 skills 加载（syncRoleDefinitions 在首个会话准备时执行）：
  // 显式注册真实 skill 角色，team_add_member 的 requireRegisteredRole 才可通过。
  registerRoleDefinition({
    id: ROLE_SLUG,
    description: "专利检索型团队成员（集成测试显式注册，真实链路由首会话 syncRoleDefinitions 从 skills 重注册）",
    allowedTools: ["*"],
    visibleDomains: ["patent", "search", "team"],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: false,
    systemPromptSuffix: "",
  });
  try {
    const captainCtx = { sessionId: CAPTAIN_SESSION } as never;

    // 建队 + 招募（management 面：team_create / team_add_member）
    const created = await tools.teamCreate.execute({ name: "专利检索团队" }, captainCtx);
    const teamId = created.data!.teamId;
    assert.notEqual(teamId, "");
    const added = await tools.teamAddMember.execute({ teamId, roleSlug: ROLE_SLUG }, captainCtx);
    const memberId = added.data!.memberId;
    assert.match(memberId, /^m-/);

    // 建任务：A 无依赖、B 依赖 A（阻塞计数 1，解锁前不被调度）
    const taskA = await tools.teamCreateTask.execute({ teamId, subject: "检索对比文件 A" }, captainCtx);
    const taskAId = taskA.data!.taskId;
    // M2（T12 复审）：ticket 在创建返回后立即就绪——attemptId 由 getTicket 闭包在每次
    // 模型请求时实时读取（beginTaskAttempt 认领时写入），无需等认领轮询，消除首回合
    // 时序隐含竞态（ticket 赋值是同步的，先于任何异步 kickMember 唤醒链）。
    ticket = { teamId, taskId: taskAId };
    const taskB = await tools.teamCreateTask.execute(
      { teamId, subject: "撰写创造性分析 B", dependencies: [taskAId] },
      captainCtx,
    );
    const taskBId = taskB.data!.taskId;
    assert.equal(taskB.data!.blockedByCount, 1);
    assert.equal(teamDb.getTask(teamId, taskBId)?.status, "pending");

    // 调度器认领 A（kickTeam → kickMember → beginTaskAttempt 写 attemptId）；
    // 成员回合的模型请求经 getTicket 闭包实时读取 attemptId
    await pollUntil(() => teamDb.getTask(teamId, taskAId)?.status === "claimed");

    // 成员回合内 fake model 发 tool_call 调 team_update_task(completed) → A 终结（attempt 1）
    await pollUntil(() => teamDb.getTask(teamId, taskAId)?.status === "completed");
    const aFinal = teamDb.getTask(teamId, taskAId)!;
    assert.equal(aFinal.status, "completed");
    assert.equal(aFinal.attempt, 1);
    assert.equal(aFinal.assigneeId, memberId);
    assert.match(aFinal.output ?? "", /集成测试完成任务/);

    // 下游解锁：A 完成 → blockedByCount 重算 → B 被调度器认领
    await pollUntil(() => teamDb.getTask(teamId, taskBId)?.status === "claimed");
    assert.equal(teamDb.getTask(teamId, taskBId)?.blockedByCount, 0);

    // B 的回合内模型仍向已终结的 A 调 team_update_task → stale-attempt（fail-closed）；
    // B 自身不再被完成，沿有界重派循环（attempt 1→3）收敛 failed
    await pollUntil(() => teamDb.getTask(teamId, taskBId)?.status === "failed");
    const bFinal = teamDb.getTask(teamId, taskBId)!;
    assert.equal(bFinal.status, "failed");
    assert.equal(bFinal.attempt, 3);
    assert.equal(bFinal.assigneeId, memberId);

    // 归档：团队归档 + 成员退休
    await tools.teamArchive.execute({ teamId }, captainCtx);
    assert.equal(teamDb.isArchived(teamId), true);
    assert.equal(teamDb.isRetired(memberSessionKey(teamId, memberId)), true);
  } finally {
    await disposeGateway(result, root);
  }
});

test("isCaptainOnline 离线暂停：队长离线超宽限窗后新任务不被认领", async () => {
  const { result, root } = await makeGateway("offline", textOnlyModel);
  const teamDb = result.teamSubsystem.db;
  const teamScheduler = result.teamSubsystem.scheduler;
  const presence = result.sessionPresence;
  const tools = makeTools(teamDb, teamScheduler);
  const captainCtx = { sessionId: CAPTAIN_SESSION } as never;
  try {
    teamDb.upsertTeam({
      id: TEAM_ID,
      name: "离线暂停团队",
      captainSessionKey: CAPTAIN_SESSION,
      createdAt: new Date().toISOString(),
    });
    createTeamMember(teamDb, {
      teamId: TEAM_ID,
      memberId: "m1",
      roleSlug: "search",
      modelRoute: { provider: "deepseek", model: "deepseek-v4-flash" },
    });

    // 正对照：队长在线 → 任务 T1 正常被认领
    presence.touch(CAPTAIN_SESSION, Date.now());
    const t1 = await tools.teamCreateTask.execute({ teamId: TEAM_ID, subject: "在线期任务 T1" }, captainCtx);
    await pollUntil(() => teamDb.getTask(TEAM_ID, t1.data!.taskId)?.status === "claimed");
    assert.equal(teamDb.getMember("m1")?.status, "working");

    // 队长显式离线且超过宽限窗（S1 后 touch 同步刷新面板时间线——离线须「全静默」：
    // 直连关闭与最后帧均早于 now-GRACE → isActive=false，持久 known-offline）
    const offlineSince = Date.now() - (SESSION_PRESENCE_GRACE_MS + 1_000);
    presence.touch(CAPTAIN_SESSION, offlineSince);
    presence.close(CAPTAIN_SESSION, offlineSince);
    assert.equal(presence.isActive(CAPTAIN_SESSION), false);

    // 新任务 T2：kickTeam/kickMember 均命中 isCaptainOnline=false → 不派发，保持 pending
    const t2 = await tools.teamCreateTask.execute({ teamId: TEAM_ID, subject: "离线期任务 T2" }, captainCtx);
    // 在途 T1 回合跑完回 idle（onMemberIdle → kickMember 被离线闸挡住，无新派发）
    await pollUntil(() => teamDb.getMember("m1")?.status === "idle");
    // 稳定窗口内 T2 保持 pending、T1 保持 claimed（离线暂停语义稳定）
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(teamDb.getTask(TEAM_ID, t2.data!.taskId)?.status, "pending");
    assert.equal(teamDb.getTask(TEAM_ID, t1.data!.taskId)?.status, "claimed");
    assert.equal(teamDb.getMember("m1")?.status, "idle");
  } finally {
    await disposeGateway(result, root);
  }
});

test("scanner 冷恢复回合结束续派：断点成员被重唤醒，未完成任务沿有界重派收敛 failed", async () => {
  const { result, root } = await makeGateway("coldrecovery", textOnlyModel);
  const teamDb = result.teamSubsystem.db;
  try {
    // 启动期 fire-and-forget 扫描（runMemberScan + runStrandedScan）完成信号：空库扫描
    // 立即空转结束，await 后再写入成员/任务/转录——避免启动 stranded 扫描 invalidate+re-claim
    // 本测试的遗留任务（会使显式 runMemberScan 的 resumed 恒为 0，且转录写入与在途回合竞态）。
    // T12 复审 M4：显式信号取代 setTimeout 排干——与实现细节解耦，scanTeamMembers 未来
    // 增加异步读也不引入竞态。
    await result.teamSubsystem.startupScanDone;
    teamDb.upsertTeam({
      id: TEAM_ID,
      name: "冷恢复团队",
      captainSessionKey: CAPTAIN_SESSION,
      createdAt: new Date().toISOString(),
    });
    const sessionKey = memberSessionKey(TEAM_ID, "m1");
    createTeamMember(teamDb, {
      teamId: TEAM_ID,
      memberId: "m1",
      roleSlug: "search",
      modelRoute: { provider: "deepseek", model: "deepseek-v4-flash" },
    });
    // 遗留任务：attempt 1 已认领但回合中断（转录为 form "a" 断点：accepted_input + request_header，无 durable 消息）
    teamDb.insertTask({
      id: "task-1",
      teamId: TEAM_ID,
      subject: "中断前的检索任务",
      description: "",
      status: "claimed",
      dependencies: [],
      attempt: 1,
      attemptId: "old-attempt",
      reassigning: false,
      blockedByCount: 0,
      maxAttempts: 3,
      assigneeId: "m1",
      handoffId: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeMemberTranscript(root, sessionKey, [
      {
        ...baseEntry(sessionKey, "turn-1", 1, "accepted_input"),
        messages: [{ role: "user", content: [{ type: "text", text: "开始检索" }] }],
      },
      {
        ...baseEntry(sessionKey, "turn-1", 2, "request_header"),
        header: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          systemPromptDigest: "abc",
          toolSchemaDigest: "def",
          messageCount: 1,
        },
      },
    ]);

    // 冷恢复：runMemberScan 重唤醒断点成员（启动期 fire-and-forget 扫描已空跑，此处显式触发）
    const scan = await result.teamSubsystem.runMemberScan();
    assert.equal(scan.resumed, 1);

    // 恢复回合（纯文本）结束 → 网关 onEvent turn_completed → handleMemberTurnCompleted →
    // 任务非终态 → onMemberIdle → kickMember re-claim（attempt 2、3，attemptId 换新）→
    // attempt 3 达 maxAttempts → failed 收敛
    await pollUntil(() => teamDb.getTask(TEAM_ID, "task-1")?.status === "failed");
    const final = teamDb.getTask(TEAM_ID, "task-1")!;
    assert.equal(final.status, "failed");
    assert.equal(final.attempt, 3);
    assert.notEqual(final.attemptId, "old-attempt"); // 重派路径使用全新 attemptId
    assert.equal(final.handoffId, undefined);
    assert.equal(teamDb.getMember("m1")?.status, "idle");
  } finally {
    await disposeGateway(result, root);
  }
});

/**
 * 失败任务自动转派全链（M4 Task 11）：m1 回合内 team_update_task(failed)（未耗尽）
 * → 测试线程触发 onTaskGraphChanged → 调度器锁内重置回池（task_retried）→ m2
 * （idle）认领同一任务 attempt 2 → m2 回合内 team_update_task(completed) 完成。
 * 断言行为面（assignee m2 / attempt 2 / attemptId 换新 / 最终 completed）+ m2 收到
 * assignmentPrompt（submitTurn input.message 透传，转录 accepted_input 含 Attempt: 2）。
 *
 * 时序设计（关键）：team_update_task(failed) 工具自身会 fire-and-forget 触发
 * onTaskGraphChanged，若 m2 已就位会在 m1 回合进行中就完成转派（failed 中间态
 * 极短、不可轮询）。故建队时**只加 m1**：failed 后 kickTeam 无其他 idle 成员可派，
 * failed 状态稳定可断言；随后测试线程 addMember(m2)（不触发调度）并手动
 * onTaskGraphChanged 完成转派，时序完全可控。m1 模型在工具结果回填后 await hang
 * （回合未结束、m1 保持 working、kickTeam 跳过），测试在转派完成后 releaseHang
 * 放行；m2 回填续调不挂起（hangCount>1 直接过）——避免 m2 回合在 hang 上死锁。
 */
test("失败任务自动转派：成员回合置 failed（未耗尽）→ 调度器重置回池 → 其他 idle 成员认领", async () => {
  // 模型闭包在 createLocalGateway 内部创建（db 句柄尚不可得）：经容器延迟引用——
  // const 直接捕获会触发 TS2454（use before assigned），let 触发 ESLint prefer-const。
  const refs: { db: TeamDb | undefined } = { db: undefined };
  let ticket: { teamId: string; taskId: string } | undefined;
  // 在 Promise executor 中同步赋值（releaseHang/firstHangWaited 在构造完成时已就绪）
  let releaseHang!: () => void;
  let firstHangWaited!: () => void;
  const hang = new Promise<void>(resolve => {
    releaseHang = resolve;
  });
  const firstHang = new Promise<void>(resolve => {
    firstHangWaited = resolve;
  });
  const memberModel = retryThenCompleteModel(
    () => {
      if (ticket === undefined) return undefined;
      const task = refs.db?.getTask(ticket.teamId, ticket.taskId);
      if (task === undefined) return undefined;
      return { ...ticket, attemptId: task.attemptId, attempt: task.attempt };
    },
    hang,
    firstHangWaited,
  );
  const { result, root } = await makeGateway("autoretry", () => memberModel);
  const teamDb = result.teamSubsystem.db;
  refs.db = teamDb;
  const teamScheduler = result.teamSubsystem.scheduler;
  const tools = makeTools(teamDb, teamScheduler);
  // 会话准备前角色表尚未从 skills 加载：显式注册真实 skill 角色（同 fullchain 用例）。
  registerRoleDefinition({
    id: ROLE_SLUG,
    description: "专利检索型团队成员（自动转派集成测试显式注册）",
    allowedTools: ["*"],
    visibleDomains: ["patent", "search", "team"],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: false,
    systemPromptSuffix: "",
  });
  try {
    const captainCtx = { sessionId: CAPTAIN_SESSION } as never;
    const created = await tools.teamCreate.execute({ name: "自动转派团队" }, captainCtx);
    const teamId = created.data!.teamId;
    // 先只加 m1：failed 后无人可派，failed 中间态稳定（否则 failed 工具的
    // fire-and-forget onTaskGraphChanged 会在 m1 回合进行中立即完成转派）。
    const m1 = (await tools.teamAddMember.execute({ teamId, roleSlug: ROLE_SLUG }, captainCtx)).data!.memberId;
    const taskOut = await tools.teamCreateTask.execute({ teamId, subject: "失败转派任务 T" }, captainCtx);
    const taskId = taskOut.data!.taskId;
    ticket = { teamId, taskId };

    // m1 回合内 team_update_task(failed)：等任务 failed（attempt 1、assignee m1）
    await pollUntil(() => teamDb.getTask(teamId, taskId)?.status === "failed");
    const failedTask = teamDb.getTask(teamId, taskId)!;
    assert.equal(failedTask.assigneeId, m1, "首轮由 m1 认领");
    assert.equal(failedTask.attempt, 1);
    assert.ok(failedTask.attemptId, "首轮 attemptId 存在");
    const oldAttemptId = failedTask.attemptId!;
    // m1 已进入挂起（回合未结束，m1 保持 working，kickTeam 跳过）；带超时等待，
    // 防续调挂起逻辑未来被重构后本测试无限挂起（与文件内轮询点 10s 上限一致）。
    await Promise.race([
      firstHang,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("firstHang 超时（m1 未进入挂起）")), HANG_TIMEOUT_MS),
      ),
    ]);

    // 测试线程补招 m2（addMember 不触发调度）→ 手动触发任务图变更：
    // m2（idle）锁内重置 + 认领同一任务 attempt 2，回合内
    // team_update_task(completed) 完成（wake 链 await 完整成员回合）
    const m2 = (await tools.teamAddMember.execute({ teamId, roleSlug: ROLE_SLUG }, captainCtx)).data!.memberId;
    assert.notEqual(m1, m2, "双成员");
    await teamScheduler.onTaskGraphChanged(teamId);
    await pollUntil(() => teamDb.getTask(teamId, taskId)?.status === "completed");
    const final = teamDb.getTask(teamId, taskId)!;
    assert.equal(final.status, "completed", "转派后任务完成");
    assert.equal(final.assigneeId, m2, "转派给 idle 的 m2");
    assert.equal(final.attempt, 2, "attempt 由 beginTaskAttempt 递增到 2");
    assert.ok(final.attemptId !== undefined && final.attemptId !== oldAttemptId, "attemptId 换新");

    // 放行 m1 回合收尾（turn 完成 → onMemberIdle → kickMember 无任务可派，m1 回 idle；
    // 不覆盖转派结果）。m1 idle 的写入发生在 onMemberIdle 内部（fire-and-forget），
    // 其尾部 kickMember 可能晚于 idle 轮询点完成——加短稳定窗钉住"不覆盖"断言，
    // 防迟到的锁内写入在断言后才落盘而未被捕获。
    releaseHang();
    await pollUntil(() => teamDb.getMember(m1)?.status === "idle");
    await new Promise(resolve => setTimeout(resolve, 200)); // 让 fire-and-forget kickMember 收尾
    assert.equal(teamDb.getTask(teamId, taskId)?.status, "completed", "m1 收尾不覆盖转派结果");

    // m2 收到的 assignmentPrompt 经 submitTurn input.message 透传进成员回合：
    // 转录 accepted_input 应含 "Attempt: 2" 与新 attemptId
    const { readTranscript } = await import("../../../../src/session/transcript/TranscriptReader.js");
    const { getPilotProjectChatDir } = await import("../../../../src/pilot/index.js");
    const { sanitizeSessionIdForPath } = await import("../../../../src/session/storage/ProjectSessionStorage.js");
    const chatDir = getPilotProjectChatDir(root, root);
    const m2Path = join(chatDir, `${sanitizeSessionIdForPath(memberSessionKey(teamId, m2))}.jsonl`);
    let acceptedInput: unknown;
    for (let i = 0; i < 400; i += 1) {
      try {
        const t = await readTranscript(m2Path);
        acceptedInput = t.entries.find(e => e.type === "accepted_input");
        if (acceptedInput !== undefined) break;
      } catch {
        // 转录尚未落盘，重试
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(acceptedInput !== undefined, "m2 回合应有 accepted_input 转录");
    const text = JSON.stringify(acceptedInput);
    assert.match(text, /Attempt: 2/, "m2 assignmentPrompt 含 attempt 2");
    assert.match(text, new RegExp(`Attempt id: ${final.attemptId}`), "m2 assignmentPrompt 含新 attemptId");
  } finally {
    await disposeGateway(result, root);
  }
});
