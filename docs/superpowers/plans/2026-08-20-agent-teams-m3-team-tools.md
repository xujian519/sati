# M3 实施计划：团队工具面 + 调度器补齐 + 角色注册接线

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 团队编排层从「编程式入口」升级为 agent 驱动——9 个 `team_*` 工具（建队/派单/转派/归档/消息/状态）+ 调度器补齐（isCaptainOnline 在线判定、message_delivered 批次 sender、scanner 路径续派）+ 12 岗角色全量接线。

**Architecture:** 工具层为薄封装（`src/tool/builtin/team/` 5 文件 9 工具，注入 `{ db, scheduler, emit }`，全部复用 M2 锁内原子 `withTeamLock`/`beginTaskAttempt`/`invalidateTaskAttempt`/`validateAttemptUpdate` 与邮箱租约，不复制业务逻辑）；gateway 新增内部连接活跃追踪（SessionPresence，协议不升版）；角色接线复用既有 `registerRoleDefinition` 装配循环（零新装配代码，只补资产）。

**Tech Stack:** TypeScript 5.9 strict（NodeNext）、node:sqlite（teams.db v3 迁移）、Express 5 gateway（ws 连接层）、SatiToolDefinition 工具契约（outputSchema 强制）、SKILL.md frontmatter 角色注册。

---

## 背景速览（M1/M2 已落地，本计划只增量）

- **teams.db**（`src/agent/team/storage/team-db.ts`）：`TeamDb` 全 API——`upsertTeam/getTeam/listTeams/insertMember/updateMemberStatus/getMember/listMembers/insertRetired(sessionKey, memberId, reason)/isRetired(sessionKey)/listTasks/getTask/insertTask/updateTask/listMessages/insertMessage/updateMessage/close`；user_version 迁移（`MIGRATIONS: string[]`，v1 三表 + v2 tasks/messages）。
- **类型**（全部经 `src/agent/team/index.js` barrel 导出）：`TeamRow { id, name, captainSessionKey, createdAt }`；`TeamMemberRow { id, teamId, roleSlug, modelRouteJson, status: "idle"|"working", sessionKey, createdAt }`；`TeamTaskRow { id, teamId, subject, description, status, assigneeId?, dependencies, attempt, attemptId?, handoffId?, reassigning, blockedByCount, maxAttempts, output?, createdAt, updatedAt }`；`TeamMessageRow { id, teamId, sender, recipient, content, createdAt, deliveryClaimedAt?, deliveredAt? }`。
- **任务状态机**（`taskpool/task-status.ts`）：`TeamTaskStatus` 六态、`TASK_TRANSITIONS`、`TERMINAL_TASK_STATUSES`、`transitionError(current, next)`、`unsatisfiedDependencies(tasks, deps)`。
- **attempt 纯函数**（`taskpool/attempt.ts`）：`beginTaskAttempt(task, assigneeId, attemptId?) → { task, attemptId }`（attempt+1/claimed/清 handoff/output/reassigning）；`invalidateTaskAttempt(task, { nextAssigneeId?, reassigning?, handoffId? })`（回 pending、attemptId 清、新 handoffId、attempt 保留）；`validateAttemptUpdate(task, attemptId?)`（终态或 attemptId 不匹配返回 stale-attempt 文案）；`attemptsExhausted(task)`。
- **锁**（`scheduler/lock.ts`）：`withTeamLock<T>(key: string, operation)`——per-team promise 链串行化。**关键惯例：锁内 read-modify-write + emit；锁外触发调度**（scheduler 内部自己拿锁，锁外调用防重入死锁——M2 C1 修复确立）。
- **调度器**（`scheduler/scheduler.ts`）：`TeamSchedulerOptions { db, emit, wake, maxConcurrentMembers?, isCaptainOnline? }`；方法 `kickTeam/kickMember/onTaskGraphChanged(teamId)/onMemberIdle(teamId, memberId)`；纯函数 `ownedOpenTask(tasks, memberId)`（claimed/in_progress + assignee 匹配）、`nextReadyTask(tasks, memberId)`（**pending + !reassigning + 依赖满足**，先指派给自己、其次未指派）、`assignmentPrompt(ticket)`、`fallbackMailboxPrompt(messages)`。`kickMember` 锁内流程：邮箱优先（`unreadMessages` → `claimDelivery` → wake → ack）→ 任务认领（`beginTaskAttempt` → updateTask → working → wake → 失败 `invalidateTaskAttempt` 回滚）→ 并发闸（working ≥ maxConcurrentMembers 默认 4 不派 pending 新任务）。`kickTeam`/`kickMember` 开头：`team === undefined || !isCaptainOnline(captainSessionKey)` 直接 return。
- **事件**（`protocol/events.ts`）：`TeamEvent` 13 种（`team_created/member_added/member_removed/member_status/member_idle/task_created/task_claimed/task_updated/task_completed/task_failed/task_reassigned/message_delivered/team_archived`）；`TeamEventEmitter = (captainSessionKey, event) => boolean`；`toGatewayEvent(event) → { type: "team_event", teamId, event }`（`protocol/broadcast.ts`）。
- **唤醒**（`member/member-waker.ts`）：`wakeMember(db, gateway, memberId, followupMessage, { syntheticMessages?, onEvent? })`——置 working → `gateway.submitTurn({ sessionKey: member.sessionKey, channelKey: "cron", message, canPrompt: false })` 整条链 → finally 置 idle。`MemberGateway = Pick<Gateway, "submitTurn">`。
- **成员身份**（`protocol/member-key.ts`）：`memberSessionKey(teamId, memberId) = "team:<teamId>:<memberId>"`；`parseMemberSessionKey` 已有（M1）；`isInternalSession` 过滤 `/^team[:\-]/` 前缀。
- **createLocalGateway 接线点**（`src/cli/createLocalGateway.ts`）：
  - ~455-460：`teamDb = new TeamDb(defaultTeamDbPath(pilotHome, env))`、`teamForwarder = new TeamApprovalForwarder({...})`
  - ~466-480：`runMemberScan = scanTeamMembers({ ..., onEvent: (member, event) => teamForwarder.handleMemberEvent(member, event) })`
  - ~499-548：`teamScheduler = new TeamScheduler({ db, emit, wake })`——wake 包装层内 onEvent 处理：审批冒泡 + `turn_completed` 分支（C2 检查：`ownedOpenTask` → `attemptsExhausted(fresh)` → `validateAttemptUpdate` 后置 failed → `void teamScheduler.onMemberIdle(member.teamId, memberId).catch(() => undefined)`）；**I3 标注：isCaptainOnline 未接线（默认常在线）**
  - ~1003：`createBuiltinRegistry({ backgroundTasks, searchPatentFigure, memory?, readSkill, ... })`
  - 2123-2130：`syncRoleDefinitions(pluginRuntime)`——先 unregister 全部再 register；`roleFromContribution(skill)` 解析 `type: role` SKILL.md
  - 返回值含 `teamSubsystem`（M2）：`{ db, scheduler, runMemberScan, runStrandedScan }`
- **工具契约**（`src/tool/protocol/types.ts`）：`SatiToolDefinition<Input, Output>`（name/outputSchema/aliases?/description/kind/inputSchema/isReadOnly/isConcurrencySafe/isDestructive/execute）；`SatiToolRuntimeContext` 含 `sessionId/turnId/cwd/abortSignal/permissionMode/permissionContext/env/now?/provider/modelId`；execute 返回 `{ content: [{ type: "text", text }], data }`。错误：`SatiToolRuntimeError(code: SatiToolErrorCode, message, details?)`（`src/tool/protocol/errors.js`）。注册：`registry.register(annotate(createXxxTool(), "domain"))`（`createBuiltinRegistry.ts:75` annotate 模块内私有）。`ToolDomain` 目前无 "team"（需扩展）。
- **ToolDomain 裁剪**：`domain: "team"` 对成员可见（作业面）；`domain: "team:manage"` 仅 captain（管理面）。按角色 `visibleDomains` 裁剪。
- **fake model 工具调用形状**（集成测试用，canonical 事件）：`{ type: "message_start", role: "assistant" }` → `{ type: "tool_call_start", id, name }` → `{ type: "tool_call_delta", id, delta: '{json}' }` → `{ type: "tool_call_end", toolCall: { id, name, arguments } }`。
- **角色资产**：5 个新增角色 SKILL.md 已有（`skills/patent-teams/{case-manager,formal-examiner,applicant-counsel,defendant-counsel,tech-investigator}/SKILL.md`，frontmatter 只有 name/description/type: role + 正文「工具域建议」小节给出 domains）；`docs/team-role-mapping.md` 12 岗映射表；`skills/patent-team-composition/SKILL.md` 建队引导（内含 `agent_teams_*` → `team_*` 的 M3 接线标注）。角色 frontmatter 惯例：`tools: ["*"]`、`domains: [...]`、`omitTools: [...]`、`readOnly: true|false`、`systemPrompt: |-`。
- **llm-replay 请求键**含 `toolSchemaDigest`——9 个新工具改变工具集 → 既有 fixture 失配，须显式重录（`scripts/record-real-fixture.ts`，需 API key）+ `pnpm record:replay` 校验。

---

## 任务一览

| # | 任务 | 产出 |
|---|---|---|
| 1 | SessionPresence 纯模块 | `src/gateway/server/sessionPresence.ts` + 单测 |
| 2 | createLocalGateway 接线（isCaptainOnline） | TeamScheduler 构造 + 返回值 `sessionPresence` |
| 3 | presence 透传链（ws 连接层） | GatewayWsConnection/GatewayServer/startSatiServer/sati.ts |
| 4 | ToolDomain 扩展 + teamUtils | `types.ts` + `src/tool/builtin/team/teamUtils.ts` + 单测 |
| 5 | teamManagement.ts（3 工具） | create/add_member/remove_member + 单测 |
| 6 | teamTasks.ts（3 工具） | create_task/update_task/reassign_task + blockedByCount + 单测 |
| 7 | teamMailbox.ts + teamStatus.ts（2 工具） | send_message/status + 单测 |
| 8 | teamArchive.ts + db v3 + scheduler 跳过 | archive 工具 + archived_at 迁移 + 单测 |
| 9 | 注册接线 | createBuiltinRegistry `team` options + createLocalGateway 传参 + 冒烟 |
| 10 | scanner 路径 onMemberIdle + C2 共享化 | createLocalGateway 两处复用 |
| 11 | message_delivered senders[] payload | events.ts + scheduler.ts + 事件矩阵 |
| 12 | 集成测试扩展 | 工具驱动全链（fake model 工具调用） |
| 13 | stress 矩阵扩展 | `scripts/team-stress-verify.mjs` 场景 9 |
| 14 | 角色接线 1：5 新增 + composition + 映射表 | 5 份 frontmatter + 2 处修正 |
| 15 | 角色接线 2：7 个团队变体角色 | `skills/patent-teams/` 7 份 SKILL.md |
| 16 | llm-replay fixture 重录 + 全量验证 | 重录 fixture + 验证链收尾 |

---

### Task 1: SessionPresence 连接活跃追踪模块

**Files:**
- Create: `src/gateway/server/sessionPresence.ts`
- Test: `tests/gateway/server/sessionPresence.spec.ts`

语义（**容错优先**）：unknown sessionKey（从未连接/纯 in-process/CLI）视为在线——无法判定的场景不阻塞成员工作；显式「见过连接且断开超过宽限窗」才判离线。宽限窗默认 60s 防瞬断误判。

- [ ] **Step 1: Write the failing test**

```ts
// tests/gateway/server/sessionPresence.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionPresence,
  SESSION_PRESENCE_GRACE_MS,
} from "../../../src/gateway/server/sessionPresence.js";

test("SessionPresence：unknown 会话视为在线（容错默认）", () => {
  const p = new SessionPresence();
  assert.equal(p.isActive("cap-1", 0), true);
});

test("SessionPresence：连接活跃 → 在线；断开超宽限窗 → 离线", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  assert.equal(p.isActive("cap-1", now), true);
  p.close("cap-1", now);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS - 1), true, "宽限窗内仍在线");
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS), false, "超宽限窗离线");
});

test("SessionPresence：重连 touch 复位离线判定", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  p.close("cap-1", now);
  p.touch("cap-1", now + SESSION_PRESENCE_GRACE_MS * 2);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS * 2), true);
});

test("SessionPresence：activeSessions 只含活跃连接，clear 清空", () => {
  const p = new SessionPresence();
  p.touch("cap-1", 0);
  p.touch("cap-2", 0);
  p.close("cap-2", 0);
  assert.deepEqual(p.activeSessions(0), ["cap-1"]);
  p.clear();
  assert.deepEqual(p.activeSessions(0), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test dist/tests/gateway/server/sessionPresence.spec.js`（先 `pnpm build`）
Expected: FAIL——`Cannot find module`（文件未创建）。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gateway/server/sessionPresence.ts
/**
 * 会话连接活跃追踪（M3）：gateway 内部状态，协议不动（无新方法/帧）。
 * 语义（容错优先）：unknown sessionKey（从未连接/纯 in-process/CLI）视为在线——
 * 无法判定的场景不阻塞成员工作；显式「见过连接且断开超过宽限窗」才判离线。
 * 宽限窗默认 60s：瞬断重连不误判离线。
 */
export const SESSION_PRESENCE_GRACE_MS = 60_000;

type PresenceEntry = {
  /** 最近一次收到帧的时间戳（ms）。 */
  lastSeenAt: number;
  /** 连接关闭时间戳（ms）；undefined = 当前有活跃连接。 */
  closedAt?: number;
};

export class SessionPresence {
  private readonly entries = new Map<string, PresenceEntry>();

  /** 连接收到任一帧：注册/刷新活跃。 */
  touch(sessionKey: string, now: number = Date.now()): void {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      this.entries.set(sessionKey, { lastSeenAt: now });
      return;
    }
    entry.lastSeenAt = now;
    entry.closedAt = undefined;
  }

  /** 连接关闭：记录关闭时刻（宽限窗内仍算在线，防瞬断误判）。 */
  close(sessionKey: string, now: number = Date.now()): void {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) {
      this.entries.set(sessionKey, { lastSeenAt: now, closedAt: now });
      return;
    }
    entry.closedAt = now;
  }

  /** 活跃判定：活跃连接 → true；关闭在宽限窗内 → true；unknown → true；关闭超窗 → false。 */
  isActive(sessionKey: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(sessionKey);
    if (entry === undefined) return true;
    if (entry.closedAt === undefined) return true;
    return now - entry.closedAt < SESSION_PRESENCE_GRACE_MS;
  }

  /** 当前活跃连接快照（M4 面板预留）。 */
  activeSessions(now: number = Date.now()): string[] {
    return [...this.entries.entries()].filter(([, e]) => e.closedAt === undefined).map(([k]) => k);
  }

  /** 清空全部记录（dispose 用）。 */
  clear(): void {
    this.entries.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test dist/tests/gateway/server/sessionPresence.spec.js`
Expected: PASS——4/4。

- [ ] **Step 5: Commit**

```bash
git add src/gateway/server/sessionPresence.ts tests/gateway/server/sessionPresence.spec.ts
git commit -m "feat(gateway): SessionPresence 连接活跃追踪（宽限窗 60s，unknown 容错在线）"
```

---

### Task 2: createLocalGateway 接线（SessionPresence 创建 + isCaptainOnline 注入）

**Files:**
- Modify: `src/cli/createLocalGateway.ts`（~455-500 行 teamDb 构造段 / TeamScheduler 构造段 / 返回值对象）

接线：createLocalGateway 内 `new SessionPresence()` → TeamScheduler 构造传 `isCaptainOnline` → 返回值加 `sessionPresence` 句柄（Task 3 的 sati.ts 透传链消费）。

- [ ] **Step 1: 实现接线（本任务为接线+回归，无新测试——既有 3 个集成用例即回归面：不接线时 unknown → 在线，行为不变）**

`src/cli/createLocalGateway.ts` 三处修改：

1. 导入块（字母序插入 `SessionPresence,`——`src/gateway/server/sessionPresence.js`）：
```ts
import { SessionPresence } from "../gateway/server/sessionPresence.js";
```

2. teamDb 构造后（~460 行）创建实例：
```ts
const teamDb = new TeamDb(defaultTeamDbPath(pilotHome, env));
// M3（I3 闭环）：captain 在线判定——gateway ws 连接活跃追踪（unknown 容错在线，
// 协议不升版）。sati.ts 透传本实例给 startGatewayServer 后即真实生效。
const sessionPresence = new SessionPresence();
```

3. TeamScheduler 构造（~499 行）加选项：
```ts
  const teamScheduler = new TeamScheduler({
    db: teamDb,
    emit: (captainSessionKey, event) => gateway.emitForSession(captainSessionKey, toGatewayEvent(event)),
    // I3（code review）闭环：captain 离线（连接断开超宽限窗）→ 暂停新认领；
    // unknown（纯 in-process/CLI 场景）容错视为在线，不阻塞成员工作。
    isCaptainOnline: captainSessionKey => sessionPresence.isActive(captainSessionKey),
    wake: async (memberId, message) => {
      // ...既有 wake 包装层不动...
    },
  });
```

4. 返回值对象加句柄（定位 `return { ... teamSubsystem ... }` 处，`teamSubsystem` 字段旁）：
```ts
    /** M3：captain 在线判定句柄（sati.ts 透传给 startGatewayServer 的 ws 连接层）。 */
    sessionPresence,
```

- [ ] **Step 2: Build + 回归**

Run: `pnpm build && node --test dist/tests/agent/team/`
Expected: PASS——既有 3 个集成用例 + 团队单测全过（isCaptainOnline 对 unknown key 返回 true，行为不变）。

- [ ] **Step 3: Commit**

```bash
git add src/cli/createLocalGateway.ts
git commit -m "feat(agent): TeamScheduler 接线 isCaptainOnline（SessionPresence 句柄，unknown 容错在线）"
```

---

### Task 3: presence 透传链（ws 连接层接线）

**Files:**
- Modify: `src/gateway/server/GatewayWsConnection.ts`（options 类型 + handleRequest + onClose）
- Modify: `src/gateway/server/GatewayServer.ts`（GatewayServerOptions + 构造点）
- Modify: `src/cli/satiServer.ts`（StartSatiServerOptions + startGatewayServer 调用）
- Modify: `src/cli/sati.ts`（解构 + startSatiServer 调用）

链路：`sati.ts` 解构 `sessionPresence` → `startSatiServer({ ..., presence })` → `startGatewayServer({ ..., presence })` → 每连接 `new GatewayWsConnection(ws, { ..., presence })` → 帧 touch / onClose close。

- [ ] **Step 1: GatewayWsConnection——options 加 presence、每帧 touch、onClose close**

`src/gateway/server/GatewayWsConnection.ts`：

```ts
import type { SessionPresence } from "./sessionPresence.js";
// 8 行 options 类型：
export type GatewayWsConnectionOptions = {
  gateway: Gateway;
  token: string;
  serverVersion: string;
  /** M3：连接活跃追踪（可选——未注入时零开销，不破坏既有构造点/测试）。 */
  presence?: SessionPresence;
};
```

类字段与构造（`private authed` 旁）：
```ts
  private readonly presence: SessionPresence | undefined;
  /** 最近一帧携带的 sessionKey（onClose 注销用）。 */
  private lastSessionKey: string | undefined;
```
构造内（`ws.onMessage` 注册旁）：
```ts
    this.presence = options.presence;
    ws.onMessage(message => void this.handleMessage(message));
    ws.onClose(() => {
      // M3：连接关闭注销活跃（宽限窗内仍算在线，防瞬断误判）
      if (this.lastSessionKey !== undefined) {
        this.presence?.close(this.lastSessionKey);
      }
    });
```

`handleRequest` 内 sessionKey 提取上移为函数级（当前在 submit_turn 分支内，123 行；改为 try 块顶部）——所有请求帧（不只 submit_turn）都刷新活跃：
```ts
  private async handleRequest(frame: WsRequestFrame): Promise<void> {
    try {
      // M3：任何请求帧都刷新连接活跃（submit_turn 分支继续使用本变量）
      const sessionKey = (frame.params as { sessionKey?: string } | undefined)?.sessionKey;
      if (sessionKey !== undefined && sessionKey !== "") {
        this.lastSessionKey = sessionKey;
        this.presence?.touch(sessionKey);
      }
      if (frame.method === "submit_turn") {
        // ...既有 submit_turn 分支不动（删除分支内重复的 sessionKey 提取，直接用函数级变量）...
```
（实施时删除 submit_turn 分支内原有的 `const sessionKey = ...` 提取行，改用函数级变量。）

- [ ] **Step 2: GatewayServer——options 透传**

`src/gateway/server/GatewayServer.ts`：`GatewayServerOptions` 加字段 + 构造点透传：
```ts
  /** M3：连接活跃追踪实例（satiServer 透传 createLocalGateway 的 sessionPresence）。 */
  presence?: SessionPresence;
```
```ts
  const conn = new GatewayWsConnection(ws, {
    gateway: options.gateway,
    token,
    serverVersion: options.serverVersion ?? APP_VERSION,
    presence: options.presence,
  });
```
（import：`import type { SessionPresence } from "./sessionPresence.js";`）

- [ ] **Step 3: satiServer——options 透传**

`src/cli/satiServer.ts`：`StartSatiServerOptions` 加字段 + startGatewayServer 调用传：
```ts
  /** M3：createLocalGateway 的 sessionPresence 句柄（captain 在线判定数据源）。 */
  presence?: SessionPresence;
```
```ts
  const gwServer = await startGatewayServer({
    gateway: options.gateway,
    port: options.port,
    host: options.host,
    staticAssetsPath: options.staticAssetsPath,
    presence: options.presence,
    feishuWebhook: ...,
  });
```
（import：`import type { SessionPresence } from "../gateway/server/sessionPresence.js";`）
（`startGatewayServer` 的 options 类型即 `GatewayServerOptions`——Task 3 Step 2 已加字段，无需再改。）

- [ ] **Step 4: sati.ts——解构 + 传参**

`src/cli/sati.ts`：两处（~260 行 createLocalGateway 解构、~474 行 startSatiServer 调用）：
```ts
    } = createLocalGateway({
```
解构列表加 `sessionPresence,`（`updateSubsystems` 旁）：
```ts
      updateSubsystems,
      sessionPresence,
```
调用加：
```ts
      startSatiServer({
        gateway,
        port: readPort(argv) ?? (Number.isFinite(envPort) ? envPort : 19789),
        staticAssetsPath: resolve(projectRoot, "ui/dist"),
        presence: sessionPresence,
        feishu: feishuChannel,
        ...
```

- [ ] **Step 5: Build + 回归**

Run: `pnpm build && node --test dist/tests/gateway/`
Expected: PASS——gateway 既有测试全过（presence 可选，未注入路径零行为变化）。

- [ ] **Step 6: Commit**

```bash
git add src/gateway/server/GatewayWsConnection.ts src/gateway/server/GatewayServer.ts src/cli/satiServer.ts src/cli/sati.ts
git commit -m "feat(gateway): ws 连接层接线 SessionPresence（帧 touch / onClose 注销，全链路透传）"
```

---

### Task 4: ToolDomain 扩展 + teamUtils 纯函数

**Files:**
- Modify: `src/tool/protocol/types.ts`（ToolDomain 联合类型，88-101 行）
- Create: `src/tool/builtin/team/teamUtils.ts`
- Create: `src/tool/builtin/team/index.ts`（barrel）
- Test: `tests/tool/builtin/team/teamUtils.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tool/builtin/team/teamUtils.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, createTeamMember } from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import {
  parseTeamSessionKey,
  isCaptainSession,
  resolveActor,
  requireTeamMember,
  requireRegisteredRole,
} from "../../../../src/tool/builtin/team/teamUtils.js";

test("parseTeamSessionKey：成员 key 解析；captain/非法 key 返回 undefined", () => {
  assert.deepEqual(parseTeamSessionKey("team:t1:m1"), { teamId: "t1", memberId: "m1" });
  assert.deepEqual(parseTeamSessionKey("team:t1:m1:x"), { teamId: "t1", memberId: "m1:x" });
  assert.equal(parseTeamSessionKey("cap-1"), undefined);
  assert.equal(parseTeamSessionKey("team:t1"), undefined);
});

test("isCaptainSession / resolveActor", () => {
  assert.equal(isCaptainSession("cap-1"), true);
  assert.equal(isCaptainSession("team:t1:m1"), false);
  assert.deepEqual(resolveActor("cap-1"), { teamId: "", memberId: "", captain: true });
  assert.deepEqual(resolveActor("team:t1:m1"), { teamId: "t1", memberId: "m1", captain: false });
  assert.equal(resolveActor(undefined), undefined);
});

test("requireTeamMember：成员通过；captain/异队/退休/未知成员拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-utils-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    createTeamMember(db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "researcher",
      modelRoute: { provider: "fake", model: "fake-model" },
    });
    const member = db.getMember("m1")!;

    // 成员通过
    assert.equal(requireTeamMember(db, { teamId: "t1", memberId: "m1", captain: false }, "t1"), "m1");

    // captain 拒绝
    assert.throws(
      () => requireTeamMember(db, { teamId: "", memberId: "", captain: true }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
    );
    // 异队成员拒绝
    assert.throws(
      () => requireTeamMember(db, { teamId: "t2", memberId: "m1", captain: false }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
    );
    // 退休成员拒绝
    db.insertRetired(member.sessionKey, "m1", "test");
    assert.throws(
      () => requireTeamMember(db, { teamId: "t1", memberId: "m1", captain: false }, "t1"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_member_retired",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requireRegisteredRole：注册角色通过；未知角色拒绝", () => {
  const { registerRoleDefinition, unregisterRoleDefinition } = await import(
    "../../../../src/agent/sub/builtinSubagentTypes.js"
  );
  const def = {
    id: "team-utils-test-role",
    name: "Team Utils Test Role",
    description: "test",
    tools: [],
    domains: [],
    omitTools: [],
    readOnly: false,
    systemPrompt: "test",
  };
  registerRoleDefinition(def);
  try {
    requireRegisteredRole("team-utils-test-role"); // 不抛
    assert.throws(
      () => requireRegisteredRole("no-such-role"),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_unknown_role",
    );
  } finally {
    unregisterRoleDefinition("team-utils-test-role");
  }
});
```

> ⚠️ `registerRoleDefinition` 的 SubagentDefinition 参数形状以 `src/agent/sub/builtinSubagentTypes.ts` 实际类型为准（实施时对照补全字段；id 唯一即可）。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamUtils.spec.js`
Expected: FAIL——`Cannot find module`（文件未创建）。

- [ ] **Step 3: ToolDomain 扩展**

`src/tool/protocol/types.ts`（ToolDomain 联合类型末尾，`"mcp"` 前）：
```ts
  | "team"
  | "team:manage"
```

- [ ] **Step 4: 实现 teamUtils.ts 与 barrel**

```ts
// src/tool/builtin/team/teamUtils.ts
/**
 * team_* 工具共享工具集（M3）：成员身份解析 + 团队工具依赖注入。
 * 工具层不复制业务逻辑：全部复用 M2 锁内原子与邮箱租约。
 */
import { listRegisteredRoleIds } from "../../../agent/sub/builtinSubagentTypes.js";
import type { TeamDb } from "../../../agent/team/index.js";
import type { TeamScheduler, TeamEventEmitter } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";

/** 工具工厂依赖（createLocalGateway 装配时注入：teamDb + teamScheduler + 广播出口）。 */
export type TeamToolsOptions = {
  db: TeamDb;
  scheduler: TeamScheduler;
  /** 事件广播出口（与 TeamScheduler 构造同款闭包：emitForSession + toGatewayEvent）。 */
  emit: TeamEventEmitter;
};

/**
 * 成员 sessionKey 解析：`team:<teamId>:<memberId>`（M1 既定格式，第一个冒号切分；
 * teamId 不得含冒号、memberId 允许）。非成员前缀返回 undefined（captain 主会话）。
 */
export function parseTeamSessionKey(sessionKey: string): { teamId: string; memberId: string } | undefined {
  const match = /^team:([^:]+):(.+)$/.exec(sessionKey);
  return match === null ? undefined : { teamId: match[1], memberId: match[2] };
}

/** 当前会话是否队长（主会话，非 team 前缀）。 */
export function isCaptainSession(sessionKey: string): boolean {
  return parseTeamSessionKey(sessionKey) === undefined;
}

export type TeamActor = {
  teamId: string;
  memberId: string;
  captain: boolean;
};

/**
 * 解析当前调用者身份。sessionId 缺失（直调路径）返回 undefined。
 */
export function resolveActor(contextSessionId: string | undefined): TeamActor | undefined {
  if (contextSessionId === undefined) return undefined;
  const parsed = parseTeamSessionKey(contextSessionId);
  if (parsed === undefined) return { teamId: "", memberId: "", captain: true };
  return { teamId: parsed.teamId, memberId: parsed.memberId, captain: false };
}

/**
 * 成员执行作业类工具的前置校验：会话须为指定团队的成员且未退休。
 * 失败抛 SatiToolRuntimeError（稳定错误码 team_not_member / team_member_retired）。
 */
export function requireTeamMember(db: TeamDb, actor: TeamActor | undefined, teamId: string): string {
  if (actor === undefined) {
    throw new SatiToolRuntimeError("team_actor_unknown", "无法判定调用者会话身份（sessionId 缺失）");
  }
  if (actor.captain) {
    throw new SatiToolRuntimeError("team_not_member", `队长会话不能执行成员作业（team=${teamId}）`);
  }
  if (actor.teamId !== teamId) {
    throw new SatiToolRuntimeError("team_not_member", `当前成员不属于团队 ${teamId}（实际 ${actor.teamId}）`);
  }
  const member = db.getMember(actor.memberId);
  if (member === undefined) {
    throw new SatiToolRuntimeError("team_not_member", `团队成员不存在：${actor.memberId}`);
  }
  if (db.isRetired(member.sessionKey)) {
    throw new SatiToolRuntimeError("team_member_retired", `团队成员已退休：${actor.memberId}`);
  }
  return actor.memberId;
}

/** 角色注册表校验：roleSlug 须在 registerRoleDefinition 装配结果内（M3 角色接线后全量可用）。 */
export function requireRegisteredRole(roleSlug: string): void {
  if (!listRegisteredRoleIds().includes(roleSlug)) {
    throw new SatiToolRuntimeError("team_unknown_role", `未知角色 roleSlug：${roleSlug}`);
  }
}

/** 队长权限校验（管理类工具前置）：非队长会话拒绝。 */
export function requireCaptain(actor: TeamActor | undefined): void {
  if (actor === undefined) {
    throw new SatiToolRuntimeError("team_actor_unknown", "无法判定调用者会话身份（sessionId 缺失）");
  }
  if (!actor.captain) {
    throw new SatiToolRuntimeError("team_not_captain", "仅队长（主会话）可执行团队管理操作");
  }
}

/** 成员 modelRoute 继承队长（context 会话主模型），缺省与项目默认一致。 */
export function defaultModelRoute(context: {
  provider?: string;
  modelId?: string;
}): { provider: string; model: string } {
  return {
    provider: context.provider ?? "deepseek",
    model: context.modelId ?? "deepseek-v4-flash",
  };
}
```

```ts
// src/tool/builtin/team/index.ts
/** team_* 工具 barrel（M3）：9 工具由 createLocalGateway 经 createBuiltinRegistry options.team 装配。 */
export { createTeamCreateTool, createTeamAddMemberTool, createTeamRemoveMemberTool } from "./teamManagement.js";
export { createTeamCreateTaskTool, createTeamUpdateTaskTool, createTeamReassignTaskTool } from "./teamTasks.js";
export { createTeamSendMessageTool } from "./teamMailbox.js";
export { createTeamStatusTool } from "./teamStatus.js";
export { createTeamArchiveTool } from "./teamArchive.js";
export type { TeamToolsOptions } from "./teamUtils.js";
export {
  parseTeamSessionKey,
  isCaptainSession,
  resolveActor,
  requireTeamMember,
  requireCaptain,
  requireRegisteredRole,
  defaultModelRoute,
} from "./teamUtils.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamUtils.spec.js`
Expected: PASS——4/4（barrel 导入的文件在 Task 5-8 才创建，teamUtils.spec 只测 teamUtils.ts，不触发 barrel）。

- [ ] **Step 6: Commit**

```bash
git add src/tool/protocol/types.ts src/tool/builtin/team/teamUtils.ts src/tool/builtin/team/index.ts tests/tool/builtin/team/teamUtils.spec.ts
git commit -m "feat(tool): ToolDomain 扩展 team/team:manage + team 工具共享工具集（身份解析/角色校验）"
```

---

### Task 5: teamManagement.ts——team_create / team_add_member / team_remove_member

**Files:**
- Create: `src/tool/builtin/team/teamManagement.ts`
- Test: `tests/tool/builtin/team/teamManagement.spec.ts`

三个管理类工具，domain 标注 `team:manage`（Task 9 注册时打标）。全部 `requireCaptain` 前置（防御性校验——domain 裁剪只影响角色侧工具可见性，直调路径由工具自守）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/tool/builtin/team/teamManagement.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, type TeamEvent } from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import { createTeamCreateTool, createTeamAddMemberTool, createTeamRemoveMemberTool } from "../../../../src/tool/builtin/team/index.js";
import { registerRoleDefinition, unregisterRoleDefinition } from "../../../../src/agent/sub/builtinSubagentTypes.js";
import { createTeamMember } from "../../../../src/agent/team/index.js";

/** 测试 fixture：真实 TeamDb + 记录事件的伪调度器。 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-team-mgmt-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {
    onTaskGraphChanged: async () => {},
    onMemberIdle: async () => {},
    kickMember: async () => {},
  } as unknown as import("../../../../src/agent/team/index.js").TeamScheduler;
  const tools = {
    create: createTeamCreateTool({ db, scheduler, emit }),
    addMember: createTeamAddMemberTool({ db, scheduler, emit }),
    removeMember: createTeamRemoveMemberTool({ db, scheduler, emit }),
  };
  return { root, db, events, tools };
}
// import { type TeamEventEmitter } from "../../../../src/agent/team/index.js";  // 顶部补

test("team_create：建队 + 首批成员 + team_created/member_added 事件", async () => {
  const { db, events, tools } = setup();
  registerRoleDefinition({
    id: "test-researcher",
    name: "Test Researcher",
    description: "test",
    tools: [],
    domains: [],
    omitTools: [],
    readOnly: false,
    systemPrompt: "test",
  });
  try {
    const out = await tools.create.execute(
      { name: "专利团队", memberRoleSlugs: ["test-researcher"] },
      { sessionId: "cap-1" } as never,
    );
    const data = out.data as { teamId: string; captainSessionKey: string; members: Array<{ memberId: string }> };
    assert.match(data.teamId, /^t-/);
    assert.equal(data.captainSessionKey, "cap-1");
    assert.equal(data.members.length, 1);
    assert.ok(db.getTeam(data.teamId));
    assert.ok(db.getMember(data.members[0]!.memberId));
    assert.equal(events.filter(e => e.type === "team_created").length, 1);
    assert.equal(events.filter(e => e.type === "member_added").length, 1);
  } finally {
    unregisterRoleDefinition("test-researcher");
  }
});

test("team_create：未知 roleSlug 拒绝", async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.create.execute({ name: "t", memberRoleSlugs: ["no-such-role"] }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_unknown_role",
  );
});

test("team_create：成员会话被拒（requireCaptain）", async () => {
  const { tools } = setup();
  await assert.rejects(
    () => tools.create.execute({ name: "t" }, { sessionId: "team:t1:m1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_add_member：招募成员 + modelRoute 继承", async () => {
  const { db, events, tools } = setup();
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  registerRoleDefinition({
    id: "test-searcher",
    name: "Test Searcher",
    description: "test",
    tools: [],
    domains: [],
    omitTools: [],
    readOnly: false,
    systemPrompt: "test",
  });
  try {
    const out = await tools.addMember.execute(
      { teamId: "t1", roleSlug: "test-searcher" },
      { sessionId: "cap-1", provider: "deepseek", modelId: "deepseek-v4-flash" } as never,
    );
    const data = out.data as { memberId: string };
    const member = db.getMember(data.memberId)!;
    assert.equal(member.roleSlug, "test-searcher");
    assert.equal(JSON.parse(member.modelRouteJson).provider, "deepseek");
    assert.ok(events.some(e => e.type === "member_added" && e.teamId === "t1"));
  } finally {
    unregisterRoleDefinition("test-searcher");
  }
});

test("team_add_member：未知团队/未知角色/重复角色拒绝", async () => {
  const { db, tools } = setup();
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  await assert.rejects(
    () => tools.addMember.execute({ teamId: "no-such", roleSlug: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  await assert.rejects(
    () => tools.addMember.execute({ teamId: "t1", roleSlug: "no-such-role" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_unknown_role",
  );
});

test("team_remove_member：退休 + 名下 open 任务 invalidate 回池 + member_removed", async () => {
  const { db, events, tools } = setup();
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "test-researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  db.insertTask({
    id: "task-1", teamId: "t1", subject: "s", description: "", status: "claimed",
    assigneeId: "m1", dependencies: [], attempt: 1, attemptId: "a1", reassigning: false,
    blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
  });
  const out = await tools.removeMember.execute({ teamId: "t1", memberId: "m1" }, { sessionId: "cap-1" } as never);
  assert.ok(db.isRetired(db.getMember("m1")!.sessionKey));
  const task = db.getTask("t1", "task-1")!;
  assert.equal(task.status, "pending");
  assert.equal(task.handoffId, undefined); // 由后续队长 reassign 决定去向
  assert.equal(task.reassigning, true);    // 回池暂缓自动派发
  assert.ok(events.some(e => e.type === "member_removed" && e.memberId === "m1"));
});
```

（顶部补 `import type { TeamEventEmitter } from "../../../../src/agent/team/index.js";`；`registerRoleDefinition` 的 SubagentDefinition 形状以实际类型为准，字段补全即可。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamManagement.spec.js`
Expected: FAIL——`Cannot find module`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tool/builtin/team/teamManagement.ts
/**
 * 团队管理工具（M3）：team_create / team_add_member / team_remove_member。
 * 全部为管理面（domain: "team:manage"，Task 9 注册打标）——requireCaptain 自守；
 * 建队/招募/移除均锁内 read-modify-write，事件锁内发出，调度锁外触发（既有惯例）。
 */
import { randomUUID } from "node:crypto";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { TERMINAL_TASK_STATUSES, createTeamMember, invalidateTaskAttempt, withTeamLock } from "../../../agent/team/index.js";
import type { TeamDb } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import {
  defaultModelRoute,
  requireCaptain,
  requireRegisteredRole,
  resolveActor,
  type TeamToolsOptions,
} from "./teamUtils.js";

export type TeamCreateInput = { name: string; memberRoleSlugs?: string[] };
export type TeamCreateOutput = {
  teamId: string;
  name: string;
  captainSessionKey: string;
  members: Array<{ memberId: string; roleSlug: string }>;
};

export function createTeamCreateTool(options: TeamToolsOptions): SatiToolDefinition<TeamCreateInput, TeamCreateOutput> {
  const { db, emit } = options;
  return {
    name: "team_create",
    outputSchema: {
      type: "object",
      required: ["teamId", "name", "captainSessionKey", "members"],
      properties: {
        teamId: { type: "string" },
        name: { type: "string" },
        captainSessionKey: { type: "string" },
        members: {
          type: "array",
          items: {
            type: "object",
            required: ["memberId", "roleSlug"],
            properties: { memberId: { type: "string" }, roleSlug: { type: "string" } },
          },
        },
      },
    },
    description:
      "Create a team with the current session as captain. Optionally recruit the first members by registered roleSlug (e.g. 'researcher', 'case-manager'). Returns the new teamId, captainSessionKey, and the recruited members. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Team display name (e.g. 'patent-team-2026001')." },
        memberRoleSlugs: {
          type: "array",
          items: { type: "string" },
          description: "Optional initial member roleSlugs (must be registered roles).",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamCreateOutput>> => {
      const actor = resolveActor(context.sessionId);
      requireCaptain(actor);
      for (const roleSlug of input.memberRoleSlugs ?? []) requireRegisteredRole(roleSlug);
      const teamId = `t-${randomUUID().slice(0, 8)}`;
      const members: Array<{ memberId: string; roleSlug: string }> = [];
      await withTeamLock(teamId, async () => {
        db.upsertTeam({
          id: teamId,
          name: input.name,
          captainSessionKey: context.sessionId,
          createdAt: new Date().toISOString(),
        });
        emit(context.sessionId, { type: "team_created", teamId, name: input.name, captainSessionKey: context.sessionId });
        for (const roleSlug of input.memberRoleSlugs ?? []) {
          const memberId = `m-${randomUUID().slice(0, 8)}`;
          createTeamMember(db, { teamId, memberId, roleSlug, modelRoute: defaultModelRoute(context) });
          members.push({ memberId, roleSlug });
          emit(context.sessionId, { type: "member_added", teamId, memberId, roleSlug });
        }
      });
      return {
        content: [{ type: "text", text: `team_create teamId=${teamId} name=${input.name} members=${members.length}` }],
        data: { teamId, name: input.name, captainSessionKey: context.sessionId, members },
      };
    },
  };
}

export type TeamAddMemberInput = { teamId: string; roleSlug: string };
export type TeamAddMemberOutput = { teamId: string; memberId: string; roleSlug: string };

export function createTeamAddMemberTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamAddMemberInput, TeamAddMemberOutput> {
  const { db, emit } = options;
  return {
    name: "team_add_member",
    outputSchema: {
      type: "object",
      required: ["teamId", "memberId", "roleSlug"],
      properties: {
        teamId: { type: "string" },
        memberId: { type: "string" },
        roleSlug: { type: "string" },
      },
    },
    description:
      "Recruit a new team member with a registered roleSlug (e.g. 'researcher', 'adversarial-reviewer'). The member inherits the captain's model route. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "roleSlug"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id from team_create." },
        roleSlug: { type: "string", description: "Registered role id (team roleSlug)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamAddMemberOutput>> => {
      const actor = resolveActor(context.sessionId);
      requireCaptain(actor);
      requireRegisteredRole(input.roleSlug);
      let memberId = "";
      await withTeamLock(input.teamId, async () => {
        if (db.getTeam(input.teamId) === undefined) {
          throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
        }
        memberId = `m-${randomUUID().slice(0, 8)}`;
        createTeamMember(db, {
          teamId: input.teamId,
          memberId,
          roleSlug: input.roleSlug,
          modelRoute: defaultModelRoute(context),
        });
        emit(context.sessionId, { type: "member_added", teamId: input.teamId, memberId, roleSlug: input.roleSlug });
      });
      return {
        content: [{ type: "text", text: `team_add_member memberId=${memberId} role=${input.roleSlug}` }],
        data: { teamId: input.teamId, memberId, roleSlug: input.roleSlug },
      };
    },
  };
}

export type TeamRemoveMemberInput = { teamId: string; memberId: string; reason?: string };
export type TeamRemoveMemberOutput = { teamId: string; memberId: string; removed: boolean };

export function createTeamRemoveMemberTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamRemoveMemberInput, TeamRemoveMemberOutput> {
  const { db, emit } = options;
  return {
    name: "team_remove_member",
    outputSchema: {
      type: "object",
      required: ["teamId", "memberId", "removed"],
      properties: { teamId: { type: "string" }, memberId: { type: "string" }, removed: { type: "boolean" } },
    },
    description:
      "Retire a team member (irreversible): the member can no longer be woken, and their open tasks return to the pool in the 'reassigning' state (not auto-dispatched until the captain reassigns them). Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "memberId"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        memberId: { type: "string", description: "Member id from team_create/team_add_member." },
        reason: { type: "string", description: "Optional retirement reason." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamRemoveMemberOutput>> => {
      const actor = resolveActor(context.sessionId);
      requireCaptain(actor);
      await withTeamLock(input.teamId, async () => {
        const member = db.getMember(input.memberId);
        if (member === undefined || member.teamId !== input.teamId) {
          throw new SatiToolRuntimeError("team_not_member", `团队成员不存在：${input.memberId}`);
        }
        if (db.isRetired(member.sessionKey)) {
          throw new SatiToolRuntimeError("team_member_retired", `团队成员已退休：${input.memberId}`);
        }
        db.insertRetired(member.sessionKey, member.id, input.reason ?? "removed_by_captain");
        // 名下 open 任务 invalidate 回池（reassigning 暂缓自动派发，等队长处置）
        for (const task of db.listTasks(input.teamId)) {
          if (task.assigneeId !== member.id || TERMINAL_TASK_STATUSES.includes(task.status)) continue;
          db.updateTask(invalidateTaskAttempt(task, { reassigning: true }));
        }
        emit(context.sessionId, {
          type: "member_removed",
          teamId: input.teamId,
          memberId: member.id,
          reason: input.reason ?? "removed_by_captain",
        });
      });
      return {
        content: [{ type: "text", text: `team_remove_member memberId=${input.memberId} retired` }],
        data: { teamId: input.teamId, memberId: input.memberId, removed: true },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamManagement.spec.js`
Expected: PASS——6/6。

- [ ] **Step 5: Commit**

```bash
git add src/tool/builtin/team/teamManagement.ts tests/tool/builtin/team/teamManagement.spec.ts
git commit -m "feat(tool): team_create/team_add_member/team_remove_member（管理面，锁内建队/招募/退休）"
```

---

### Task 6: teamTasks.ts——team_create_task / team_update_task / team_reassign_task

**Files:**
- Create: `src/tool/builtin/team/teamTasks.ts`
- Test: `tests/tool/builtin/team/teamTasks.spec.ts`

`team_create_task`/`team_reassign_task` 为管理面（`team:manage`，captain）；`team_update_task` 为作业面（`team`，成员完成任务路径——spec 关键语义）。blockedByCount 三个工具均按 `dependencies` 数组实时重算（未完成依赖计数，与调度器 `unsatisfiedDependencies` 一致）。

**成员完成任务路径**：`team_update_task({ teamId, taskId, status: "completed", attemptId, output })` → assignee 校验 + `validateAttemptUpdate(task, attemptId)`（stale-attempt fail-closed）→ `transitionError` 校验 → 锁内置终态 + blockedByCount 重算 → 锁外 emit `task_completed` + `void scheduler.onTaskGraphChanged(teamId)`（下游解锁）→ 成员回合结束 `turn_completed` → 既有 `onMemberIdle` → 续派。任务终结后 C2 检查（`attemptsExhausted` → failed）不命中（`ownedOpenTask` 仅匹配 open 状态）——re-claim 循环自然停止。

**reassign 语义**（与 `nextReadyTask` 过滤一致）：指定成员 → `invalidateTaskAttempt(task, { nextAssigneeId: memberId })`（reassigning 默认 false，`nextReadyTask` 会命中 assigneeId 匹配）→ `kickMember(teamId, memberId)` 立即派发；回池（无 memberId）→ `{ reassigning: true }` → 暂缓自动派发，等队长再指派。

- [ ] **Step 1: Write the failing test**

```ts
// tests/tool/builtin/team/teamTasks.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TeamDb,
  createTeamMember,
  type TeamEvent,
  type TeamEventEmitter,
  type TeamScheduler,
  type TeamTaskRow,
} from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import {
  createTeamCreateTaskTool,
  createTeamUpdateTaskTool,
  createTeamReassignTaskTool,
} from "../../../../src/tool/builtin/team/index.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-team-tasks-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const kicked: string[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {
    onTaskGraphChanged: async () => {},
    kickMember: async (_teamId: string, memberId: string) => {
      kicked.push(memberId);
    },
  } as unknown as TeamScheduler;
  const tools = {
    createTask: createTeamCreateTaskTool({ db, scheduler, emit }),
    updateTask: createTeamUpdateTaskTool({ db, scheduler, emit }),
    reassign: createTeamReassignTaskTool({ db, scheduler, emit }),
  };
  // 团队 + 两名成员 + 一名队长
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1", memberId: "m1", roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  createTeamMember(db, {
    teamId: "t1", memberId: "m2", roleSlug: "drafter",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  const insertTask = (row: Omit<TeamTaskRow, "createdAt" | "updatedAt">) =>
    db.insertTask({ ...row, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
  return { root, db, events, kicked, tools, insertTask };
}

test("team_create_task：建任务 + blockedByCount 按依赖重算 + task_created + 调度触发", async () => {
  const { db, events, kicked, tools, insertTask } = setup();
  insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "pending", dependencies: [],
    attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3,
  });
  const out = await tools.createTask.execute(
    { teamId: "t1", subject: "B", description: "desc", dependencies: ["a"], maxAttempts: 5 },
    { sessionId: "cap-1" } as never,
  );
  const data = out.data as { taskId: string; blockedByCount: number };
  const task = db.getTask("t1", data.taskId)!;
  assert.equal(task.subject, "B");
  assert.equal(task.blockedByCount, 1, "依赖 a 未完成 → 阻塞 1");
  assert.equal(task.maxAttempts, 5);
  assert.equal(task.status, "pending");
  assert.ok(events.some(e => e.type === "task_created" && e.taskId === data.taskId));
  assert.deepEqual(kicked, [], "kick 由调度器真实触发（测试伪调度器不记录——此处仅确认事件面）");
});

test("team_create_task：依赖不存在拒绝；未知团队拒绝；成员会话拒绝", async () => {
  const { db, tools } = setup();
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "X", dependencies: ["no-such"] }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_task_not_found",
  );
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "no-such", subject: "X" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  await assert.rejects(
    () => tools.createTask.execute({ teamId: "t1", subject: "X" }, { sessionId: "team:t1:m1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});

test("team_update_task：成员完成名下任务 → 终态 + attemptId 保留 + 下游 blockedByCount 重算", async () => {
  const { db, events, tools, insertTask } = setup();
  insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "claimed", assigneeId: "m1",
    dependencies: [], attempt: 1, attemptId: "attempt-1", reassigning: false, blockedByCount: 0, maxAttempts: 3,
  });
  insertTask({
    id: "b", teamId: "t1", subject: "B", description: "", status: "pending", dependencies: ["a"],
    attempt: 0, reassigning: false, blockedByCount: 1, maxAttempts: 3,
  });
  const out = await tools.updateTask.execute(
    { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1", output: "结果" },
    { sessionId: "team:t1:m1" } as never,
  );
  const a = db.getTask("t1", "a")!;
  assert.equal(a.status, "completed");
  assert.equal(a.output, "结果");
  assert.equal(a.attemptId, "attempt-1", "终态保留 attemptId（队长可审计）");
  const b = db.getTask("t1", "b")!;
  assert.equal(b.blockedByCount, 0, "依赖 a 已完成 → 解锁");
  assert.ok(events.some(e => e.type === "task_completed" && e.taskId === "a" && e.output === "结果"));
});

test("team_update_task：非本人任务/队长跳过成员校验/stale-attempt/非法转移拒绝", async () => {
  const { tools, insertTask } = setup();
  insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "claimed", assigneeId: "m1",
    dependencies: [], attempt: 1, attemptId: "attempt-1", reassigning: false, blockedByCount: 0, maxAttempts: 3,
  });
  // 非 assignee 成员拒绝
  await assert.rejects(
    () => tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1" },
      { sessionId: "team:t1:m2" } as never,
    ),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_assignee",
  );
  // captain 可代操作（跳过成员校验，attemptId 仍校验）
  await assert.rejects(
    () => tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "completed", attemptId: "wrong-attempt" },
      { sessionId: "cap-1" } as never,
    ),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
  // stale-attempt（成员）
  await assert.rejects(
    () => tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "completed", attemptId: "old-attempt" },
      { sessionId: "team:t1:m1" } as never,
    ),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
  // 非法状态转移（claimed → cancelled 合法；claimed → pending 非法）
  await assert.rejects(
    () => tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "cancelled", attemptId: "attempt-1" },
      { sessionId: "team:t1:m1" } as never,
    ).then(() => tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "completed", attemptId: "attempt-1" },
      { sessionId: "team:t1:m1" } as never,
    )),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
  // 终态不可再写（completed 后任何 attemptId 拒绝）
  await assert.rejects(
    () => tools.updateTask.execute(
      { teamId: "t1", taskId: "a", status: "failed", attemptId: "attempt-1" },
      { sessionId: "team:t1:m1" } as never,
    ),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_stale_attempt",
  );
});

test("team_reassign_task：指定成员 → pending+assignee+reassigning:false → kickMember；回池 → reassigning:true 不派", async () => {
  const { db, events, kicked, tools, insertTask } = setup();
  insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "claimed", assigneeId: "m1",
    dependencies: [], attempt: 1, attemptId: "attempt-1", reassigning: false, blockedByCount: 0, maxAttempts: 3,
  });
  // 指定成员
  const out1 = await tools.reassign.execute(
    { teamId: "t1", taskId: "a", memberId: "m2" },
    { sessionId: "cap-1" } as never,
  );
  const a1 = db.getTask("t1", "a")!;
  assert.equal(a1.status, "pending");
  assert.equal(a1.assigneeId, "m2");
  assert.equal(a1.reassigning, false, "指定成员 → 可被 nextReadyTask 命中");
  assert.equal(a1.attemptId, undefined, "attemptId 已清（新 attempt 生效前旧写被拒）");
  assert.ok(a1.handoffId !== undefined && a1.handoffId !== a1.attemptId);
  assert.ok(events.some(e => e.type === "task_reassigned" && e.toMemberId === "m2"));
  assert.ok(kicked.includes("m2"), "指定成员应被 kickMember");
  // 回池（再转一次无 memberId）
  await tools.reassign.execute({ teamId: "t1", taskId: "a" }, { sessionId: "cap-1" } as never);
  const a2 = db.getTask("t1", "a")!;
  assert.equal(a2.reassigning, true, "回池暂缓自动派发");
  assert.equal(a2.assigneeId, undefined);
});

test("team_reassign_task：终态任务拒绝；成员会话拒绝", async () => {
  const { tools, insertTask } = setup();
  insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "completed", assigneeId: "m1",
    dependencies: [], attempt: 1, attemptId: "attempt-1", reassigning: false, blockedByCount: 0, maxAttempts: 3,
  });
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m2" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_task_terminal",
  );
  await assert.rejects(
    () => tools.reassign.execute({ teamId: "t1", taskId: "a", memberId: "m2" }, { sessionId: "team:t1:m1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamTasks.spec.js`
Expected: FAIL——`Cannot find module`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tool/builtin/team/teamTasks.ts
/**
 * 团队任务工具（M3）：team_create_task / team_update_task / team_reassign_task。
 * create/reassign 为管理面（domain: "team:manage"）；update_task 为作业面（domain: "team"）——
 * 成员回合内完成任务的关键路径：assignee 校验 + validateAttemptUpdate（stale-attempt fail-closed）
 * + transitionError 校验 → 锁内置终态 → blockedByCount 重算 → 锁外调度（下游解锁）。
 */
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { randomUUID } from "node:crypto";
import {
  TERMINAL_TASK_STATUSES,
  transitionError,
  unsatisfiedDependencies,
  validateAttemptUpdate,
  invalidateTaskAttempt,
  withTeamLock,
  type TeamTaskRow,
} from "../../../agent/team/index.js";
import type { TeamDb } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { requireCaptain, requireTeamMember, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

/** 锁内重算团队全部任务的 blockedByCount（dependencies 未完成计数，与调度器一致）。 */
function recomputeBlockedByCount(db: TeamDb, teamId: string): void {
  for (const t of db.listTasks(teamId)) {
    const count = unsatisfiedDependencies(db.listTasks(teamId), t.dependencies).length;
    if (count !== t.blockedByCount) {
      db.updateTask({ ...t, blockedByCount: count, updatedAt: t.updatedAt });
    }
  }
}

export type TeamCreateTaskInput = {
  teamId: string;
  subject: string;
  description?: string;
  dependencies?: string[];
  maxAttempts?: number;
};
export type TeamCreateTaskOutput = {
  teamId: string;
  taskId: string;
  subject: string;
  status: string;
  blockedByCount: number;
};

export function createTeamCreateTaskTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamCreateTaskInput, TeamCreateTaskOutput> {
  const { db, scheduler, emit } = options;
  return {
    name: "team_create_task",
    outputSchema: {
      type: "object",
      required: ["teamId", "taskId", "subject", "status", "blockedByCount"],
      properties: {
        teamId: { type: "string" },
        taskId: { type: "string" },
        subject: { type: "string" },
        status: { type: "string" },
        blockedByCount: { type: "number" },
      },
    },
    description:
      "Create a task in the team task pool with optional dependencies (task ids that must complete first) and maxAttempts (default 3). The scheduler auto-claims ready tasks to idle members. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "subject"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        subject: { type: "string", description: "Task subject (shown in the member's assignment prompt)." },
        description: { type: "string", description: "Optional task description." },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must be 'completed' before this task is dispatched.",
        },
        maxAttempts: {
          type: "number",
          description: "Attempt cap before the task is marked failed (default 3).",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamCreateTaskOutput>> => {
      const actor = resolveActor(context.sessionId);
      requireCaptain(actor);
      let taskId = "";
      let blockedByCount = 0;
      await withTeamLock(input.teamId, async () => {
        if (db.getTeam(input.teamId) === undefined) {
          throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
        }
        const known = db.listTasks(input.teamId);
        for (const dep of input.dependencies ?? []) {
          if (!known.some(t => t.id === dep)) {
            throw new SatiToolRuntimeError("team_task_not_found", `依赖任务不存在：${dep}`);
          }
        }
        taskId = `t-${randomUUID().slice(0, 8)}`;
        const deps = input.dependencies ?? [];
        blockedByCount = unsatisfiedDependencies(known, deps).length;
        const row: TeamTaskRow = {
          id: taskId,
          teamId: input.teamId,
          subject: input.subject,
          description: input.description ?? "",
          status: "pending",
          dependencies: deps,
          attempt: 0,
          reassigning: false,
          blockedByCount,
          maxAttempts: input.maxAttempts ?? 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        db.insertTask(row);
        emit(context.sessionId, {
          type: "task_created",
          teamId: input.teamId,
          taskId,
          subject: input.subject,
          dependencies: deps,
        });
      });
      // 锁外触发调度（scheduler 内部自己拿锁，防重入死锁——M2 C1 惯例；fire-and-forget）
      void scheduler.onTaskGraphChanged(input.teamId).catch(() => undefined);
      return {
        content: [
          { type: "text", text: `team_create_task taskId=${taskId} subject=${input.subject} blockedBy=${blockedByCount}` },
        ],
        data: { teamId: input.teamId, taskId, subject: input.subject, status: "pending", blockedByCount },
      };
    },
  };
}

export type TeamUpdateTaskInput = {
  teamId: string;
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  attemptId: string;
  output?: string;
  reason?: string;
};
export type TeamUpdateTaskOutput = {
  teamId: string;
  taskId: string;
  status: string;
  attempt: number;
  assigneeId?: string;
  output?: string;
};

export function createTeamUpdateTaskTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamUpdateTaskInput, TeamUpdateTaskOutput> {
  const { db, scheduler, emit } = options;
  return {
    name: "team_update_task",
    outputSchema: {
      type: "object",
      required: ["teamId", "taskId", "status", "attempt"],
      properties: {
        teamId: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string" },
        attempt: { type: "number" },
        assigneeId: { type: "string" },
        output: { type: "string" },
      },
    },
    description:
      "Advance a task to a terminal state. Members may only update tasks assigned to themselves; the captain may update any task. Pass the attemptId from the assignment prompt — writes with a stale attemptId are rejected (fail-closed). 'completed' accepts output; 'failed' accepts reason; 'cancelled' accepts neither. Completing a task unlocks its dependents for dispatch.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId", "status", "attemptId"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        taskId: { type: "string", description: "Task id." },
        status: {
          type: "string",
          enum: ["completed", "failed", "cancelled"],
          description: "Terminal status to move to.",
        },
        attemptId: {
          type: "string",
          description: "Current attemptId (from the assignment prompt). Required — guards against stale writes.",
        },
        output: { type: "string", description: "Completion output (status=completed)." },
        reason: { type: "string", description: "Failure reason (status=failed)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamUpdateTaskOutput>> => {
      const actor = resolveActor(context.sessionId);
      // 成员身份解析（captain 跳过成员校验，直接进 attemptId 校验）
      const memberId =
        actor !== undefined && !actor.captain ? requireTeamMember(db, actor, input.teamId) : undefined;
      let next: TeamTaskRow | undefined;
      await withTeamLock(input.teamId, async () => {
        const task = db.getTask(input.teamId, input.taskId);
        if (task === undefined) {
          throw new SatiToolRuntimeError("team_task_not_found", `任务不存在：${input.taskId}`);
        }
        if (memberId !== undefined && task.assigneeId !== memberId) {
          throw new SatiToolRuntimeError("team_not_assignee", `任务 ${input.taskId} 不属于当前成员`);
        }
        const guard = validateAttemptUpdate(task, input.attemptId);
        if (guard !== undefined) {
          throw new SatiToolRuntimeError("team_stale_attempt", guard);
        }
        const transition = transitionError(task.status, input.status);
        if (transition !== undefined) {
          throw new SatiToolRuntimeError("team_bad_transition", transition);
        }
        next = {
          ...task,
          status: input.status,
          ...(input.status === "completed" ? { output: input.output ?? "" } : {}),
          updatedAt: new Date().toISOString(),
        };
        db.updateTask(next);
        recomputeBlockedByCount(db, input.teamId); // 本任务终态可能解锁下游
      });
      if (next !== undefined) {
        const team = db.getTeam(input.teamId);
        if (team !== undefined) {
          if (input.status === "completed") {
            emit(team.captainSessionKey, {
              type: "task_completed",
              teamId: input.teamId,
              taskId: input.taskId,
              memberId: next.assigneeId ?? "",
              attempt: next.attempt,
              output: next.output,
            });
          } else if (input.status === "failed") {
            emit(team.captainSessionKey, {
              type: "task_failed",
              teamId: input.teamId,
              taskId: input.taskId,
              memberId: next.assigneeId ?? "",
              attempt: next.attempt,
              reason: input.reason,
            });
          } else {
            emit(team.captainSessionKey, {
              type: "task_updated",
              teamId: input.teamId,
              taskId: input.taskId,
              status: next.status,
              attemptId: next.attemptId,
            });
          }
        }
        void scheduler.onTaskGraphChanged(input.teamId).catch(() => undefined);
      }
      return {
        content: [
          {
            type: "text",
            text: `team_update_task taskId=${input.taskId} status=${input.status} attempt=${next?.attempt ?? 0}`,
          },
        ],
        data: {
          teamId: input.teamId,
          taskId: input.taskId,
          status: next?.status ?? input.status,
          attempt: next?.attempt ?? 0,
          ...(next?.assigneeId !== undefined ? { assigneeId: next.assigneeId } : {}),
          ...(next?.output !== undefined ? { output: next.output } : {}),
        },
      };
    },
  };
}

export type TeamReassignTaskInput = { teamId: string; taskId: string; memberId?: string; reason?: string };
export type TeamReassignTaskOutput = { teamId: string; taskId: string; status: string; assigneeId?: string };

export function createTeamReassignTaskTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamReassignTaskInput, TeamReassignTaskOutput> {
  const { db, scheduler, emit } = options;
  return {
    name: "team_reassign_task",
    outputSchema: {
      type: "object",
      required: ["teamId", "taskId", "status"],
      properties: {
        teamId: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string" },
        assigneeId: { type: "string" },
      },
    },
    description:
      "Reassign a non-terminal task: to a specific member (immediately re-dispatched to them) or back to the pool without a memberId (held in 'reassigning' state, not auto-dispatched until reassigned again). The previous attemptId becomes stale — late writes are rejected. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        taskId: { type: "string", description: "Task id." },
        memberId: {
          type: "string",
          description: "Target member id. Omit to return the task to the pool (held, not auto-dispatched).",
        },
        reason: { type: "string", description: "Optional reassignment reason." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamReassignTaskOutput>> => {
      const actor = resolveActor(context.sessionId);
      requireCaptain(actor);
      let assigned: { status: string; assigneeId?: string } | undefined;
      await withTeamLock(input.teamId, async () => {
        const task = db.getTask(input.teamId, input.taskId);
        if (task === undefined) {
          throw new SatiToolRuntimeError("team_task_not_found", `任务不存在：${input.taskId}`);
        }
        if (TERMINAL_TASK_STATUSES.includes(task.status)) {
          throw new SatiToolRuntimeError("team_task_terminal", `终态任务不可转派：${input.taskId}`);
        }
        const fromMemberId = task.assigneeId ?? "";
        const next = input.memberId === undefined
          ? invalidateTaskAttempt(task, { reassigning: true }) // 回池：暂缓自动派发
          : invalidateTaskAttempt(task, { nextAssigneeId: input.memberId }); // 指定成员：可被 nextReadyTask 命中
        db.updateTask(next);
        const team = db.getTeam(input.teamId);
        if (team !== undefined) {
          emit(team.captainSessionKey, {
            type: "task_reassigned",
            teamId: input.teamId,
            taskId: input.taskId,
            fromMemberId,
            toMemberId: input.memberId ?? "",
          });
        }
        assigned = { status: next.status, ...(next.assigneeId !== undefined ? { assigneeId: next.assigneeId } : {}) };
        if (input.memberId !== undefined) {
          void scheduler.kickMember(input.teamId, input.memberId).catch(() => undefined);
        }
      });
      return {
        content: [
          {
            type: "text",
            text: `team_reassign_task taskId=${input.taskId} assignee=${input.memberId ?? "pool"}`,
          },
        ],
        data: { teamId: input.teamId, taskId: input.taskId, ...assigned! },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamTasks.spec.js`
Expected: PASS——6/6。

- [ ] **Step 5: Commit**

```bash
git add src/tool/builtin/team/teamTasks.ts tests/tool/builtin/team/teamTasks.spec.ts
git commit -m "feat(tool): team_create_task/team_update_task/team_reassign_task（blockedByCount 实时维护）"
```

---

### Task 7: teamMailbox.ts + teamStatus.ts——team_send_message / team_status

**Files:**
- Create: `src/tool/builtin/team/teamMailbox.ts`
- Create: `src/tool/builtin/team/teamStatus.ts`
- Test: `tests/tool/builtin/team/teamMailboxStatus.spec.ts`

`team_send_message` 为作业面（`team`）：队长或成员均可发（收件人须为团队成员）；`team_status` 为作业面（`team`）：队长与成员均可查。消息投递复用 mailbox 租约写入（`insertMessage`），锁外 `kickMember(recipient)` 触发既有邮箱优先投递路径。

- [ ] **Step 1: Write the failing test**

```ts
// tests/tool/builtin/team/teamMailboxStatus.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TeamDb,
  createTeamMember,
  type TeamEvent,
  type TeamEventEmitter,
  type TeamScheduler,
} from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import { createTeamSendMessageTool, createTeamStatusTool } from "../../../../src/tool/builtin/team/index.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-team-mailbox-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const kicked: string[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {
    kickMember: async (_teamId: string, memberId: string) => {
      kicked.push(memberId);
    },
    onTaskGraphChanged: async () => {},
  } as unknown as TeamScheduler;
  const tools = {
    sendMessage: createTeamSendMessageTool({ db, scheduler, emit }),
    status: createTeamStatusTool({ db, scheduler, emit }),
  };
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1", memberId: "m1", roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  return { root, db, events, kicked, tools };
}

test("team_send_message：captain 投递 + 落库 + message_delivered + kickMember", async () => {
  const { db, events, kicked, tools } = setup();
  const out = await tools.sendMessage.execute(
    { teamId: "t1", recipient: "m1", content: "请核实对比文件 D2" },
    { sessionId: "cap-1" } as never,
  );
  const data = out.data as { messageId: string };
  const msgs = db.listMessages("t1", "m1");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.sender, "captain");
  assert.equal(msgs[0]!.recipient, "m1");
  assert.equal(msgs[0]!.content, "请核实对比文件 D2");
  assert.ok(events.some(e => e.type === "message_delivered" && e.recipient === "m1"));
  assert.ok(kicked.includes("m1"), "投递后应触发成员唤醒（邮箱优先路径）");
});

test("team_send_message：成员互发（sender=memberId）；未知团队/未知收件人/退休收件人拒绝", async () => {
  const { db, tools } = setup();
  createTeamMember(db, {
    teamId: "t1", memberId: "m2", roleSlug: "drafter",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  await tools.sendMessage.execute(
    { teamId: "t1", recipient: "m2", content: "从权 2 的表述" },
    { sessionId: "team:t1:m1" } as never,
  );
  const msgs = db.listMessages("t1", "m2");
  assert.equal(msgs[0]!.sender, "m1");

  await assert.rejects(
    () => tools.sendMessage.execute({ teamId: "no-such", recipient: "m1", content: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  await assert.rejects(
    () => tools.sendMessage.execute({ teamId: "t1", recipient: "no-such", content: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_member",
  );
  // 退休收件人拒绝
  db.insertRetired(db.getMember("m2")!.sessionKey, "m2", "test");
  await assert.rejects(
    () => tools.sendMessage.execute({ teamId: "t1", recipient: "m2", content: "x" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_member_retired",
  );
});

test("team_status：三视图只读（团队/成员含 roleSlug+modelRoute+retired/任务含 blockedByCount+handoffId）", async () => {
  const { db, tools } = setup();
  db.insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "claimed", assigneeId: "m1",
    dependencies: [], attempt: 1, attemptId: "attempt-1", reassigning: false, blockedByCount: 0, maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
  });
  const out = await tools.status.execute({ teamId: "t1" }, { sessionId: "cap-1" } as never);
  const data = out.data as {
    team: { id: string; name: string };
    members: Array<{ memberId: string; roleSlug: string; status: string; modelRoute: unknown; retired: boolean }>;
    tasks: Array<{ taskId: string; status: string; attempt: number; assigneeId?: string; blockedByCount: number }>;
  };
  assert.equal(data.team.id, "t1");
  assert.equal(data.members.length, 1);
  assert.equal(data.members[0]!.roleSlug, "researcher");
  assert.equal(data.members[0]!.retired, false);
  assert.deepEqual(data.members[0]!.modelRoute, { provider: "fake", model: "fake-model" });
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0]!.status, "claimed");
  assert.equal(data.tasks[0]!.blockedByCount, 0);

  // 未知团队拒绝；成员可查（作业面）
  await assert.rejects(
    () => tools.status.execute({ teamId: "no-such" }, { sessionId: "cap-1" } as never),
    (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
  );
  const memberView = await tools.status.execute({ teamId: "t1" }, { sessionId: "team:t1:m1" } as never);
  assert.equal((memberView.data as { team: { id: string } }).team.id, "t1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamMailboxStatus.spec.js`
Expected: FAIL——`Cannot find module`。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tool/builtin/team/teamMailbox.ts
/**
 * 成员邮箱工具（M3）：team_send_message——队长或成员投递持久消息（复用 mailbox 租约写入），
 * 锁外 kickMember(recipient) 触发既有「邮箱优先」投递路径（unreadMessages → claimDelivery → wake → ack）。
 * 作业面（domain: "team"）。注意：captain 离线时调度器暂停投递（消息留邮箱，队长回来再投）——
 * 与 isCaptainOnline 统一语义。
 */
import { randomUUID } from "node:crypto";
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { withTeamLock } from "../../../agent/team/index.js";
import type { TeamDb } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { requireTeamMember, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

export type TeamSendMessageInput = { teamId: string; recipient: string; content: string };
export type TeamSendMessageOutput = { messageId: string; teamId: string; recipient: string; sender: string };

export function createTeamSendMessageTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamSendMessageInput, TeamSendMessageOutput> {
  const { db, scheduler, emit } = options;
  return {
    name: "team_send_message",
    outputSchema: {
      type: "object",
      required: ["messageId", "teamId", "recipient", "sender"],
      properties: {
        messageId: { type: "string" },
        teamId: { type: "string" },
        recipient: { type: "string" },
        sender: { type: "string" },
      },
    },
    description:
      "Send a persistent message to a team member's mailbox. The member is woken (mailbox takes priority over task dispatch); if the captain is offline the message is held until the captain's connection returns. Team members may message each other; the captain may message any member. Recipient must be a non-retired member of the team.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId", "recipient", "content"],
      additionalProperties: false,
      properties: {
        teamId: { type: "string", description: "Team id." },
        recipient: { type: "string", description: "Member id of the recipient." },
        content: { type: "string", description: "Message content." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamSendMessageOutput>> => {
      const actor = resolveActor(context.sessionId);
      // 非队长会话须为团队成员（成员身份校验）
      const senderId =
        actor === undefined || actor.captain ? "captain" : requireTeamMember(db, actor, input.teamId);
      let messageId = "";
      await withTeamLock(input.teamId, async () => {
        const team = db.getTeam(input.teamId);
        if (team === undefined) {
          throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
        }
        const recipient = db.getMember(input.recipient);
        if (recipient === undefined || recipient.teamId !== input.teamId) {
          throw new SatiToolRuntimeError("team_not_member", `收件人不存在：${input.recipient}`);
        }
        if (db.isRetired(recipient.sessionKey)) {
          throw new SatiToolRuntimeError("team_member_retired", `收件人已退休：${input.recipient}`);
        }
        messageId = `msg-${randomUUID().slice(0, 8)}`;
        db.insertMessage({
          id: messageId,
          teamId: input.teamId,
          sender: senderId,
          recipient: input.recipient,
          content: input.content,
          createdAt: new Date().toISOString(),
        });
        emit(team.captainSessionKey, {
          type: "message_delivered",
          teamId: input.teamId,
          recipient: input.recipient,
          sender: senderId,
        });
      });
      // 锁外唤醒收件人（邮箱优先投递路径）
      void scheduler.kickMember(input.teamId, input.recipient).catch(() => undefined);
      return {
        content: [{ type: "text", text: `team_send_message messageId=${messageId} recipient=${input.recipient}` }],
        data: { messageId, teamId: input.teamId, recipient: input.recipient, sender: senderId },
      };
    },
  };
}
```

```ts
// src/tool/builtin/team/teamStatus.ts
/**
 * 团队状态工具（M3）：team_status——三视图只读（团队概览/成员状态/任务列表），
 * 纯查询无副作用（isReadOnly: true）。作业面（domain: "team"）：队长与成员均可查。
 * 成员视图含 status/roleSlug/modelRoute（modelRouteJson 解析）；任务视图含
 * status/attempt/assigneeId/dependencies/blockedByCount/handoffId。
 */
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import type { TeamDb, TeamTaskStatus } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { requireTeamMember, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

export type TeamStatusInput = { teamId: string };
export type TeamStatusOutput = {
  team: { id: string; name: string; captainSessionKey: string; createdAt: string };
  members: Array<{
    memberId: string;
    roleSlug: string;
    status: "idle" | "working";
    modelRoute: unknown;
    retired: boolean;
  }>;
  tasks: Array<{
    taskId: string;
    subject: string;
    status: TeamTaskStatus;
    attempt: number;
    assigneeId?: string;
    dependencies: string[];
    blockedByCount: number;
    handoffId?: string;
    output?: string;
  }>;
};

export function createTeamStatusTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamStatusInput, TeamStatusOutput> {
  const { db } = options;
  return {
    name: "team_status",
    outputSchema: {
      type: "object",
      required: ["team", "members", "tasks"],
      properties: {
        team: {
          type: "object",
          required: ["id", "name", "captainSessionKey", "createdAt"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            captainSessionKey: { type: "string" },
            createdAt: { type: "string" },
          },
        },
        members: {
          type: "array",
          items: {
            type: "object",
            required: ["memberId", "roleSlug", "status", "modelRoute", "retired"],
            properties: {
              memberId: { type: "string" },
              roleSlug: { type: "string" },
              status: { type: "string" },
              modelRoute: { type: "object", properties: {} },
              retired: { type: "boolean" },
            },
          },
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: ["taskId", "subject", "status", "attempt", "dependencies", "blockedByCount"],
            properties: {
              taskId: { type: "string" },
              subject: { type: "string" },
              status: { type: "string" },
              attempt: { type: "number" },
              assigneeId: { type: "string" },
              dependencies: { type: "array", items: { type: "string" } },
              blockedByCount: { type: "number" },
              handoffId: { type: "string" },
              output: { type: "string" },
            },
          },
        },
      },
    },
    description:
      "Read-only snapshot of a team: overview (id/name/captain), members (id/roleSlug/status/modelRoute/retired), and tasks (id/subject/status/attempt/assignee/dependencies/blockedByCount/handoffId/output). Captain and team members can both call it.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId"],
      additionalProperties: false,
      properties: { teamId: { type: "string", description: "Team id." } },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamStatusOutput>> => {
      const actor = resolveActor(context.sessionId);
      if (actor !== undefined && !actor.captain) {
        requireTeamMember(db, actor, input.teamId); // 成员校验（仅校验身份，不返回使用）
      }
      const team = db.getTeam(input.teamId);
      if (team === undefined) {
        throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
      }
      const members = db
        .listMembers()
        .filter(m => m.teamId === input.teamId)
        .map(m => ({
          memberId: m.id,
          roleSlug: m.roleSlug,
          status: m.status,
          modelRoute: JSON.parse(m.modelRouteJson) as unknown,
          retired: db.isRetired(m.sessionKey),
        }));
      const tasks = db.listTasks(input.teamId).map(t => ({
        taskId: t.id,
        subject: t.subject,
        status: t.status,
        attempt: t.attempt,
        ...(t.assigneeId !== undefined ? { assigneeId: t.assigneeId } : {}),
        dependencies: t.dependencies,
        blockedByCount: t.blockedByCount,
        ...(t.handoffId !== undefined ? { handoffId: t.handoffId } : {}),
        ...(t.output !== undefined ? { output: t.output } : {}),
      }));
      return {
        content: [
          {
            type: "text",
            text: `team_status team=${team.id} members=${members.length} tasks=${tasks.length}`,
          },
        ],
        data: {
          team: {
            id: team.id,
            name: team.name,
            captainSessionKey: team.captainSessionKey,
            createdAt: team.createdAt,
          },
          members,
          tasks,
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamMailboxStatus.spec.js`
Expected: PASS——3/3。

- [ ] **Step 5: Commit**

```bash
git add src/tool/builtin/team/teamMailbox.ts src/tool/builtin/team/teamStatus.ts tests/tool/builtin/team/teamMailboxStatus.spec.ts
git commit -m "feat(tool): team_send_message/team_status（邮箱租约投递 + 三视图只读）"
```

---

### Task 8: teamArchive.ts + teams.db v3 迁移 + scheduler archived 跳过

**Files:**
- Modify: `src/agent/team/storage/team-db.ts`（TeamRow + v3 迁移 + archiveTeam/isArchived）
- Modify: `src/agent/team/scheduler/scheduler.ts`（kickTeam/kickMember archived 检查）
- Create: `src/tool/builtin/team/teamArchive.ts`
- Test: `tests/tool/builtin/team/teamArchive.spec.ts` + `tests/agent/team/team-db.spec.ts` 追加 v3 用例

归档语义：`team_archive` → 锁内复查（非 archived）→ 置 `archivedAt` + 全部成员 `insertRetired(reason: "team_archived")` → 触发 `team_archived`。调度器认领前检查团队状态（与 isCaptainOnline 同点：archived 或 captain 离线 → 跳过）。归档不可逆（M3 无 unarchive）。

- [ ] **Step 1: Write the failing test**

```ts
// tests/tool/builtin/team/teamArchive.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TeamDb,
  createTeamMember,
  type TeamEvent,
  type TeamEventEmitter,
  type TeamScheduler,
} from "../../../../src/agent/team/index.js";
import { SatiToolRuntimeError } from "../../../../src/tool/protocol/errors.js";
import { createTeamArchiveTool } from "../../../../src/tool/builtin/team/index.js";

test("team_archive：置 archivedAt + 成员全退休 + team_archived 事件 + 数据保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-archive-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events: TeamEvent[] = [];
  const emit: TeamEventEmitter = (_key, event) => {
    events.push(event);
    return true;
  };
  const scheduler = {} as unknown as TeamScheduler;
  const archive = createTeamArchiveTool({ db, scheduler, emit });

  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1", memberId: "m1", roleSlug: "researcher",
    modelRoute: { provider: "fake", model: "fake-model" },
  });
  db.insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "completed", assigneeId: "m1",
    dependencies: [], attempt: 1, attemptId: "attempt-1", reassigning: false, blockedByCount: 0,
    maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
  });
  try {
    const out = await archive.execute({ teamId: "t1" }, { sessionId: "cap-1" } as never);
    assert.equal((out.data as { archived: boolean }).archived, true);
    assert.ok(db.getTeam("t1")!.archivedAt !== undefined, "archivedAt 已置");
    assert.ok(db.isRetired(db.getMember("m1")!.sessionKey), "成员已退休");
    assert.equal(db.getTask("t1", "a")?.status, "completed", "任务数据保留只读");
    assert.ok(events.some(e => e.type === "team_archived" && e.teamId === "t1"));

    // 重复归档拒绝
    await assert.rejects(
      () => archive.execute({ teamId: "t1" }, { sessionId: "cap-1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_already_archived",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("team_archive：未知团队/成员会话拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-archive2-"));
  const db = new TeamDb(join(root, "teams.db"));
  const emit: TeamEventEmitter = () => true;
  const archive = createTeamArchiveTool({ db, scheduler: {} as unknown as TeamScheduler, emit });
  try {
    await assert.rejects(
      () => archive.execute({ teamId: "no-such" }, { sessionId: "cap-1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_found",
    );
    await assert.rejects(
      () => archive.execute({ teamId: "no-such" }, { sessionId: "team:t1:m1" } as never),
      (e: unknown) => e instanceof SatiToolRuntimeError && e.code === "team_not_captain",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// tests/agent/team/team-db.spec.ts 追加（若文件不存在则新建）：
test("teams.db v3：archived_at 列迁移 + archiveTeam/isArchived", () => {
  // 先以 v2 建库，再升 v3 验证迁移
  const root = mkdtempSync(join(tmpdir(), "sati-team-db-v3-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    assert.equal(db.isArchived("t1"), false);
    assert.equal(db.archiveTeam("t1", "2026-08-20T00:00:00.000Z"), true);
    assert.equal(db.isArchived("t1"), true);
    assert.equal(db.getTeam("t1")?.archivedAt, "2026-08-20T00:00:00.000Z");
    assert.equal(db.archiveTeam("t1", "2026-08-20T00:01:00.000Z"), false, "重复归档返回 false");
    // 未知团队
    assert.equal(db.archiveTeam("no-such", "2026-08-20T00:00:00.000Z"), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamArchive.spec.js dist/tests/agent/team/team-db.spec.js`
Expected: FAIL——`Cannot find module` + `archiveTeam is not a function`。

- [ ] **Step 3: 存储层 v3 迁移**

`src/agent/team/storage/team-db.ts`：

1. `MIGRATIONS` 数组末尾追加（v3）：
```ts
  // v3：团队归档（M3）——archived_at 置位后调度器跳过该团队、成员全退休
  `ALTER TABLE teams ADD COLUMN archived_at TEXT;`,
```

2. `TeamRow` 加字段：
```ts
export type TeamRow = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
  /** M3：归档时刻（ISO）；undefined = 未归档。归档不可逆（无 unarchive）。 */
  archivedAt?: string;
};
```

3. `toTeamRow`（SELECT 行映射）加：
```ts
  archivedAt: row.archived_at ?? undefined,
```
（`row` 为 `TeamDbRow` 类型——实施时若该类型缺 `archived_at` 字段则补 `archived_at: string | null`。）

4. 新增两方法（`listMembers` 旁）：
```ts
  /** 归档团队：置 archived_at（仅未归档团队可归档）。返回是否生效。 */
  archiveTeam(teamId: string, archivedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE teams SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(archivedAt, teamId);
    return result.changes > 0;
  }

  isArchived(teamId: string): boolean {
    const row = this.db
      .prepare("SELECT archived_at FROM teams WHERE id = ?")
      .get(teamId) as { archived_at: string | null } | undefined;
    return row !== undefined && row.archived_at !== null;
  }
```

- [ ] **Step 4: 调度器 archived 跳过**

`src/agent/team/scheduler/scheduler.ts`——`kickTeam` 与 `kickMember` 开头检查（两处同款，91 行与 102 行）：
```ts
    const team = this.db.getTeam(teamId);
    // M3：归档团队跳过调度（与 isCaptainOnline 同点——archived 或 captain 离线 → 暂停认领）
    if (team === undefined || team.archivedAt !== undefined || !this.isCaptainOnline(team.captainSessionKey)) return;
```

- [ ] **Step 5: 实现 teamArchive.ts**

```ts
// src/tool/builtin/team/teamArchive.ts
/**
 * 团队归档工具（M3）：team_archive——锁内复查（非 archived）→ 置 archivedAt + 全部成员
 * 退休（reason: "team_archived"）→ team_archived 事件。调度器认领前检查 archivedAt（跳过）。
 * 归档不可逆（无 unarchive；重建 = 新队）。管理面（domain: "team:manage"）。
 */
import type { SatiToolDefinition, SatiToolExecutionOutput } from "../../protocol/types.js";
import { withTeamLock } from "../../../agent/team/index.js";
import type { TeamDb } from "../../../agent/team/index.js";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { requireCaptain, resolveActor, type TeamToolsOptions } from "./teamUtils.js";

export type TeamArchiveInput = { teamId: string };
export type TeamArchiveOutput = { teamId: string; archived: boolean };

export function createTeamArchiveTool(
  options: TeamToolsOptions,
): SatiToolDefinition<TeamArchiveInput, TeamArchiveOutput> {
  const { db, emit } = options;
  return {
    name: "team_archive",
    outputSchema: {
      type: "object",
      required: ["teamId", "archived"],
      properties: { teamId: { type: "string" }, archived: { type: "boolean" } },
    },
    description:
      "Archive a team (irreversible): the team is marked archived, all members are retired (no longer woken), and the scheduler stops dispatching to it. Tasks and messages remain readable. Captain-only.",
    kind: "team",
    inputSchema: {
      type: "object",
      required: ["teamId"],
      additionalProperties: false,
      properties: { teamId: { type: "string", description: "Team id." } },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => true,
    execute: async (input, context): Promise<SatiToolExecutionOutput<TeamArchiveOutput>> => {
      const actor = resolveActor(context.sessionId);
      requireCaptain(actor);
      await withTeamLock(input.teamId, async () => {
        const team = db.getTeam(input.teamId);
        if (team === undefined) {
          throw new SatiToolRuntimeError("team_not_found", `团队不存在：${input.teamId}`);
        }
        if (team.archivedAt !== undefined) {
          throw new SatiToolRuntimeError("team_already_archived", `团队已归档：${input.teamId}`);
        }
        const archivedAt = new Date().toISOString();
        db.archiveTeam(input.teamId, archivedAt);
        // 成员全退休（reason: "team_archived"）——退休成员不再被唤醒
        for (const member of db.listMembers().filter(m => m.teamId === input.teamId)) {
          if (!db.isRetired(member.sessionKey)) {
            db.insertRetired(member.sessionKey, member.id, "team_archived");
          }
        }
        emit(context.sessionId, { type: "team_archived", teamId: input.teamId });
      });
      return {
        content: [{ type: "text", text: `team_archive teamId=${input.teamId} archived` }],
        data: { teamId: input.teamId, archived: true },
      };
    },
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/teamArchive.spec.js dist/tests/agent/team/team-db.spec.js`
Expected: PASS——2 + 1。

- [ ] **Step 7: 事件矩阵重生成 + Commit**

```bash
pnpm gen:event-matrix
git add src/agent/team/storage/team-db.ts src/agent/team/scheduler/scheduler.ts src/tool/builtin/team/teamArchive.ts tests/tool/builtin/team/teamArchive.spec.ts tests/agent/team/team-db.spec.ts docs/event-producer-consumer.md
git commit -m "feat(tool): team_archive（teams.db v3 archived_at 迁移 + 调度器跳过 + 成员全退休）"
```

---

### Task 9: 注册接线——createBuiltinRegistry team options + createLocalGateway 传参

**Files:**
- Modify: `src/tool/registry/createBuiltinRegistry.ts`（options + 注册段）
- Modify: `src/cli/createLocalGateway.ts`（createBuiltinRegistry 调用传参）
- Test: `tests/tool/registry/createBuiltinRegistry.spec.ts` 追加（或新建冒烟）

9 个工具按 domain 打标注册：管理类 6 个 `team:manage`（team_create/team_add_member/team_remove_member/team_create_task/team_reassign_task/team_archive），作业类 3 个 `team`（team_update_task/team_send_message/team_status）。

- [ ] **Step 1: Write the failing test（冒烟）**

```ts
// tests/tool/registry/createBuiltinRegistry.spec.ts 追加（若文件不存在则新建）
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { TeamDb } from "../../../src/agent/team/index.js";
import { createTeamCreateTool } from "../../../src/tool/builtin/team/index.js";

test("createBuiltinRegistry：team options 注入后 9 工具注册且 domain 正确", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-registry-team-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    const scheduler = {} as never;
    const emit = () => true;
    const registry = createBuiltinRegistry({
      team: { db, scheduler, emit },
    });
    const domains = new Map<string, string>();
    for (const name of [
      "team_create", "team_add_member", "team_remove_member",
      "team_create_task", "team_update_task", "team_reassign_task",
      "team_send_message", "team_status", "team_archive",
    ]) {
      const tool = registry.lookup(name);
      assert.ok(tool, `工具未注册：${name}`);
      const domain = (tool as { domain?: string }).domain;
      assert.ok(domain !== undefined, `${name} 应有 domain`);
      domains.set(name, domain!);
    }
    // 管理面 6 个 team:manage；作业面 3 个 team
    for (const name of ["team_create", "team_add_member", "team_remove_member", "team_create_task", "team_reassign_task", "team_archive"]) {
      assert.equal(domains.get(name), "team:manage", name);
    }
    for (const name of ["team_update_task", "team_send_message", "team_status"]) {
      assert.equal(domains.get(name), "team", name);
    }
    // 未传 team options 时不注册
    const plain = createBuiltinRegistry({});
    assert.equal(plain.lookup("team_create"), undefined);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

> ⚠️ `registry.lookup` 返回类型与 `SatiToolDefinition.domain` 字段的暴露方式以 `src/tool/registry/ToolRegistry.ts` 实际实现为准（annotate 打标的 domain 若不在注册对象上则改断言 `(tool as { domain?: string })`；若 domain 存于独立元数据，则通过 registry 的 domain 查询 API 断言——实施时对照 ToolRegistry 源码调整断言方式，断言目标不变：6 管理 + 3 作业）。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && node --test dist/tests/tool/registry/createBuiltinRegistry.spec.js`
Expected: FAIL——`工具未注册：team_create`。

- [ ] **Step 3: createBuiltinRegistry 接线**

`src/tool/registry/createBuiltinRegistry.ts`：

1. 顶部导入（`CreateBuiltinRegistryOptions` 前）：
```ts
import {
  createTeamCreateTool,
  createTeamAddMemberTool,
  createTeamRemoveMemberTool,
  createTeamCreateTaskTool,
  createTeamUpdateTaskTool,
  createTeamReassignTaskTool,
  createTeamSendMessageTool,
  createTeamStatusTool,
  createTeamArchiveTool,
  type TeamToolsOptions,
} from "../builtin/team/index.js";
```

2. `CreateBuiltinRegistryOptions` 加字段（`webSearch` 字段旁，带注释）：
```ts
  /**
   * team_* 工具（M3）：团队编排工具面——9 工具（建队/招募/退休/任务/消息/状态/归档）。
   * 注入 createLocalGateway 的 teamDb + teamScheduler + 广播闭包；未传则不注册。
   * 管理面 6 工具 domain "team:manage"（仅 captain），作业面 3 工具 domain "team"（成员可见）。
   */
  team?: TeamToolsOptions;
```

3. 注册段（`registry.register(annotate(createGetCurrentTimeTool(), "session"));` 所在连续注册块内追加）：
```ts
  if (options.team !== undefined) {
    const { db, scheduler, emit } = options.team;
    // 管理面（team:manage，仅 captain）
    registry.register(annotate(createTeamCreateTool({ db, scheduler, emit }), "team:manage"));
    registry.register(annotate(createTeamAddMemberTool({ db, scheduler, emit }), "team:manage"));
    registry.register(annotate(createTeamRemoveMemberTool({ db, scheduler, emit }), "team:manage"));
    registry.register(annotate(createTeamCreateTaskTool({ db, scheduler, emit }), "team:manage"));
    registry.register(annotate(createTeamReassignTaskTool({ db, scheduler, emit }), "team:manage"));
    registry.register(annotate(createTeamArchiveTool({ db, scheduler, emit }), "team:manage"));
    // 作业面（team，成员角色可见）
    registry.register(annotate(createTeamUpdateTaskTool({ db, scheduler, emit }), "team"));
    registry.register(annotate(createTeamSendMessageTool({ db, scheduler, emit }), "team"));
    registry.register(annotate(createTeamStatusTool({ db, scheduler, emit }), "team"));
  }
```

- [ ] **Step 4: createLocalGateway 传参**

`src/cli/createLocalGateway.ts`——`createBuiltinRegistry({ ... })` 调用（~1003 行）加：
```ts
    const tools = createBuiltinRegistry({
      backgroundTasks: { runtime: backgroundTasks },
      searchPatentFigure: { embeddingClient },
      ...(memory?.service ? { memory: { service: memory.service } } : {}),
      // M3：团队工具面——注入 teamDb/teamScheduler/广播闭包（emitForSession + toGatewayEvent 同款）
      team: {
        db: teamDb,
        scheduler: teamScheduler,
        emit: (captainSessionKey, event) => gateway.emitForSession(captainSessionKey, toGatewayEvent(event)),
      },
      readSkill: {
        loader: name => pluginRuntime.loadSkillPrompt(name),
        lister: () => pluginRuntime.getAllSkills(),
      },
      ...
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && node --test dist/tests/tool/registry/createBuiltinRegistry.spec.js`
Expected: PASS——9 工具注册 + domain 断言全过。

- [ ] **Step 6: 回归（团队 + registry 既有测试）**

Run: `node --test dist/tests/agent/team/ dist/tests/tool/`
Expected: PASS——无回归（team options 可选，未传路径零变化）。

- [ ] **Step 7: Commit**

```bash
git add src/tool/registry/createBuiltinRegistry.ts src/cli/createLocalGateway.ts tests/tool/registry/createBuiltinRegistry.spec.ts
git commit -m "feat(tool): 注册 team_* 9 工具（管理面 team:manage / 作业面 team domain 打标）"
```

---

### Task 10: scanner 路径 onMemberIdle 接线 + C2 检查共享化

**Files:**
- Modify: `src/cli/createLocalGateway.ts`（runMemberScan onEvent + wake 包装层 turn_completed 分支）

**问题**（M2 最终复审观察项 3）：`runMemberScan` 冷恢复回合的 turn_completed 只经 `teamForwarder.handleMemberEvent`（审批冒泡），不触发 `onMemberIdle` → 冷恢复回合后任务保持 claimed 直至下次 stranded 扫描。且若只补 `onMemberIdle` 而不带 C2 检查，冷恢复 re-claim 循环**无界**（wake 包装层的 C2 检查在 scanner 路径缺失）——接线须与 wake 包装层 turn_completed 分支完全对齐。

**做法**：把 C2 检查 + onMemberIdle 调用提取为共享函数 `handleMemberTurnCompleted(db, teamId, memberId)`（createLocalGateway 内模块级函数），wake 包装层与 scanner onEvent 两处复用——消除双份内联（回应 M2 I3 观察项「attemptsExhausted 复用」的延伸）。

- [ ] **Step 1: 实现（接线 + 重构，回归由 Task 12 集成测试覆盖）**

`src/cli/createLocalGateway.ts`：

1. 模块级共享函数（`runMemberScan` 定义前）：
```ts
/**
 * M3（复审观察项 3 闭环 + C2 共享化）：成员回合结束的统一收口——
 * C2 检查（attempt 达 maxAttempts 仍无进展 → 置 failed 终止 re-claim 循环）+ onMemberIdle 续派。
 * wake 包装层与 scanner 冷恢复路径共用（两路径行为对齐）。
 * onMemberIdle 的 rejection 静默吞掉（onEvent 契约：回调不得抛出）。
 */
function handleMemberTurnCompleted(db: TeamDb, teamId: string, memberId: string): void {
  const open = ownedOpenTask(db.listTasks(teamId), memberId);
  if (open !== undefined) {
    const fresh = db.getTask(teamId, open.id);
    if (fresh !== undefined && attemptsExhausted(fresh)) {
      const guard = validateAttemptUpdate(fresh, fresh.attemptId);
      if (guard === undefined) {
        db.updateTask({ ...fresh, status: "failed", updatedAt: new Date().toISOString() });
      }
    }
  }
  void teamScheduler.onMemberIdle(teamId, memberId).catch(() => undefined);
}
```
（`TeamDb`/`ownedOpenTask`/`attemptsExhausted`/`validateAttemptUpdate` 均已导入；`teamScheduler` 为闭包内变量——若函数定义位置在 teamScheduler 构造前无法引用，则将函数定义移动到 teamScheduler 构造之后、`runMemberScan` 保持原位置（runMemberScan 定义在 teamScheduler 之前——实施时以实际行序安排：函数体内引用 teamScheduler 时用**参数传递**而非闭包，见下条）。）

> 若 `runMemberScan`（466 行）定义在 `teamScheduler`（499 行）之前，改为参数传递消除顺序依赖：
```ts
function handleMemberTurnCompleted(db: TeamDb, teamSchedulerRef: TeamScheduler, teamId: string, memberId: string): void {
  ...
  void teamSchedulerRef.onMemberIdle(teamId, memberId).catch(() => undefined);
}
```
（wake 包装层与 scanner 两处调用均传 `teamScheduler`。）

2. wake 包装层 turn_completed 分支替换为共享函数调用（~530-545 行 C2 内联块删除，改为）：
```ts
            if (event.type === "turn_completed" && member?.teamId !== undefined) {
              // M3：C2 检查 + onMemberIdle 统一收口（与 scanner 冷恢复路径共享）
              handleMemberTurnCompleted(teamDb, teamScheduler, member.teamId, memberId);
            }
```

3. runMemberScan 的 onEvent（~475 行）加续派：
```ts
      onEvent: (member, event) => {
        teamForwarder.handleMemberEvent(member, event);
        // M3（复审观察项 3）：冷恢复回合结束 → 与 wake 包装层同款收口（C2 + onMemberIdle 续派）
        if (event.type === "turn_completed" && member.teamId !== undefined) {
          handleMemberTurnCompleted(teamDb, teamScheduler, member.teamId, member.id);
        }
      },
```

- [ ] **Step 2: Build + 既有团队测试回归**

Run: `pnpm build && node --test dist/tests/agent/team/`
Expected: PASS——3 集成用例 + 单测（wake 包装层行为不变：共享函数与原内联逻辑等价）。

- [ ] **Step 3: Commit**

```bash
git add src/cli/createLocalGateway.ts
git commit -m "fix(agent): scanner 冷恢复回合结束接 onMemberIdle 续派（C2 检查共享化，两路径对齐）"
```

---

### Task 11: message_delivered payload 演进（senders[]）

**Files:**
- Modify: `src/agent/team/protocol/events.ts`（TeamEvent message_delivered 变体）
- Modify: `src/agent/team/scheduler/scheduler.ts`（144-152 行投递点）
- Modify: `docs/event-producer-consumer.md`（重生成）

additive 变更：新增 `senders: string[]`（批次完整发送者列表）；`sender` 保留（= senders[0]，兼容既有消费方）。协议不升版（Web 1.0 客户端未知字段忽略）。

- [ ] **Step 1: 实现（类型 + 投递点 + 事件矩阵）**

`src/agent/team/protocol/events.ts`：
```ts
  | {
      type: "message_delivered";
      teamId: string;
      recipient: string;
      /** 批次首条发送者（= senders[0]，兼容既有消费方）。 */
      sender: string;
      /** M3：批次完整发送者列表（additive——协议不升版，Web 客户端未知字段忽略）。 */
      senders: string[];
    }
```

`src/agent/team/scheduler/scheduler.ts`（144-152 行，I4 注释块替换）：
```ts
        // M3（I4 闭环）：批次粒度 payload——senders 完整列表，sender 保留首条（兼容）
        if (accepted)
          this.emit(team.captainSessionKey, {
            type: "message_delivered",
            teamId,
            recipient: memberId,
            sender: unread[0]?.sender ?? "captain",
            senders: unread.map(m => m.sender),
          });
```

- [ ] **Step 2: 事件矩阵重生成 + 回归**

Run: `pnpm gen:event-matrix && pnpm build && node --test dist/tests/agent/team/`
Expected: `pnpm gen:event-matrix` 成功（payload 类型变化在矩阵中体现）；团队测试全过（`senders` 为新增必填字段——`message_delivered` 事件构造点已全部更新：scheduler.ts 投递点 + Task 7 teamMailbox.ts 工具投递点）。

> ⚠️ 若 `teamMailbox.ts` 的 `emit` 调用处 TS 报缺 `senders`（Step 1 先于 Task 7 合并时），同步补 `senders: [senderId]`——本计划任务按序执行时 Task 7 已实现该字段（Task 7 代码中已含），直接编译通过。

- [ ] **Step 3: Commit**

```bash
git add src/agent/team/protocol/events.ts src/agent/team/scheduler/scheduler.ts docs/event-producer-consumer.md
git commit -m "feat(agent): message_delivered payload 增 senders[] 批次列表（sender 保留兼容，additive）"
```

---

### Task 12: 集成测试扩展——工具驱动全链

**Files:**
- Create: `tests/tool/builtin/team/team-tools-integration.spec.ts`

真实 createLocalGateway（fake model）+ 工具直调（factory execute）驱动全链：建队 → 招募 → 建任务 → 调度器认领 → **成员回合内 fake model 发 tool_call 调 team_update_task(completed)** → 任务终结 + 下游解锁 → reassign → archive → isCaptainOnline 离线暂停。fake model 带状态：首轮发工具调用，工具结果后收尾文本。

- [ ] **Step 1: Write the failing test**

```ts
// tests/tool/builtin/team/team-tools-integration.spec.ts
/**
 * 集成（M3）：team_* 工具 + 真实 createLocalGateway 全链——
 * 建队/招募/建任务 → 调度器认领 → 成员回合内 tool_call 调 team_update_task(completed)
 * → 任务终结（attempt 不再递增）+ 下游解锁续派；reassign/archive/isCaptainOnline 语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../../../src/cli/createLocalGateway.js";
import type { ModelRuntime } from "../../../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../../../src/model/protocol/capabilities.js";
import {
  createTeamCreateTool,
  createTeamAddMemberTool,
  createTeamCreateTaskTool,
} from "../../../../src/tool/builtin/team/index.js";

/**
 * 带状态 fake model：第 1 次 stream 发 team_update_task(completed) 工具调用；
 * 后续 stream 发文本收尾。工具调用参数 attemptId 从 assignment prompt 注入——
 * 简化：从任务当前 attemptId 直读（成员回合内 attemptId 已由调度器写入）。
 */
function completingMemberModel(taskTeamId: string, taskId: string): ModelRuntime {
  let streams = 0;
  return {
    stream: async function* () {
      streams += 1;
      if (streams === 1) {
        const args = JSON.stringify({
          teamId: taskTeamId,
          taskId,
          status: "completed",
          attemptId: "{{ATTEMPT_ID}}", // 占位：execute 前由测试替换真实 attemptId（见下）
          output: "检索完成：对比文件 D2 相关度 0.9。",
        });
        yield { type: "message_start", role: "assistant" };
        yield { type: "tool_call_start", id: "call-1", name: "team_update_task" };
        yield { type: "tool_call_delta", id: "call-1", delta: args };
        yield { type: "tool_call_end", id: "call-1", toolCall: { id: "call-1", name: "team_update_task", arguments: args } };
        return;
      }
      yield { type: "text_delta", text: "任务已完成。" };
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

const FAKE_SATI_YAML = [
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

test("集成：工具驱动全链——建队/招募/建任务 → 成员回合内 team_update_task 完成任务 → 下游解锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-tools-"));
  await writeFile(join(root, "sati.yaml"), FAKE_SATI_YAML, "utf8");
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: {},
    __testModelFactory: (): ModelRuntime => completingMemberModel("t1", "task-b"),
  });
  try {
    const team = result.teamSubsystem;
    const tools = {
      create: createTeamCreateTool({ db: team.db, scheduler: team.scheduler, emit: () => true }),
      addMember: createTeamAddMemberTool({ db: team.db, scheduler: team.scheduler, emit: () => true }),
      createTask: createTeamCreateTaskTool({ db: team.db, scheduler: team.scheduler, emit: () => true }),
    };
    const capCtx = { sessionId: "cap-1" } as never;

    // 建队 + 招募 researcher（roleSlug 需已注册——M3 角色接线前用既有角色兜底：
    // patent-retriever 为既有注册角色；若角色未注册则本测试需先 registerRoleDefinition）
    const created = (await tools.create.execute({ name: "集成团队", memberRoleSlugs: ["patent-retriever"] }, capCtx))
      .data as { teamId: string; members: Array<{ memberId: string }> };
    const teamId = created.teamId;
    const memberId = created.members[0]!.memberId;

    // 建任务 A（无依赖）→ 调度器认领 → 成员回合 tool_call 完成
    const taskA = (await tools.createTask.execute({ teamId, subject: "检索 D2" }, capCtx)).data as { taskId: string };
    // 轮询：成员回合完成 → 任务 A completed
    let a;
    for (let i = 0; i < 400; i += 1) {
      a = team.db.getTask(teamId, taskA.taskId);
      if (a?.status === "completed") break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(a?.status, "completed", "成员回合内 team_update_task 完成任务");
    assert.equal(a?.output, "检索完成：对比文件 D2 相关度 0.9。");
    assert.equal(a?.assigneeId, memberId);

    // 建任务 B（依赖 A）→ A 完成后自动认领 → 完成
    const taskB = (await tools.createTask.execute(
      { teamId, subject: "撰写权利要求", dependencies: [taskA.taskId] },
      capCtx,
    )).data as { taskId: string };
    let b;
    for (let i = 0; i < 400; i += 1) {
      b = team.db.getTask(teamId, taskB.taskId);
      if (b?.status === "completed") break;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(b?.status, "completed", "下游任务 A 完成后自动认领并完成");

    // 归档（captain）
    const archive = (await import("../../../../src/tool/builtin/team/index.js")).createTeamArchiveTool({
      db: team.db, scheduler: team.scheduler, emit: () => true,
    });
    await archive.execute({ teamId }, capCtx);
    assert.ok(team.db.isArchived(teamId));
    assert.ok(team.db.isRetired(team.db.getMember(memberId)!.sessionKey), "成员归档后退休");
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("集成：isCaptainOnline——captain 显式离线（touch+close 超宽限窗）→ 新任务不认领", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-offline-"));
  await writeFile(join(root, "sati.yaml"), FAKE_SATI_YAML, "utf8");
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: {},
    __testModelFactory: (): ModelRuntime => ({
      stream: async function* () {
        yield { type: "text_delta", text: "不会发生（captain 离线不派发）。" };
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
    const presence = result.sessionPresence;
    const tools = {
      create: createTeamCreateTool({ db: team.db, scheduler: team.scheduler, emit: () => true }),
      addMember: createTeamAddMemberTool({ db: team.db, scheduler: team.scheduler, emit: () => true }),
      createTask: createTeamCreateTaskTool({ db: team.db, scheduler: team.scheduler, emit: () => true }),
    };
    const capCtx = { sessionId: "cap-1" } as never;

    const created = (await tools.create.execute({ name: "离线团队", memberRoleSlugs: ["patent-retriever"] }, capCtx))
      .data as { teamId: string };
    // captain 显式"连过并断开超宽限窗"→ 离线
    const now = Date.now();
    presence.touch("cap-1", now);
    presence.close("cap-1", now);
    assert.equal(presence.isActive("cap-1", now + 120_000), false, "断开超 60s 宽限窗 → 离线");

    await tools.createTask.execute({ teamId: created.teamId, subject: "不应派发" }, capCtx);
    // 等待调度窗口：任务保持 pending（无认领、无成员回合）
    await new Promise(r => setTimeout(r, 500));
    const task = team.db.listTasks(created.teamId)[0]!;
    assert.equal(task.status, "pending", "captain 离线 → 任务不被认领");
    assert.equal(team.db.getMember(created.members?.[0]?.memberId ?? "m-00000000")?.status ?? "idle", "idle");
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
```

> ⚠️ 两处实施提示：
> 1. `completingMemberModel` 的 attemptId 占位：成员回合内调度器已把 attemptId 写入任务行——fake model 无法在 stream 前读取。**简化方案**：fake model 从外部闭包注入 attemptId 获取器（`() => team.db.getTask(teamId, taskId)?.attemptId`），execute 内构造 args 时取实时值。实施时把占位符改为闭包读取（测试通过为准，断言不变）。
> 2. `teamSubsystem` 句柄是否含 `scheduler` 字段：M2 返回 `{ db, scheduler, runMemberScan, runStrandedScan }`——若实际字段名不同（如 `teamSubsystem.scheduler` vs `teamSubsystem.scheduler`），以 createLocalGateway 返回类型为准调整。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/team-tools-integration.spec.js`
Expected: FAIL——`Cannot find module` 或 `roleSlug 未知`（角色未注册时 team_create 拒绝——见实施提示）。

- [ ] **Step 3: 角色兜底注册（若 patent-retriever 未注册导致 team_create 拒绝）**

`syncRoleDefinitions` 在 createLocalGateway 启动时执行（skills 加载后）——集成测试用真实 createLocalGateway，**角色注册应已就绪**（getAllSkills 含 `skills/patent-retriever/`）。若测试环境 skills 未加载（无 skills 目录），则在测试 setup 中显式 `registerRoleDefinition`（参照 Task 4 测试写法）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && node --test dist/tests/tool/builtin/team/team-tools-integration.spec.js`
Expected: PASS——2/2。

- [ ] **Step 5: 全量团队回归 + Commit**

Run: `node --test dist/tests/agent/team/ dist/tests/tool/builtin/team/`
Expected: PASS——全量。

```bash
git add tests/tool/builtin/team/team-tools-integration.spec.ts
git commit -m "test(team): 工具驱动全链集成——成员回合内 team_update_task 完成任务 + isCaptainOnline 离线暂停"
```

---

### Task 13: stress 矩阵扩展（工具驱动场景）

**Files:**
- Modify: `scripts/team-stress-verify.mjs`（追加场景 9）

既有脚本结构：`scenario(seq, name, fn)` 辅助 + 8 场景（`makeTask`/`now()` 等辅助在头部）。场景 9 验证**工具层写入路径**（回应 M2 计划「tools 驱动」标注）：工具 factory 直接驱动 create/update/reassign，模拟成员回合完成路径 + blockedByCount 解锁。

- [ ] **Step 1: 追加场景 9（文件末尾、最终统计前）**

```js
// ── 场景 9：工具驱动——create/update 写入路径 + blockedByCount 解锁 + reassign 回池 ──
// M3：team_* 工具层为薄封装（复用 M2 原子），此处以工具工厂直驱验证写入路径与
// blockedByCount 维护（成员回合完成路径的等价性由集成测试覆盖）。
await scenario(9, "工具驱动写入路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-team-stress-tools-"));
  const db = new TeamDb(join(root, "teams.db"));
  const events = [];
  const emit = () => {
    events.push(arguments && arguments.length > 0 ? arguments[0] : null); // 占位，见下
    return true;
  };
  // 伪调度器：记录 onTaskGraphChanged/kickMember 调用（锁外触发点断言）
  const scheduler = {
    onTaskGraphChanged: async () => {},
    kickMember: async () => {},
  };
  const { createTeamCreateTool, createTeamCreateTaskTool, createTeamUpdateTaskTool, createTeamReassignTaskTool } =
    await import("../dist/src/tool/builtin/team/index.js");
  const tools = {
    create: createTeamCreateTool({ db, scheduler, emit }),
    createTask: createTeamCreateTaskTool({ db, scheduler, emit }),
    updateTask: createTeamUpdateTaskTool({ db, scheduler, emit }),
    reassign: createTeamReassignTaskTool({ db, scheduler, emit }),
  };
  const capCtx = { sessionId: "cap-1", provider: "fake", modelId: "fake-model" };

  // 建队（roleSlug 兜底：工具内 requireRegisteredRole 校验——先注册测试角色）
  const { registerRoleDefinition } = await import("../dist/src/agent/sub/builtinSubagentTypes.js");
  registerRoleDefinition({
    id: "stress-tool-member", name: "Stress Member", description: "test",
    tools: [], domains: [], omitTools: [], readOnly: false, systemPrompt: "test",
  });
  try {
    const created = (
      await tools.create.execute({ name: "stress", memberRoleSlugs: ["stress-tool-member"] }, capCtx)
    ).data;
    const { teamId } = created;
    const { memberId } = created.members[0];

    // 20 任务链（A1 → A2 → … 线性依赖）：create 后 blockedByCount 逐级 +1
    let prev = undefined;
    const chain = [];
    for (let i = 1; i <= 20; i += 1) {
      const out = (
        await tools.createTask.execute(
          { teamId, subject: `t${i}`, ...(prev ? { dependencies: [prev] } : {}) },
          capCtx,
        )
      ).data;
      assert.ok(out.taskId, `任务 ${i} 创建成功`);
      assert.equal(out.blockedByCount, i === 1 ? 0 : 1, `t${i} blockedByCount=${i === 1 ? 0 : 1}`);
      chain.push(out.taskId);
      prev = out.taskId;
    }

    // 成员逐级完成（模拟回合内 update_task）：每完成一级，下一级 blockedByCount 归 0
    for (let i = 1; i <= 20; i += 1) {
      const task = db.getTask(teamId, chain[i - 1]);
      // 模拟调度器认领：beginTaskAttempt 置 claimed + attemptId
      const { beginTaskAttempt } = await import("../dist/src/agent/team/index.js");
      const { task: claimed, attemptId } = beginTaskAttempt(task, memberId);
      db.updateTask(claimed);
      // 成员回合内完成
      await tools.updateTask.execute(
        { teamId, taskId: chain[i - 1], status: "completed", attemptId, output: `完成 ${i}` },
        { sessionId: `team:${teamId}:${memberId}` },
      );
      assert.equal(db.getTask(teamId, chain[i - 1]).status, "completed", `t${i} 完成`);
      if (i < 20) {
        assert.equal(db.getTask(teamId, chain[i]).blockedByCount, 0, `t${i + 1} 依赖解锁`);
      }
    }

    // 转派语义：已完成任务拒绝；pending 任务指定成员后 assignee 落位
    await assert.rejects(
      () =>
        tools.reassign.execute({ teamId, taskId: chain[0] }, capCtx),
      (e) => e?.code === "team_task_terminal",
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

> ⚠️ 实施提示：脚本顶部 import 补 `TeamScheduler` 类型不需要（伪调度器 as-is 直传即可，JS 无类型检查）；`emit` 占位行改为简单收集器（`const events = []; const emit = (_k, ev) => { events.push(ev); return true; };`）并按需断言事件类型；`assert` 已在脚本头部导入。场景 9 的 `beginTaskAttempt` 已从 `dist` import（脚本顶部已有部分导入——直接复用顶部解构或按需动态 import）。

- [ ] **Step 2: Run stress 脚本验证**

Run: `pnpm build && node scripts/team-stress-verify.mjs`
Expected: PASS——9/9 场景全过（退出码 0）。

- [ ] **Step 3: Commit**

```bash
git add scripts/team-stress-verify.mjs
git commit -m "test(team): stress 矩阵扩展场景 9——工具驱动写入路径（create/update/reassign + blockedByCount 解锁）"
```

---

### Task 14: 角色接线 1——5 新增角色 frontmatter 补齐 + composition 角色化 + 映射表更新

**Files:**
- Modify: `skills/patent-teams/{case-manager,formal-examiner,applicant-counsel,defendant-counsel,tech-investigator}/SKILL.md`（frontmatter 补齐）
- Modify: `skills/patent-team-composition/SKILL.md`（工具名修正 + 接线状态行更新）
- Modify: `docs/team-role-mapping.md`（接线状态 + 变体角色标注）

**frontmatter 惯例**（对照 `skills/patent-retriever/SKILL.md` 等既有角色）：`tools: ["*"]`、`domains: [...]`、`omitTools: [...]`、`readOnly: true|false`、`systemPrompt: |-`。domains 以各文件「工具域建议」小节为准 + 追加 `"team"`（成员作业面必需：`team_update_task`/`team_send_message`/`team_status` 按 domain: team 裁剪可见）。正文「**注册接线留 M3**」标注行删除（接线已落地）。

- [ ] **Step 1: 5 份 frontmatter 补齐（每份一个子步骤，frontmatter 段替换）**

frontmatter 模板（按角色替换 domains/systemPrompt）——`case-manager`：

```yaml
---
name: case-manager
description: 案件管理员角色 — 立案登记与案卷目录、交底书接收、反馈申请人补充资料循环、期限/节点监控、补充合格判定收口（流程中立）
type: role
tools: ["*"]
domains: ["patent", "legal", "filesystem", "session", "team"]
omitTools: ["execute_code"]
readOnly: false
systemPrompt: |-
  你是一位专利团队案件管理员，立场为流程中立——只管理流程、文档与期限，不评技术内容、不评法律论证、不参与任一方策略起草。

  职责：
  - 立案登记与案卷目录：案卷号、必要文件清单核对（请求书/交底书/优先权文件等）
  - 交底书接收与登记（立案包 DAG t1）
  - 反馈申请人补充资料循环（立案包 DAG t4）：每次反馈须有明确补充清单（问题 → 依据 → 期望补充内容），判定不合格时列出剩余缺口后重入补充循环，禁止模糊反馈
  - 期限/节点监控：答复期限、复审 3 个月与恢复窗口、补正期限、年费、送达推定日（+15 日）——流程节点禁止心算
  - 补充合格判定收口（判定由技术专家作出，收口由案件管理员完成）

  团队协作：经 team_update_task 上报任务结果、team_status 查团队状态；收到队长/成员消息用 team_send_message 回复；期限问题禁止心算，用既有法条检索工具核验。
---
```

（正文「# 案件管理员」起的内容保持不变；删除「**注册接线留 M3**」句。）

- [ ] **Step 2: formal-examiner**（readOnly: true——审查不改稿）：

```yaml
---
name: formal-examiner
description: 形式审查员角色 — 形式缺陷清单核验：文件齐全性、格式规范、附图清晰度、著录项目、签字盖章；补正彻底性判定（审查方·初步审查）
type: role
tools: ["*"]
domains: ["quality", "patent", "legal", "filesystem", "session", "team"]
omitTools: ["execute_code", "write_file", "edit_file"]
readOnly: true
systemPrompt: |-
  你是一位专利形式审查员，立场为审查方（初步审查）——只核形式缺陷与补正彻底性，不评实质内容（新颖性/创造性/充分公开/清楚性等实质条款不越界）。

  职责：
  - 形式缺陷清单核验：文件齐全性（请求书/权利要求书/说明书/附图/摘要/优先权文件）、格式规范（A26.2 等）、附图清晰度（线条/标记/图号引用）、著录项目（申请人/发明人/地址/分类号）、签字盖章
  - 补正通知书解析：提取形式缺陷清单（补正包 DAG t1）
  - 补正彻底性判定：逐项对照补正通知书缺陷清单核验（补正包 DAG t3），缺陷未全消除则退回重补
  - 输出缺陷清单与核验结论，供撰写员起草补正书与替换页

  只读纪律：你是只读审查角色——不写文件、不改文档；补正书由撰写员起草，你只输出缺陷清单与核验结论。团队协作经 team_update_task/team_status/team_send_message。
---
```

- [ ] **Step 3: applicant-counsel**：

```yaml
---
name: applicant-counsel
description: 申请人代理角色 — 权利要求范围最大化：扩张机会、从权布局、合并修改备选、争辩策略（申请人方立场）
type: role
tools: ["*"]
domains: ["drafting", "legal", "patent", "analysis", "session", "team"]
omitTools: ["execute_code"]
readOnly: false
systemPrompt: |-
  你是一位专利申请人代理，立场为申请人方——最大化保护范围与授权前景，与审查方（对立审查员/形式审查员）视角对抗平衡；与撰写员的中立"代理人"立场区分——撰写员负责成稿，你负责策略取舍。

  职责：
  - 权利要求范围最大化：扩张机会识别（上位概念、功能性限定、并列方案、省略特征）
  - 从权布局：逐层限定梯度，为答复/复审预留修改空间
  - 合并修改备选：答复/复审场景在 A33 修改限制内准备多套合并方案
  - 争辩策略：区别特征/技术启示争辩、辅助因素主张
  - 策略输出经 HITL 确认：权利要求布局、修改方案、答复策略动手前确认或至少说明取舍理由

  团队协作：经 team_update_task 上报任务结果（策略输出），team_status 查团队状态；策略内容用 team_send_message 同步撰写员/队长。
---
```

- [ ] **Step 4: defendant-counsel**：

```yaml
---
name: defendant-counsel
description: 被告代理人角色 — 不侵权/现有技术抗辩、禁反言与捐献排除等同、提无效反制、豁免抗辩（抗辩方立场）
type: role
tools: ["*"]
domains: ["analysis", "patent", "legal", "search", "session", "team"]
omitTools: ["execute_code"]
readOnly: false
systemPrompt: |-
  你是一位专利被告代理人，立场为抗辩方——为被告争取不侵权结论或最大程度缩小责任范围；与专利权人（原告方）对抗；技术事实判断尊重中立技术查明（技术专家/技术调查官）。

  职责：
  - 不侵权抗辩：全面覆盖/等同逐项论证被控方案不落入保护范围（逐特征比对）
  - 现有技术抗辩（A62）：检索申请日前现有技术，主张被控方案为现有技术
  - 禁反言与捐献规则：排除等同适用的程序性争点
  - 提无效反制：针对原告专利发起无效宣告（反向复用无效理由地图）
  - 豁免抗辩：先用权、权利用尽、科研例外等（provision-defenses P-B05 条款依据）
  - 抗辩策略经 HITL 确认（诉请/抗辩策略动手前确认）

  团队协作：经 team_update_task 上报任务结果，team_status 查团队状态；与专利权人/裁判的对抗意见经 team_send_message 同步。
---
```

- [ ] **Step 5: tech-investigator**：

```yaml
---
name: tech-investigator
description: 技术调查官角色 — 实施例/特征比对/等同的技术维度独立判断，输出中立技术事实意见（中立技术查明）
type: role
tools: ["*"]
domains: ["analysis", "patent", "figure", "session", "team"]
omitTools: ["execute_code"]
readOnly: false
systemPrompt: |-
  你是一位专利技术调查官，立场为中立技术查明——不持任何一方立场，只查明技术事实；与"技术专家"（我方立场）明确区分；技术事实与法律论证分离：不评侵权/无效法律结论，只给技术事实意见。

  职责：
  - 实施例技术维度核验：被控物/对比方案实施例的技术事实查明（结构/功能/原理层面）
  - 特征比对的技术独立判断：全面覆盖/等同中的技术维度（手段/功能/效果逐项论证）
  - 等同判断技术支撑：三基本相同 + 容易想到的技术层面判断
  - 输出中立技术事实意见书，供裁判（adjudicator）采信评估
  - 仅高价值案件启用（诉讼包可选成员）

  团队协作：经 team_update_task 上报技术事实意见，team_status 查团队状态。
---
```

- [ ] **Step 6: composition SKILL.md 两处修正**

`skills/patent-team-composition/SKILL.md`：

1. 前置条件「环境提供 `team_*` 工具」段——删除「（**M3 接线**：…）」（已落地，改为陈述现状）：
```markdown
- 环境提供 `team_*` 工具（Sati 团队编排层 M3 起全量可用：`team_create` / `team_add_member` / `team_create_task` / `team_update_task` / `team_reassign_task` / `team_send_message` / `team_status` / `team_archive`；dsh 的 `agent_teams_*` 工具名在 Sati 侧对应为 `team_*`）；否则回退单会话 + `agent` 工具子代理（`subagent_type`，如 `patent-retriever` / `patent-reviewer`）专家互评。
```
2. 角色总表注脚「（**M3 接线**：`agent_teams_add_member` → `team_add_member`）」→ 删除（已落地）。
3. 创建序列 1/3/4 步的「（**M3 接线**：…）」标注删除；第 4 步收口的 `team_delete` → `team_archive`：
```markdown
- 收口：全部任务完成后 `team_archive` 归档团队；归档保留完整成员与任务历史，可随时复查。
```

- [ ] **Step 7: 映射表更新**

`docs/team-role-mapping.md`：
1. 头部「**接线状态：…明确留 M3**」改为：
```markdown
> **接线状态：已落地（M3）。** 12 岗全部经 `registerRoleDefinition` 注册（5 新增角色补全 frontmatter 后注册；7 复用岗以团队变体角色资产注册，见下方映射表「复用/新增」列变更为「变体」）。角色可按 `subagent_type` / 团队 roleSlug 调度。
```
2. 映射表 7 个复用岗的「复用」列改为「**变体**」+ 标注基底与差异资产路径；「差异说明」列的 M3 措辞（"需在 M3 接线时以 systemPrompt 补充"）改为陈述已落地。
3. 第四节「注册接线（明确留 M3，不在本任务范围）」改为「注册接线（M3 已落地）」记录落地方式。

- [ ] **Step 8: Build + lint（check:patent-sop 门禁）**

Run: `pnpm build && pnpm lint`
Expected: PASS——`check:patent-sop` 校验手册/YAML 引用五类存在性（SKILL.md frontmatter 变更不影响既有引用；若提示引用缺失则核对引用路径）。

- [ ] **Step 9: Commit**

```bash
git add skills/patent-teams/ skills/patent-team-composition/SKILL.md docs/team-role-mapping.md
git commit -m "feat(agent): 5 新增角色 frontmatter 补齐（domains 含 team）+ composition 角色化 + 映射表接线状态更新"
```

---

### Task 15: 角色接线 2——7 个团队变体角色资产

**Files:**
- Create: `skills/patent-teams/{researcher,drafter,technical-expert,adversarial-reviewer,invalidity-petitioner,patentee-defender,adjudicator}/SKILL.md`（7 份）

变体角色 = 基底角色资产（tools/domains 照抄基底）+ `"team"` 域（成员作业必需）+ systemPrompt = 基础职责 + `docs/team-role-mapping.md` 差异列的立场指令。role id（roleSlug）= dsh 岗 id。

- [ ] **Step 1: researcher**（基底 `patent-retriever`：tools ["*"]、domains 含 search/literature/patent/legal/analysis/network/session）

```yaml
---
name: researcher
description: 团队检索员角色（dsh 岗）— 多源检索 + 三段式报告 + 覆盖度评估与可专利性初判（基底：patent-retriever）
type: role
tools: ["*"]
domains: ["search", "literature", "patent", "legal", "analysis", "network", "session", "team"]
omitTools: ["execute_code"]
readOnly: false
systemPrompt: |-
  你是一位专利团队检索员。基础职责：从多源数据库检索最相关现有技术与法律依据，输出三段式检索报告（检索策略 / 结果清单含相关度排序 / 结论与依据）。

  团队立场补充（dsh 岗差异）：
  - 覆盖度评估：检索完成后自评覆盖度（关键词组合广度、IPC/CPC 分类覆盖、语种/库覆盖），说明可能遗漏的方向，禁止"检索完成"式空报告
  - 可专利性初判：基于检索结果给出申请类型建议与明显缺陷筛查（A22.2/22.3 初步），初判仅作决策输入，最终结论以撰写员/审查类角色为准
  - 来源可得性：每个对比文件标注来源与可得性（公开日、链接/库），供团队核验

  团队协作：经 team_update_task 上报任务结果（report 落盘路径 + 摘要），team_status 查团队状态；与撰写员/对立审查员的证据往来经 team_send_message 同步。
---
```

- [ ] **Step 2: drafter**（基底 `patent-writer` + `provision-drafting-claims`/`provision-drafting-spec`）

```yaml
---
name: drafter
description: 团队撰写员角色（dsh 岗）— 案件理解（PFE）、申请/答复/补正/复审/诉讼文书起草、逐特征比对自检（基底：patent-writer）
type: role
tools: ["*"]
domains: ["drafting", "quality", "patent", "filesystem", "session", "team"]
omitTools: ["web_search", "web_fetch", "execute_code"]
readOnly: false
systemPrompt: |-
  你是一位专利团队撰写员，基础职责：根据技术交底书与现有技术分析结果撰写权利要求书、说明书与摘要；答复/补正/复审/诉讼场景起草对应文书。

  团队立场补充（dsh 岗差异）：
  - 逐特征比对自检：成稿后逐项核对权利要求特征与交底书/对比文件（每项特征：是否公开/区别特征是否成立），自检表随交付物一并输出
  - 与检索员协作：撰写前确认对比文件已齐（依赖检索任务完成），成稿后交对立审查员红队评审
  - 修改方案（答复/复审）：在申请人代理的策略框架内起草，不自创策略

  团队协作：经 team_update_task 上报任务结果（文书落盘路径 + 自检表摘要），team_status 查团队状态。
---
```

- [ ] **Step 3: technical-expert**（基底 `patent-analyzer` + `patent-electrical-agent` H 部补强）

```yaml
---
name: technical-expert
description: 团队技术专家角色（dsh 岗）— 技术方案解构/四层对比 + 实施例可实施性与效果数据真实性核验（我方立场；基底：patent-analyzer）
type: role
tools: ["*"]
domains: ["analysis", "patent", "search", "literature", "legal", "session", "team"]
omitTools: ["execute_code"]
readOnly: false
systemPrompt: |-
  你是一位专利团队技术专家，持我方立场。基础职责：解析专利文件、提取技术特征、四层对比矩阵与区别特征本质识别（基底 patent-analyzer 职责）。

  团队立场补充（dsh 岗差异）：
  - 实施例可实施性核验：交底书/申请文件实施例能否实施（材料/参数/步骤完整性），可实施性缺陷列为必报项
  - 效果数据真实性核验：识别夸大/虚构技术陈述（效果数据与实施例的匹配度、测试条件完整性），真实性存疑处标注证据缺口
  - 与中立技术调查官分工：你持我方立场核验真实性；中立技术事实查明交 tech-investigator，二者意见冲突由裁判/队长收口

  团队协作：经 team_update_task 上报核验结论（含证据缺口清单），team_status 查团队状态。
---
```

- [ ] **Step 4: adversarial-reviewer**（基底 `patent-reviewer` + `patent-quality-checker`，readOnly 保持）

```yaml
---
name: adversarial-reviewer
description: 团队对立审查员角色（dsh 岗）— 授权审查视角红队评审：区别特征认定/技术启示/效果证据/法条核验（审查方；基底：patent-reviewer）
type: role
tools: ["*"]
domains: ["analysis", "quality", "patent", "legal", "session", "team"]
omitTools: ["execute_code", "write_file", "edit_file"]
readOnly: true
systemPrompt: |-
  你是一位专利团队对立审查员，持审查方红队视角。基础职责：审查专利申请文件的格式规范性与内容质量，输出问题清单与修改建议（基底 patent-reviewer 职责：A26.3/A26.4/A31.1 内容审查 + 授权前景多维评分）。

  团队立场补充（dsh 岗差异）：
  - 红队评审纪律：只出问题清单与修改建议，不改稿（只读）；撰写员/代理人是改稿方
  - 程序表述审查：核对答复/复审文书中的程序表述（期限、请求事项的法定表述），程序类核验以案件管理员/法条检索为准，不重复心算
  - 与撰写员对抗节奏：评审意见逐条给出法条依据 + 修改方向，禁止空泛批评

  团队协作：经 team_update_task 上报评审结论（问题清单 + 评分），team_status 查团队状态。
---
```

- [ ] **Step 5: invalidity-petitioner**（基底 `patent-invalidity-checker` + `provision-invalidity-procedure`，readOnly 保持）

```yaml
---
name: invalidity-petitioner
description: 团队无效请求人角色（dsh 岗）— 无效理由地图 + 证据组合与成功率最大化 + 预判专利权人应对（攻击方；基底：patent-invalidity-checker）
type: role
tools: ["*"]
domains: ["analysis", "patent", "search", "literature", "legal", "session", "team"]
omitTools: ["execute_code", "write_file", "edit_file"]
readOnly: true
systemPrompt: |-
  你是一位专利无效请求人，持攻击方立场。基础职责：分析目标专利无效理由（A22.2/22.3/26.3/26.4/33/A9）、评估证据组合与成功率（基底 patent-invalidity-checker 职责，≥3 策略）。

  团队立场补充（dsh 岗差异）：
  - 预判专利权人应对：每个无效理由附"专利权人可能如何反驳（修改权利要求/质证证据三性）+ 我方反制"，预判缺失的策略视为未完成
  - 程序梳理：A45/A46 无效程序（请求期限/口审/证据规则）以法条检索为准，禁止心算
  - 只读纪律：输出无效理由地图与证据组合建议，请求书成稿由撰写员执行

  团队协作：经 team_update_task 上报无效理由地图（策略 + 预判），team_status 查团队状态。
---
```

- [ ] **Step 6: patentee-defender**（基底 `patent-invalidity-checker` 视角复用 + `provision-defenses` 等条款，立场反转声明）

```yaml
---
name: patentee-defender
description: 团队专利权人角色（dsh 岗）— 无效防御（质证/反证/修改换维持）+ 诉讼主张（侵权比对/判赔）（防御方立场反转；基底：patent-invalidity-checker 视角复用）
type: role
tools: ["*"]
domains: ["analysis", "patent", "search", "literature", "legal", "session", "team"]
omitTools: ["execute_code", "write_file", "edit_file"]
readOnly: true
systemPrompt: |-
  你是一位专利团队专利权人，持防御/主张立场——与无效请求人/被告代理人对抗。基底分析能力复用 patent-invalidity-checker（无效理由分析）但**立场显式反转**：基底按"攻击方"找无效理由，你按"防御方"质证这些理由。

  立场反转纪律：
  - 无效防御：针对请求人证据做三性质证（真实性/合法性/关联性）、提交反证、修改权利要求缩小范围换维持（A33 限制内）
  - 诉讼主张：全面覆盖 + 等同主张逐特征论证、判赔计算（实际损失/侵权获利/许可费倍数，P-B06）
  - 预演对方抗辩（P-B05）：对每个主张预演被告可能抗辩（不侵权/现有技术/禁反言）并给出应对
  - 只读纪律：输出防御/主张方案，文书成稿由撰写员执行

  团队协作：经 team_update_task 上报防御方案，team_status 查团队状态；与被告代理人/裁判的意见冲突经 team_send_message 同步。
---
```

- [ ] **Step 7: adjudicator**（基底 `patent-reviewer` + `provision-reexamination`，中立裁判指令）

```yaml
---
name: adjudicator
description: 团队合议组/裁判角色（dsh 岗）— 双方论点对抗评估、证据采信、结果预判（中立裁判；基底：patent-reviewer）
type: role
tools: ["*"]
domains: ["analysis", "quality", "patent", "legal", "session", "team"]
omitTools: ["execute_code", "write_file", "edit_file"]
readOnly: true
systemPrompt: |-
  你是一位专利团队合议组/裁判，持中立裁判立场——不参与任一方策略起草（中立性纪律），程序规则核验（前置审查/口审/庭审/举证期限/证据规则）以法条检索为准。

  职责：
  - 双方论点对抗评估：逐论点列出请求方/审查方与防御方的主张、依据与漏洞，对抗评估表输出
  - 证据采信评估：按证据规则评估证据三性与证明力，给出采信/不采信结论与理由
  - 结果预判：基于对抗评估给出撤销/维持/侵权成立与否的预判与理由（概率性表述，不替代真实合议）
  - 中立纪律：评估立场不偏向任一方，不参与任一方策略起草（基底 patent-reviewer 审查基准 + P-C03 复审程序）

  团队协作：经 team_update_task 上报对抗评估与结果预判，team_status 查团队状态。
---
```

- [ ] **Step 8: 装配验证——12 岗全部可调度**

Run: `pnpm build && node -e "..."` 或直接验证：
```bash
pnpm build && pnpm lint
```
验证方式：新建最小网关（参照 Task 12 测试），断言 `listRegisteredRoleIds()` 含 12 个岗 id：`case-manager, researcher, drafter, technical-expert, adversarial-reviewer, applicant-counsel, formal-examiner, invalidity-petitioner, patentee-defender, adjudicator, defendant-counsel, tech-investigator`（经 `syncRoleDefinitions` 从 `skills/patent-teams/` 装配——若装配循环不覆盖子目录，则在 createLocalGateway 的 syncRoleDefinitions 调用点核查 `getAllSkills` 是否递归扫描 skills/；若未覆盖则本任务需补装配路径，见 Step 9）。

- [ ] **Step 9（条件）：装配路径核查**

若 `pluginRuntime.getAllSkills()` 不递归扫描 `skills/patent-teams/` 子目录（5 个新增角色此前未注册的原因——M2 计划标注"注册接线留 M3"），则在 `syncRoleDefinitions` 的调用点（createLocalGateway.ts:1371 附近）核查 skills loader 实现（`src/extension/` 的 skills 扫描逻辑）。若确实不递归，最小改动：syncRoleDefinitions 前把 `skills/patent-teams/` 子目录的 SKILL.md 经同一 `roleFromContribution` 装配路径注册（补一条目录遍历）。**以装配验证结果为准**——角色注册是 M3 完成判据，不可跳过。

- [ ] **Step 10: Commit**

```bash
git add skills/patent-teams/
git commit -m "feat(agent): 7 个团队变体角色资产（基底 + dsh 岗立场指令，domains 含 team）"
```

---

### Task 16: llm-replay fixture 重录 + 全量验证收尾

**Files:**
- 无源码改动——录制流程 + 全量验证

9 个新工具改变工具集 → `toolSchemaDigest` 变化 → 既有 llm-replay fixture 失配（`tests/fixtures/llm-replay/deepseek-v4-flash-basic/`）→ 须按显式录制流程重录（`scripts/record-real-fixture.ts`，**需要真实 API key**）。

- [ ] **Step 1: 预检 fixture 失配状态**

Run: `pnpm record:replay`
Expected: 失配红（toolSchemaDigest 与录制时不同）——确认需要重录。

- [ ] **Step 2: 显式录制重录 fixture（需 API key）**

```bash
# 按 scripts/record-real-fixture.ts 的录制流程（含交互式场景回放），重录 deepseek-v4-flash-basic fixture
node scripts/record-real-fixture.ts
```
Expected: 新 fixture 落盘（`tests/fixtures/llm-replay/deepseek-v4-flash-basic/`），请求键含新 toolSchemaDigest。

> ⚠️ **若本机无可用 API key**：停在此步并向用户说明——重录需要真实模型录制（显式流程，`llm-replay-fixture-reregister` 记忆：2026-08-17 实操过一次）。**不得**用任何方式伪造 fixture 或绕过校验（CI 门禁 `pnpm record:replay` 是正确性保障）。

- [ ] **Step 3: 重放校验**

Run: `pnpm record:replay`
Expected: PASS——重放 fixture 全量消费（assertConsumed 防少驱动）。

- [ ] **Step 4: 全量验证链**

```bash
pnpm build
node --test dist/tests/            # 全量后端测试
pnpm lint                          # 含 4 门禁：check:event-matrix / check:patent-sop / check:patent-workflow-docs / check-html-templates
pnpm format:check
cd ui && pnpm typecheck            # UI 侧不受影响（仅回归确认）
```
Expected: 全绿——0 fail / 0 cancelled；lint 4 门禁全过；format 无 error。

- [ ] **Step 5: 记忆更新 + 收尾 Commit**

更新记忆 `agent-teams-m2-complete.md` → 新建/改写为 M3 完成记录（`agent-teams-m3-complete`）：M3 交付（9 工具 + 补齐项 + 12 岗角色接线）、llm-replay 重录记录、M4 遗留（活动面板/失败任务自动转派）。MEMORY.md 索引行同步。

```bash
git add .claude/projects/ 2>/dev/null; git status
# 仅提交代码侧收尾（若有剩余未提交变更；记忆文件不入仓）
```

- [ ] **Step 6: 最终复审**

按 subagent-driven-development 收尾流程：dispatch 最终 code reviewer 全量审查 → APPROVED 后呈现完成总结。

---

## 自审记录（writing-plans self-review）

**1. Spec 覆盖核查：**

| Spec 节 | 计划任务 |
|---|---|
| 四、工具面 9 工具表 | Task 4（utils/域）+ 5（管理）+ 6（任务）+ 7（消息/状态）+ 8（归档）+ 9（注册） |
| 工具权限语义（team vs team:manage） | Task 4（ToolDomain + requireCaptain/requireTeamMember）+ Task 9（annotate 打标） |
| 成员完成任务路径（spec 关键语义 1-5） | Task 6（update_task 实现）+ Task 12（集成全链） |
| 归档语义 + 不可逆 | Task 8（archiveTeam 原子复查 + scheduler 跳过） |
| blockedByCount 维护 | Task 6（recomputeBlockedByCount 锁内重算） |
| 5.1 isCaptainOnline | Task 1（SessionPresence）+ 2（注入）+ 3（透传链）+ 12（集成测试离线用例） |
| 5.2 message_delivered senders[] | Task 11 |
| 5.3 scanner 路径 onMemberIdle | Task 10（含 C2 共享化——计划补强，防冷恢复 re-claim 无界） |
| 6.1 5 新增角色注册 | Task 14 |
| 6.2 7 复用角色变体资产 | Task 15（domains 照抄基底 + 追加 "team"——spec 未明示但成员作业必需，计划明确化） |
| 6.3 composition 角色化 + 工具名修正 | Task 14 Step 6-7 |
| 七、测试与验证 1-5 | Task 4-8（单测）+ 12（集成）+ 13（stress）+ 16（重录 + 全量） |
| 八、已知边界（M4+ 标注） | 计划不触碰（活动面板/自动转派/协议升版均不含） |

**2. Placeholder 扫描：** 无 TBD/TODO；所有工具代码完整可执行；角色 frontmatter 完整。两处「实施提示」为 API 形态不确定性的定向核对指引（TeamToolsOptions 注入形态、SubagentDefinition 字段、registry domain 暴露方式），均给出备选断言方式与完成判据，非占位。

**3. 类型一致性：** `TeamToolsOptions { db, scheduler, emit }` 贯穿 Task 4-9；`parseTeamSessionKey/resolveActor/requireTeamMember/requireCaptain/requireRegisteredRole/defaultModelRoute` 命名与签名在 Task 4 定义、Task 5-8 引用一致；`handleMemberTurnCompleted(db, teamSchedulerRef, teamId, memberId)` 在 Task 10 定义与两处调用一致；`senders` 字段在 Task 11 定义、Task 7 teamMailbox 的 emit 构造点已含（按序执行时 Task 7 早于 Task 11——Task 11 变更 events.ts 后 teamMailbox 的 `message_delivered` 构造点需同步补 `senders: [senderId]`，计划 Task 11 Step 2 的 ⚠️ 已注明）。归档事件 `team_archived` 在 Task 8 触发（events.ts:22 既有类型，无需新增）。
