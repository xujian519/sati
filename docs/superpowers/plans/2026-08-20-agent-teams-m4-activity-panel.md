# 团队编排层 M4：活动面板 + 调度补强 + 缺陷修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付团队编排层第四阶段——Web 全操作活动面板（建队/加人/转派/归档/审批全部入面板）+ 失败任务自动转派 + Web 下线判定接线 + modelRoute 消费 + 插件解析器缺陷修复 + 12 岗 domains 缺口补全。

**Architecture:** 后端先行（T1-T4 调度/路由/解析器/资产，纯函数+单测驱动），然后 Web 下线判定与 gateway 面板通道（T5-T6，协议 1.4 MINOR，feature-detect），经 ui/server REST 路由（T7）接 UI 面板（T8-T10，git-panel 模式参照），最后集成/stress/事件矩阵（T11）与全量验证（T12）。面板操作经 gateway `team_tool_call` 直调既有 team_* 工具（复用 requireTeamCaptain/requireTeamMember 权限链与 TeamEvent 事件广播），不做模型回路。

**Tech Stack:** TypeScript 5.9（strict, NodeNext）、Express 5、React 19 + Vite 8 + Tailwind 4 + shadcn/ui、Node test runner、yaml（js-yaml 同款 `yaml` 包，已在依赖）、协议 1.4（MINOR）。

---

## 背景与已知接线点（implementer 必读）

M3 已交付：9 个 team_* 工具（`src/tool/builtin/team/`）、事件驱动调度器（`src/agent/team/scheduler/scheduler.ts`）、SessionPresence（`src/gateway/server/sessionPresence.ts`，M4 面板预留注释已写）、wakeMember（`src/agent/team/member/member-waker.ts`）、团队角色资产（`skills/patent-teams/*/SKILL.md`，12 岗）。

本计划修复/接线的四个已知边界（来源：M3 最终复审 021ba185 与 M3 计划文档）：
- **I1 下线判定缺口**：浏览器经 ui/server relay 单条共享 ws 连接，浏览器关闭不触发 gateway onClose → Web 用户下线判定 fail-open。M4 决议：以浏览器连接级信号为准（T5）。
- **M1 modelRoute 未消费**：`defaultModelRoute`（`src/tool/builtin/team/teamUtils.ts:155`）已存快照，wakeMember 未消费（T2）。
- **M3 遗留：插件解析器缺陷**：`parseMarkdownFrontmatter`（`src/extension/plugins/loading/PluginCommandLoader.ts:94-115`）行级 `":"` 切分，多行 systemPrompt 截断为 `"|-"`、数组字段丢失（T3）。
- **M3 遗留：12 岗 domains 缺口**：5 岗缺 literature、drafter 缺 legal+literature；tech-investigator 缺 legal 为设计意图保留（T4）。

调度器关键语义（T1 依赖）：认领在锁内（`withTeamLock`）完成，锁外唤醒；`TERMINAL_TASK_STATUSES` 含 failed；`attemptsExhausted(task)` = `task.attempt >= task.maxAttempts`；`invalidateTaskAttempt(task)` 把任务回 pending（attempt 保留、attemptId 清、reassigning 可选）；`nextReadyTask` 跳过 `reassigning` 与依赖未满足任务。

llm-replay 约束：重放路径 `createAgentSession` + 无参 `createBuiltinRegistry()`，团队工具/角色不进重放请求——T1-T4 的改动**不破坏** llm-replay fixture（T2 若改 `src/gateway/protocol/types.ts` 的 GatewaySubmitTurnInput 需确认只加可选字段，不进请求键）。

验证基线：全量 3410 tests / 3407 pass / 3 skipped；`pnpm build → find dist/tests -name '*.spec.js' | node --test`（Node 22 目录发现不匹配 `.spec.js`，必须 glob）。

---

### Task 1: 失败任务自动转派（failed → pending 重入池，maxAttempts 上限防环）

**Files:**
- Create: `src/agent/team/taskpool/retry.ts`
- Modify: `src/agent/team/scheduler/scheduler.ts:144-147`（kickMember 锁内重置）
- Modify: `src/agent/team/protocol/events.ts`（TeamEvent 增 task_retried）
- Modify: `src/agent/team/index.ts`（barrel 导出 retry）
- Test: `tests/agent/team/taskpool/retry.spec.ts`（新建）
- Test: `tests/agent/team/scheduler/scheduler-retry.spec.ts`（新建，或并入既有 scheduler spec）

- [ ] **Step 1: 读既有协议确认事件形态**

Run: `sed -n '1,80p' src/agent/team/protocol/events.ts`
预期：TeamEvent 是判别联合（type 字段 + teamId 等公共字段）。task_retried 仿 task_claimed 形态加 `{ type: "task_retried", teamId, taskId, attempt, memberId? }`（attempt 为重置后的当前值；memberId 为失败时的 assignee——即上次尝试者，可 undefined）。

- [ ] **Step 2: 写失败测试**

Create: `tests/agent/team/taskpool/retry.spec.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { TeamTaskRow } from "../../../../src/agent/team/index.js";
import { retryFailedTask, retryableFailedTasks } from "../../../../src/agent/team/index.js";

function task(overrides: Partial<TeamTaskRow>): TeamTaskRow {
  return {
    id: "t1",
    teamId: "team-1",
    subject: "s",
    description: "",
    status: "failed",
    assigneeId: "m1",
    dependencies: [],
    attempt: 1,
    attemptId: "attempt-1",
    reassigning: false,
    blockedByCount: 0,
    maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("retryableFailedTasks：failed 且 attempt < maxAttempts 可重试；终态/耗尽/非 failed 不可", () => {
  const base = task({});
  assert.deepEqual(retryableFailedTasks([base]), ["t1"], "failed + attempt 1/3 可重试");
  assert.deepEqual(
    retryableFailedTasks([task({ status: "completed" })]),
    [],
    "completed 不可重试",
  );
  assert.deepEqual(retryableFailedTasks([task({ attempt: 3, maxAttempts: 3 })]), [], "attempt 达上限不可重试");
  assert.deepEqual(retryableFailedTasks([task({ status: "cancelled" })]), [], "cancelled 不可重试");
  assert.deepEqual(retryableFailedTasks([task({ status: "pending" })]), [], "pending 非 failed 不可重试");
});

test("retryFailedTask：failed → pending 重入池，attempt 保留（beginTaskAttempt 再 +1），清 attemptId/assignee/output/handoffId，reassigning 保持 false", () => {
  const out = retryFailedTask(task({ output: "半成品", handoffId: "h-1", reassigning: true }));
  assert.equal(out.status, "pending");
  assert.equal(out.attempt, 1, "attempt 保留（重试计次由 beginTaskAttempt +1）");
  assert.equal(out.attemptId, undefined, "清 attemptId（防 stale-attempt 校验误伤）");
  assert.equal(out.assigneeId, undefined, "回池待认领");
  assert.equal(out.output, undefined);
  assert.equal(out.handoffId, undefined);
  assert.equal(out.reassigning, false, "自动转派不置 reassigning（nextReadyTask 会跳过 reassigning，置位将无人认领）");
});

test("retryFailedTask：不可重试（耗尽/非 failed）返回原任务（幂等安全）", () => {
  const exhausted = task({ attempt: 3, maxAttempts: 3 });
  assert.equal(retryFailedTask(exhausted), exhausted, "耗尽保持 failed 终态");
  const completed = task({ status: "completed" });
  assert.equal(retryFailedTask(completed), completed);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm build && find dist/tests/agent/team -name '*.spec.js' | xargs node --test`（新 spec 尚未编译进 dist，build 后仍会报测试文件不存在或 import 失败——先确认 `retryFailedTask` 未导出）

- [ ] **Step 4: 写实现**

Create: `src/agent/team/taskpool/retry.ts`

```ts
/**
 * 失败任务自动转派（M4）：failed 且未耗尽 maxAttempts 的任务重置回 pending 重入
 * 可认领池（attempt 保留，计次由 beginTaskAttempt 再 +1），由调度器下一次
 * 锁内认领自然派发——成员失败 → onTaskGraphChanged → kickTeam → 锁内重置 →
 * nextReadyTask 认领给（另一）idle 成员。
 * 防环：attempt >= maxAttempts 即终态（attemptsExhausted），不重置。
 * 与 invalidateTaskAttempt 的关系：语义同为「回 pending」，但自动转派必须
 * reassigning 保持 false（nextReadyTask 跳过 reassigning 任务，置位将无人认领）、
 * 且不生成 handoffId（无人工交接语义）；故独立实现，不复用。
 */
import type { TeamTaskRow } from "../storage/team-db.js";
import { attemptsExhausted } from "./attempt.js";

/** failed 且未耗尽可自动转派的任务 id 列表（纯函数）。 */
export function retryableFailedTasks(tasks: readonly TeamTaskRow[]): string[] {
  return tasks.filter(t => t.status === "failed" && !attemptsExhausted(t)).map(t => t.id);
}

/** 单个失败任务重置为 pending 重入池；不可重试（耗尽/非 failed）原样返回（幂等）。 */
export function retryFailedTask(task: TeamTaskRow): TeamTaskRow {
  if (task.status !== "failed" || attemptsExhausted(task)) return task;
  return {
    ...task,
    status: "pending",
    assigneeId: undefined,
    attemptId: undefined,
    handoffId: undefined,
    reassigning: false,
    output: undefined,
    updatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 5: 协议事件 task_retried**

Modify: `src/agent/team/protocol/events.ts`——在 task 相关事件分支加（读文件确认既有成员后追加，仿 task_claimed 形态）：

```ts
    /** 失败任务自动转派（M4）：调度器把 failed 未耗尽任务重置回池待重派。 */
    | { type: "task_retried"; teamId: string; taskId: string; attempt: number; memberId?: string }
```

- [ ] **Step 6: scheduler 锁内接线 + 事件广播**

Modify: `src/agent/team/scheduler/scheduler.ts:144-147`（kickMember 锁内，`const tasks = this.db.listTasks(teamId);` 之后、`ownedOpenTask` 之前插入）：

```ts
      // M4：失败任务自动转派——锁内把 failed 未耗尽任务重置回 pending（幂等，
      // 重置后不再 failed），使 nextReadyTask 能重新认领；attempt 上限防无限循环。
      const retried = tasks.filter(t => retryableFailedTasks([t]).length === 1);
      for (const stale of retried) {
        const fresh = this.db.getTask(teamId, stale.id);
        if (fresh === undefined || fresh.status !== "failed") continue; // 锁内重读防并发改写
        if (attemptsExhausted(fresh)) continue;
        this.db.updateTask(retryFailedTask(fresh));
        this.emit(team.captainSessionKey, {
          type: "task_retried",
          teamId,
          taskId: fresh.id,
          attempt: fresh.attempt,
          ...(fresh.assigneeId !== undefined ? { memberId: fresh.assigneeId } : {}),
        });
      }
```

注意：`retryableFailedTasks([t]).length === 1` 写法绕开 filter 与 map 的重复——直接 `tasks.filter(t => t.status === "failed" && !attemptsExhausted(t))` 更直白，二选一（implementer 选直白版）。`team` 变量在 kickMember 顶部已取（锁外），锁内用 `team.captainSessionKey` 广播。

- [ ] **Step 7: barrel 导出**

Modify: `src/agent/team/index.ts`——仿 taskpool 既有导出加 `export { retryFailedTask, retryableFailedTasks } from "./taskpool/retry.js";`（确认 index.ts 现有 taskpool 导出行的位置与形态）。

- [ ] **Step 8: 跑测试**

Run: `pnpm build && find dist/tests -name '*.spec.js' | xargs node --test`——retry.spec 3 用例全绿；scheduler 既有测试不回归（影响面：kickMember 锁内新增遍历，无 failed 任务时零行为变化）。

- [ ] **Step 9: 提交**

```bash
git add src/agent/team/taskpool/retry.ts src/agent/team/scheduler/scheduler.ts src/agent/team/protocol/events.ts src/agent/team/index.ts tests/agent/team/taskpool/retry.spec.ts
git commit -m "feat(team): 失败任务自动转派（failed 未耗尽重置回池，maxAttempts 防环）"
```

---

### Task 2: modelRoute 消费（wakeMember 传快照模型路由 → gateway 会话配置覆盖）

**Files:**
- Modify: `src/gateway/protocol/types.ts:114-140`（GatewaySubmitTurnInput 加可选 modelRoute）
- Modify: `src/agent/team/member/member-waker.ts:30-44`（解析快照传入）
- Modify: `src/tool/builtin/team/teamStatus.ts:28-38`（parseModelRoute 抽共享）
- Modify: `src/tool/builtin/team/teamUtils.ts`（新增共享 parseModelRouteJson）
- Modify: `src/cli/createLocalGateway.ts`（submitTurn 实现消费 modelRoute → 会话模型覆盖）
- Test: `tests/agent/team/member/member-waker.spec.ts`（新建或扩展现有）

- [ ] **Step 1: 读 submitTurn 实现定位会话配置构造点**

Run: `grep -n "submitTurn\|prepareSessionRuntime\|createAgentConfig" src/cli/createLocalGateway.ts | head -20`
预期：submitTurn 是生成器方法，内部经 `createSession`/`prepareSessionRuntime` 构造 agent 配置。**定向核对指引**：找到「input 字段 → 会话 runtime/config」的传递路径（如 workspaceCwd/projectKey 怎么从 input 流到 createSession），modelRoute 仿同一路径加字段。

- [ ] **Step 2: 抽共享 parseModelRouteJson**

Modify: `src/tool/builtin/team/teamUtils.ts`——把 teamStatus.ts 的 parseModelRoute 提为导出函数（JSON 解析 + 非对象降级 `{}`，注释保留）：

```ts
/**
 * 成员 modelRouteJson 解析（M4 共享）：脏数据（非法 JSON / 非对象）降级为空对象
 * ——视图与 wakeMember 消费路径都不抛错；与 teamStatus 视图语义一致。
 */
export function parseModelRouteJson(json: string): { provider?: string; model?: string } {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { provider, model } = parsed as { provider?: unknown; model?: unknown };
      return {
        ...(typeof provider === "string" ? { provider } : {}),
        ...(typeof model === "string" ? { model } : {}),
      };
    }
  } catch {
    // 非法 JSON：走降级
  }
  return {};
}
```

Modify: `src/tool/builtin/team/teamStatus.ts`——删本地 parseModelRoute，改 import `parseModelRouteJson`（teamUtils 已 import 的 requireTeamMember 等旁追加），视图处 `modelRoute: parseModelRouteJson(m.modelRouteJson)`。

- [ ] **Step 3: 写失败测试**

Create/Modify: `tests/agent/team/member/member-waker.spec.ts`——现有 wakeMember 测试（若存在）仿照：断言 input 携带 modelRoute。若无现成测试，新建（用 stub gateway 捕获 submitTurn input）：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, createTeamMember, wakeMember } from "../../../../src/agent/team/index.js";
import type { GatewaySubmitTurnInput } from "../../../../src/gateway/protocol/types.js";

test("wakeMember：成员快照 modelRoute 传入 submitTurn input（M4 消费点）", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-waker-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "t", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, {
    teamId: "t1",
    memberId: "m1",
    roleSlug: "researcher",
    modelRoute: { provider: "fake-provider", model: "fake-model" },
  });
  let captured: GatewaySubmitTurnInput | undefined;
  const gateway = {
    async *submitTurn(input: GatewaySubmitTurnInput) {
      captured = input;
    },
  };
  await wakeMember(db, gateway as never, "m1", "followup");
  assert.equal(captured!.sessionKey, "team:t1:m1");
  assert.deepEqual(captured!.modelRoute, { provider: "fake-provider", model: "fake-model" });
  // 脏数据成员（modelRouteJson 非法）降级为空对象，不抛错
  db.insertMember({
    id: "m-bad", teamId: "t1", roleSlug: "researcher", modelRouteJson: "{broken",
    status: "idle", sessionKey: "team:t1:m-bad", createdAt: "2026-08-20T00:00:00.000Z",
  });
  captured = undefined;
  await wakeMember(db, gateway as never, "m-bad", "followup");
  assert.deepEqual(captured!.modelRoute, {}, "脏数据降级为空对象（不阻塞唤醒）");
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-waker.spec.js`
预期：FAIL——`GatewaySubmitTurnInput` 无 modelRoute 属性（tsc 报 2322 多余属性）或 wakeMember 未传。

- [ ] **Step 5: 改类型 + wakeMember**

Modify: `src/gateway/protocol/types.ts:114-140`——GatewaySubmitTurnInput 末尾加（注释说明 M4）：

```ts
  /** Team member model route override (M4): applied to the session config for this turn. */
  modelRoute?: { provider: string; model: string };
```

Modify: `src/agent/team/member/member-waker.ts`——import `parseModelRouteJson`（从 `../../../tool/builtin/team/teamUtils.js`？检查依赖方向：agent/team → tool/builtin/team 的依赖是否可接受——工具层依赖 agent/team（teamUtils import parseMemberSessionKey from agent/team），反向引入会循环。**决策：parseModelRouteJson 放 agent/team 侧**（放 `src/agent/team/member/model-route.ts` 或 member-waker 内联）。implementer 核对：把解析函数放 `src/agent/team/member/member-waker.ts` 同目录新文件 `modelRouteJson.ts`，teamStatus.ts 改从 agent/team barrel 导入（teamStatus 已 import agent/team 的 TeamTaskStatus——依赖方向正确）。

```ts
// member-waker.ts 内 input 构造处
const route = parseModelRouteJson(member.modelRouteJson);
const input: GatewaySubmitTurnInput = {
  sessionKey: member.sessionKey,
  channelKey: "cron",
  message: followupMessage,
  canPrompt: false,
  ...(route.provider !== undefined && route.model !== undefined ? { modelRoute: route } : {}),
  ...(options.syntheticMessages ? { syntheticMessages: options.syntheticMessages } : {}),
};
```

- [ ] **Step 6: gateway 消费 modelRoute（会话配置覆盖）**

Modify: `src/cli/createLocalGateway.ts` submitTurn 实现——在构造 agent 会话配置处（Step 1 定位的路径）消费：

```ts
// M4：成员快照模型路由消费——覆盖会话默认模型（provider/modelId 均存在才覆盖）
if (input.modelRoute) {
  config = { ...config, provider: input.modelRoute.provider, modelId: input.modelRoute.model };
}
```

（`config` 形态按 Step 1 定位的实际构造点适配——可能是 spread 到 prepareSessionRuntime/agentConfig 的入参对象；**定向核对指引**：确保覆盖发生在 session 创建/续算两条路径都生效——若 createSession 与 resumeSession 共用同一构造函数则天然覆盖两路。）

- [ ] **Step 7: 跑测试 + 回归**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-waker.spec.js && find dist/tests -name '*.spec.js' | xargs node --test`
预期：新用例 PASS；团队 suite 与 gateway 相关 suite 不回归（modelRoute 可选字段，既有调用不带它）。

- [ ] **Step 8: 提交**

```bash
git add src/gateway/protocol/types.ts src/agent/team/member/ src/tool/builtin/team/teamStatus.ts src/tool/builtin/team/teamUtils.ts src/cli/createLocalGateway.ts tests/agent/team/member/member-waker.spec.ts
git commit -m "feat(team): wakeMember 消费成员快照 modelRoute（submitTurn input.modelRoute 覆盖会话模型）"
```

---

### Task 3: 插件命令 frontmatter 解析缺陷修复（行级切分 → yaml 解析）

**Files:**
- Modify: `src/extension/plugins/loading/PluginCommandLoader.ts:94-123`（parseMarkdownFrontmatter + 删 parseScalar）
- Test: `tests/extension/plugins/loading/PluginCommandLoader.spec.ts`（新建或扩展现有）

- [ ] **Step 1: 写失败测试（复现缺陷）**

Create: `tests/extension/plugins/loading/PluginCommandLoader.spec.ts`（若已存在则追加用例）：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStandaloneSkill } from "../../../../src/extension/plugins/loading/index.js";

function writeSkill(frontmatter: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-plg-"));
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}---\nbody`);
  return dir;
}

test("多行 systemPrompt（|- 块）完整解析，不被截断为 '|-'", async () => {
  const skill = await loadStandaloneSkill({
    name: "demo",
    skillDir: writeSkill("name: demo\ndescription: d\nsystemPrompt: |-\n  第一行\n  第二行\n"),
  });
  assert.equal(skill.frontmatter.systemPrompt, "第一行\n第二行");
});

test("数组字段（domains/tools）完整解析", async () => {
  const skill = await loadStandaloneSkill({
    name: "demo",
    skillDir: writeSkill("name: demo\ndescription: d\ndomains:\n  - patent\n  - search\ntools:\n  - patent_search\n"),
  });
  assert.deepEqual(skill.frontmatter.domains, ["patent", "search"]);
  assert.deepEqual(skill.frontmatter.tools, ["patent_search"]);
});

test("标量类型与现有行为保持（bool/数字/引号字符串）", async () => {
  const skill = await loadStandaloneSkill({
    name: "demo",
    skillDir: writeSkill("name: demo\ndescription: d\nenabled: true\nmaxTurns: 3\nquote: \"a: b\"\n"),
  });
  assert.equal(skill.frontmatter.enabled, true);
  assert.equal(skill.frontmatter.maxTurns, 3);
  assert.equal(skill.frontmatter.quote, "a: b", "yaml 引号字符串含冒号不切分");
});
```

先确认 `src/extension/plugins/loading/index.ts` 是否导出 loadStandaloneSkill（不导出则从 `PluginCommandLoader.js` 直接 import；或测试仿既有测试的导入路径）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && find dist/tests/extension -name '*.spec.js' | xargs node --test`
预期：前两个用例 FAIL（systemPrompt 断言得 `"|-"`、domains 断言得 `{}` 或空对象），第三个 bool/数字可能 PASS（parseScalar 手工转换恰好一致）。

- [ ] **Step 3: 修实现（yaml 解析，对齐 teamRoleAssembly parseSkillFrontmatter 范式）**

Modify: `src/extension/plugins/loading/PluginCommandLoader.ts`——import 区加 `import { parse as parseYaml } from "yaml";`，替换 parseMarkdownFrontmatter 实现、删除 parseScalar：

```ts
/**
 * 解析 SKILL.md 头部 YAML frontmatter（M4 修复）：原行级 `":"` 切分会把多行
 * systemPrompt 截断为 `"|-"`、丢失数组字段（domains/tools）。改为 yaml 解析
 * （与 teamRoleAssembly.parseSkillFrontmatter / SkillManager 同范式）；闭合围栏
 * 契约保持 `---\n` 开头 + `\n---\n` 闭合。yaml 解析失败回退空对象（不抛错、
 * 不 warn——命令加载路径无源路径参数，保持原静默语义）。
 */
function parseMarkdownFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, content: raw };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, content: raw };
  }
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(raw.slice(4, end));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // 解析失败回退空对象（与原实现遇到不可解析行的静默行为一致）
  }
  return { frontmatter, content: raw.slice(end + 5) };
}
```

- [ ] **Step 4: 跑测试 + 插件相关回归**

Run: `pnpm build && find dist/tests/extension -name '*.spec.js' | xargs node --test`
预期：新 3 用例全 PASS；既有 extension 测试不回归（解析语义变化：yaml 会做类型推断——若既有断言依赖 parseScalar 的字符串保留行为（如 `description: "a: b"` 引号剥离），yaml 结果一致；无引号的含冒号值 yaml 会解析失败回退空对象——检查既有 fixture 是否有此类内容，若回归则把该 fixture 值加引号（合法 yaml），不改解析器）。

- [ ] **Step 5: 提交**

```bash
git add src/extension/plugins/loading/PluginCommandLoader.ts tests/extension/plugins/loading/PluginCommandLoader.spec.ts
git commit -m "fix(extension): 插件命令 frontmatter 改 yaml 解析（多行 systemPrompt/数组字段不再截断丢失）"
```

---

### Task 4: 12 岗 domains 缺口补全（5 岗补 literature、drafter 补 legal+literature）

**Files:**
- Modify: `skills/patent-teams/adjudicator/SKILL.md`（domains 补 "literature"）
- Modify: `skills/patent-teams/adversarial-reviewer/SKILL.md`（同上）
- Modify: `skills/patent-teams/applicant-counsel/SKILL.md`（同上）
- Modify: `skills/patent-teams/case-manager/SKILL.md`（同上）
- Modify: `skills/patent-teams/formal-examiner/SKILL.md`（同上）
- Modify: `skills/patent-teams/drafter/SKILL.md`（补 "legal" + "literature"）
- Test: 无新测试（check:patent-sop 门禁 + 角色注册测试回归）

- [ ] **Step 1: 核对缺口清单**

Run: `grep -l '^domains:' skills/patent-teams/*/SKILL.md | sort` 与 `grep -A6 '^domains:' skills/patent-teams/*/SKILL.md | grep -B1 'literature'`
预期：7 个角色资产（adjudicator/adversarial-reviewer/applicant-counsel/case-manager/formal-examiner/drafter 等）domains 无 "literature"；tech-investigator 缺 "legal" **保持不动**（设计意图：检索型角色不接法规域，M3 spec 逐字批准）。drafter 当前无 legal。

- [ ] **Step 2: 逐文件补 domains**

对 6 个资产（adjudicator/adversarial-reviewer/applicant-counsel/case-manager/formal-examiner 补 `"literature"`；drafter 补 `"legal"` + `"literature"`）：读该文件 domains 段，按现有 YAML 数组风格追加一项（保持字母序与缩进风格）：

```yaml
domains:
  - literature   # 追加（各文件按既有列表风格/顺序）
```

注意：先读原文件确认 domains 是列表风格（`- patent`）还是单行（`[patent, search]`），按原风格追加。

- [ ] **Step 3: 验证**

Run: `pnpm lint`（挂 check:patent-sop——手册/YAML 引用五类存在性；若门禁校验 SKILL.md 的 domain 引用则验证新 domain 合法）与 `pnpm build && find dist/tests/agent/team -name '*.spec.js' | xargs node --test`（角色注册测试回归——teamManagement 的 roleSlug 校验测试、builtinSubagentTypes 注册测试）。

- [ ] **Step 4: 提交**

```bash
git add skills/patent-teams/
git commit -m "feat(team): 12 岗 domains 缺口补全（5 岗补 literature、drafter 补 legal+literature）"
```

---

### Task 5: Web 下线判定接线（协议 1.4 panel_heartbeat + SessionPresence panel 维度 + ui/server 浏览器活跃信号）

**Files:**
- Modify: `src/gateway/protocol/version.ts`（1.4 MINOR：panel_heartbeat/team_panel_snapshot/team_tool_call）
- Modify: `src/gateway/server/sessionPresence.ts`（panelTouch + panelSeenAt）
- Modify: `src/gateway/protocol/types.ts`（Gateway 接口 + panelHeartbeat 方法签名）
- Modify: `src/gateway/server/GatewayWsConnection.ts:257` 附近（case "panel_heartbeat"）
- Modify: `src/cli/createLocalGateway.ts`（panelHeartbeat 实现：SessionPresence 接线）
- Modify: `ui/server/websocket/chat.js`（浏览器消息转发处记录会话活跃时间）
- Create: `ui/server/team-presence.js`（30s 心跳聚合调 gateway）
- Test: `tests/gateway/sessionPresence.spec.ts`（panel 维度用例）

- [ ] **Step 1: 写失败测试（SessionPresence panel 维度）**

Modify: `tests/gateway/sessionPresence.spec.ts`（既有 presence 测试存在；追加）：

```ts
test("panelTouch：面板心跳使直连关闭会话保持在线；心跳停超宽限窗判离线（M4 Web 下线判定）", () => {
  const p = new SessionPresence();
  const t0 = 1_000_000;
  p.touch("web-1", t0); // 浏览器经 relay 的直连帧（转发时 touch 到浏览器会话 key）
  p.close("web-1", t0 + 5_000);
  // 直连关闭 5s 后（宽限窗 60s 内）仍在线
  assert.equal(p.isActive("web-1", t0 + 6_000), true);
  // 面板心跳刷新：超过宽限窗后仍在线
  p.panelTouch("web-1", t0 + 100_000);
  assert.equal(p.isActive("web-1", t0 + 150_000), true, "心跳在宽限窗内保持在线");
  // 心跳停止：最后心跳 + 宽限窗后离线（known-offline 持久）
  assert.equal(p.isActive("web-1", t0 + 100_000 + SESSION_PRESENCE_GRACE_MS + 1), false);
  assert.equal(p.isActive("web-1", t0 + 999_999_999), false, "持久离线直到下次 touch/panelTouch 复位");
  // 从未见过的会话仍视为在线（unknown → true，容错优先不变）
  assert.equal(p.isActive("never-seen"), true);
  // 面板心跳复位
  p.panelTouch("web-1", t0 + 999_999_999);
  assert.equal(p.isActive("web-1", t0 + 999_999_999 + SESSION_PRESENCE_GRACE_MS - 1), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/gateway/sessionPresence.spec.js`
预期：FAIL——`panelTouch` 不存在（TypeError）。

- [ ] **Step 3: SessionPresence 扩展**

Modify: `src/gateway/server/sessionPresence.ts`：

```ts
type PresenceEntry = {
  /** 最近一次收到帧的时间戳（ms）；仅收到帧后存在（M4 面板展示最近活跃时间戳预留）。 */
  lastSeenAt?: number;
  /** 连接关闭时间戳（ms）；undefined = 当前有活跃连接。 */
  closedAt?: number;
  /** 面板心跳最后时间戳（ms）；undefined = 无面板信号（M4 Web 下线判定）。 */
  panelSeenAt?: number;
};

/** 面板心跳（M4）：浏览器经 ui/server relay 周期上报活跃会话；面板关闭 = 心跳停 → 超宽限窗离线。 */
panelTouch(sessionKey: string, now: number = Date.now()): void {
  const entry = this.entries.get(sessionKey);
  if (entry === undefined) {
    this.entries.set(sessionKey, { panelSeenAt: now });
    return;
  }
  entry.panelSeenAt = now;
}

/** 活跃判定：直连活跃 → true；直连关闭宽限窗内 → true；面板心跳宽限窗内 → true；unknown → true；全超窗 → false（持久）。 */
isActive(sessionKey: string, now: number = Date.now()): boolean {
  const entry = this.entries.get(sessionKey);
  if (entry === undefined) return true;
  if (entry.closedAt === undefined) return true;
  if (now - entry.closedAt < SESSION_PRESENCE_GRACE_MS) return true;
  // M4：面板心跳独立宽限窗——浏览器关闭不触发 gateway onClose，以心跳停为准
  return entry.panelSeenAt !== undefined && now - entry.panelSeenAt < SESSION_PRESENCE_GRACE_MS;
}
```

注意语义：`panelTouch` 只复位离线判定（known-offline → 在线），不清 `closedAt`（面板心跳不是直连）。`activeSessions` 保持直连语义不变（面板数据展示用 presence 单独合并，T6 处理）。

- [ ] **Step 4: 协议 1.4 + gateway 方法**

Modify: `src/gateway/protocol/version.ts` 变更表（仿既有条目格式）：

```ts
/** 1.4（M4）：团队活动面板——panel_heartbeat（浏览器活跃上报）/ team_panel_snapshot / team_tool_call（MINOR，feature-detect）。 */
```

Modify: `src/gateway/protocol/types.ts` Gateway 接口（`submitTurn` 等签名旁）：

```ts
  /** M4：面板心跳上报（ui/server relay 汇总活跃浏览器会话 key；gateway 侧 panelTouch 维护 Web 在线判定）。 */
  panelHeartbeat?(input: { sessionKeys: string[] }): Promise<{ touched: number }>;
```

Modify: `src/gateway/server/GatewayWsConnection.ts`（cron_stop 的 case 之后追加）：

```ts
      case "panel_heartbeat":
        if (this.options.gateway.panelHeartbeat) {
          return this.options.gateway.panelHeartbeat(frame.params as never);
        }
        return Promise.resolve(notConfigured({ touched: 0 }, "Panel heartbeat not available"));
```

- [ ] **Step 5: createLocalGateway 实现 panelHeartbeat**

Modify: `src/cli/createLocalGateway.ts`——gateway 对象方法定义区（仿 cronUpdate 所在处）加：

```ts
    panelHeartbeat: async (input: { sessionKeys: string[] }) => {
      for (const key of input.sessionKeys) {
        presence.panelTouch(key);
      }
      return { touched: input.sessionKeys.length };
    },
```

（`presence` 为 createLocalGateway 内已持有的 SessionPresence 实例——isCaptainOnline 已引用；确认变量名后适配。）

- [ ] **Step 6: ui/server 侧浏览器活跃信号 + 心跳上报**

Modify: `ui/server/websocket/chat.js`——浏览器消息转发处（读文件定位：wss 连接消息处理里转发到 gateway 的地方，约 62-110 行）维护活跃表：

```js
// M4：浏览器会话活跃表（Web 下线判定）——浏览器消息到达即刷新，浏览器关闭即停更，
// 由 team-presence 心跳上报 gateway（panelTouch），gateway 侧超宽限窗判离线。
const browserActiveAt = new Map(); // sessionKey -> lastSeenAt(ms)
```

在转发消息处（消息 payload 含 sessionKey 的位置）`browserActiveAt.set(sessionKey, Date.now())`。（**定向核对指引**：确认浏览器消息 payload 的 sessionKey 字段名——sati-bridge/chat.js 转发时已带；找不到就在 routes/gateway.js 的浏览器 → gateway 中转处记录，原则：浏览器消息进入点记录活跃。）

Create: `ui/server/team-presence.js`：

```js
/**
 * 团队面板心跳（M4 Web 下线判定）：每 30s 把当前活跃浏览器会话 key 汇总上报
 * gateway panel_heartbeat（gateway SessionPresence.panelTouch）。浏览器全关 →
 * 心跳表停更 → gateway 侧最后心跳 + 60s 宽限窗后 isCaptainOnline 判离线（fail-open
 * 修复：CLI/TUI 直连路径不受影响——直连 touch 独立维护）。
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

export function startTeamPresenceHeartbeat({ getBrowserActiveKeys, heartbeat }) {
  const timer = setInterval(async () => {
    try {
      const keys = getBrowserActiveKeys();
      if (keys.length > 0) await heartbeat(keys);
    } catch (error) {
      console.warn("[sati] panel heartbeat failed", error);
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

接线（ui/server/index.js 或 sati-bridge.js 启动处，**定向核对指引**：找到 ui/server 进程内 gateway 客户端实例（ensureGateway 返回的 gw）的通用方法调用通道——若 gw 是 RemoteGateway（ws 客户端），需在 `src/gateway/client/RemoteGateway.ts` 补 panelHeartbeat 客户端方法（仿 cronUpdate 客户端方法形态），再在 team-presence 接线处传 `heartbeat: keys => gw.panelHeartbeat({ sessionKeys: keys })`）：

- [ ] **Step 7: 测试 + 回归**

Run: `pnpm build && node --test dist/tests/gateway/sessionPresence.spec.js && find dist/tests/gateway -name '*.spec.js' | xargs node --test`
预期：panel 维度用例 PASS；gateway 既有测试（isActive 语义不回归——无 panelSeenAt 的既有行为完全不变）。

- [ ] **Step 8: 提交**

```bash
git add src/gateway/protocol/version.ts src/gateway/protocol/types.ts src/gateway/server/sessionPresence.ts src/gateway/server/GatewayWsConnection.ts src/cli/createLocalGateway.ts src/gateway/client/RemoteGateway.ts ui/server/team-presence.js ui/server/websocket/chat.js ui/server/index.js tests/gateway/sessionPresence.spec.ts
git commit -m "feat(gateway): 协议 1.4 panel_heartbeat——Web 下线判定接线（浏览器活跃心跳 → SessionPresence.panelTouch）"
```

---

### Task 6: gateway 面板数据/操作方法（team_panel_snapshot + team_tool_call）

**Files:**
- Modify: `src/gateway/protocol/types.ts`（Gateway 接口 + 两方法签名 + 面板快照类型）
- Modify: `src/gateway/server/GatewayWsConnection.ts`（两 case）
- Modify: `src/cli/createLocalGateway.ts`（两方法实现：TeamDb 直查 + 工具直调）
- Test: `tests/gateway/teamPanel.spec.ts`（新建）

- [ ] **Step 1: 写失败测试（直调 createLocalGateway 或抽纯函数）**

先读 createLocalGateway 的 team 装配点（setTeamTools 1026 附近）确认 db/scheduler/emit 与 registry 的持有形态，再决定测试形态：**推荐抽纯函数** `buildTeamPanelSnapshot(db, presence)`（新文件 `src/gateway/teamPanel.ts`）供 gateway 方法调用，测试直测纯函数（不拉起全量 gateway）：

Create: `tests/gateway/teamPanel.spec.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamDb, createTeamMember } from "../../src/agent/team/index.js";
import { SessionPresence } from "../../src/gateway/server/sessionPresence.js";
import { buildTeamPanelSnapshot, listTeamsForPanel } from "../../src/gateway/teamPanel.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sati-panel-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "调研组", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "researcher", modelRoute: { provider: "p", model: "m" } });
  db.insertTask({
    id: "a", teamId: "t1", subject: "A", description: "", status: "pending", assigneeId: undefined,
    dependencies: [], attempt: 0, attemptId: undefined, reassigning: false, blockedByCount: 0, maxAttempts: 3,
    createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
  });
  return { db };
}

test("buildTeamPanelSnapshot：团队 + 成员（含在线态/roleSlug/modelRoute/retired）+ 任务（含 attemptId/blockedByCount）+ 消息未读数", () => {
  const { db } = setup();
  const presence = new SessionPresence();
  const now = 1_000_000;
  presence.touch("cap-1", now); // 队长直连在线
  const snap = buildTeamPanelSnapshot(db, presence, now);
  assert.equal(snap.teams.length, 1);
  const team = snap.teams[0]!;
  assert.equal(team.id, "t1");
  assert.equal(team.captainOnline, true, "presence 合并：队长在线");
  assert.equal(team.members.length, 1);
  assert.equal(team.members[0]!.memberId, "m1");
  assert.equal(team.members[0]!.roleSlug, "researcher");
  assert.equal(team.members[0]!.modelRoute.provider, "p");
  assert.equal(team.members[0]!.retired, false);
  assert.equal(team.tasks.length, 1);
  assert.equal(team.tasks[0]!.taskId, "a");
  assert.equal(team.tasks[0]!.blockedByCount, 0);
  // 离线队长：presence.close 超宽限窗
  presence.close("cap-1", now);
  const snap2 = buildTeamPanelSnapshot(db, presence, now + 70_000);
  assert.equal(snap2.teams[0]!.captainOnline, false, "直连关闭超宽限窗 → 离线");
});

test("listTeamsForPanel：含归档态（archivedAt）与无队团队", () => {
  const { db } = setup();
  db.upsertTeam({ id: "t2", name: "已归档", captainSessionKey: "cap-2", createdAt: "2026-08-20T00:00:00.000Z", archivedAt: "2026-08-20T00:00:00.000Z" });
  const teams = listTeamsForPanel(db);
  assert.equal(teams.length, 2);
  assert.equal(teams.find(t => t.id === "t2")!.archivedAt, "2026-08-20T00:00:00.000Z");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/gateway/teamPanel.spec.js`
预期：FAIL——`buildTeamPanelSnapshot`/`listTeamsForPanel` 不存在。

- [ ] **Step 3: 实现纯函数模块**

Create: `src/gateway/teamPanel.ts`：

```ts
/**
 * 团队活动面板数据（M4）：gateway 侧纯函数——TeamDb 直查 + SessionPresence
 * 合并在线态，产出面板快照。不依赖工具注册表（数据面）；操作面（team_tool_call）
 * 在 createLocalGateway 内直调工具，权限/校验/事件走工具层既有链。
 */
import type { TeamDb, TeamTaskRow } from "../agent/team/index.js";
import type { SessionPresence } from "./server/sessionPresence.js";

export type PanelTeam = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
  archivedAt?: string;
  captainOnline: boolean;
  members: Array<{
    memberId: string;
    roleSlug: string;
    status: "idle" | "working";
    modelRoute: { provider?: string; model?: string };
    retired: boolean;
  }>;
  tasks: Array<{
    taskId: string;
    subject: string;
    status: TeamTaskRow["status"];
    attempt: number;
    attemptId?: string;
    assigneeId?: string;
    dependencies: string[];
    blockedByCount: number;
    handoffId?: string;
    output?: string;
  }>;
  unreadForCaptain: number;
};

/** 全部团队（含归档）的面板列表；成员/任务按团队聚合。 */
export function listTeamsForPanel(db: TeamDb): Array<{ id: string; name: string; archivedAt?: string }> {
  return db
    .listTeams()
    .map(t => ({ id: t.id, name: t.name, ...(t.archivedAt !== undefined ? { archivedAt: t.archivedAt } : {}) }));
}

/** 面板快照：团队 + 成员在线/角色 + 任务 + 队长未读消息数（captainSessionKey 收件箱）。 */
export function buildTeamPanelSnapshot(db: TeamDb, presence: SessionPresence, now: number = Date.now()): {
  teams: PanelTeam[];
} {
  const teams = db.listTeams();
  const members = db.listMembers();
  const tasks = db.listTasksAll ? db.listTasksAll() : teams.flatMap(t => db.listTasks(t.id)); // 确认 TeamDb 是否有一键 listTasksAll；无则 flatMap
  const messages = db.listMessagesAll ? db.listMessagesAll() : [];
  const byTeam = (teamId: string, rows: Array<{ teamId: string }>) => rows.filter(r => r.teamId === teamId);
  return {
    teams: teams.map(team => ({
      id: team.id,
      name: team.name,
      captainSessionKey: team.captainSessionKey,
      createdAt: team.createdAt,
      ...(team.archivedAt !== undefined ? { archivedAt: team.archivedAt } : {}),
      captainOnline: presence.isActive(team.captainSessionKey, now),
      members: byTeam(team.id, members).map(m => ({
        memberId: m.id,
        roleSlug: m.roleSlug,
        status: m.status,
        modelRoute: parseModelRouteLoose(m.modelRouteJson),
        retired: db.isRetired(m.sessionKey),
      })),
      tasks: byTeam(team.id, tasks).map(t => ({
        taskId: t.id,
        subject: t.subject,
        status: t.status,
        attempt: t.attempt,
        ...(t.attemptId !== undefined ? { attemptId: t.attemptId } : {}),
        ...(t.assigneeId !== undefined ? { assigneeId: t.assigneeId } : {}),
        dependencies: t.dependencies,
        blockedByCount: t.blockedByCount,
        ...(t.handoffId !== undefined ? { handoffId: t.handoffId } : {}),
        ...(t.output !== undefined ? { output: t.output } : {}),
      })),
      unreadForCaptain: byTeam(team.id, messages).filter(
        m => m.recipient === team.captainSessionKey && m.deliveredAt === undefined,
      ).length,
    })),
  };
}

function parseModelRouteLoose(json: string): { provider?: string; model?: string } {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { provider, model } = parsed as { provider?: unknown; model?: unknown };
      return {
        ...(typeof provider === "string" ? { provider } : {}),
        ...(typeof model === "string" ? { model } : {}),
      };
    }
  } catch {
    // 脏数据降级
  }
  return {};
}
```

**定向核对指引**：确认 TeamDb 是否有 `listTeams`（不带参数）/`listMessages(teamId, memberId)` 的既有签名与 `listTasks(teamId)`——按实际签名适配（`db.listTeams()` 若不存在则改 `listTeams` 真实 API；messages 的 recipient 字段名确认后适配）。

- [ ] **Step 4: gateway 接口 + 分发 + 实现**

Modify: `src/gateway/protocol/types.ts` Gateway 接口：

```ts
  /** M4：团队面板快照（TeamDb 直查 + presence 在线态；不触发模型回路）。 */
  teamPanelSnapshot?(input: { sessionKey?: string }): Promise<{ teams: unknown[] }>;
  /** M4：面板操作——直调既有 team_* 工具（权限 requireTeamCaptain/requireTeamMember + TeamEvent 广播走工具层）。 */
  teamToolCall?(input: { tool: string; input: Record<string, unknown>; sessionKey?: string }): Promise<{
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  }>;
```

Modify: `src/gateway/server/GatewayWsConnection.ts`（panel_heartbeat case 后）：

```ts
      case "team_panel_snapshot":
        if (this.options.gateway.teamPanelSnapshot) {
          return this.options.gateway.teamPanelSnapshot(frame.params as never);
        }
        return Promise.resolve(notConfigured({ teams: [] }, "Team panel snapshot not available"));
      case "team_tool_call":
        if (this.options.gateway.teamToolCall) {
          return this.options.gateway.teamToolCall(frame.params as never);
        }
        return Promise.resolve(notConfigured({ ok: false, error: { code: "not_configured", message: "Team tool call not available" } }, "Team tool call not available"));
```

Modify: `src/cli/createLocalGateway.ts`——gateway 对象加两方法（持有 teams db/registry；sessionKey 缺省取帧调用者？**定向核对指引**：帧 params 无 sessionKey 时以连接已鉴权会话为准——看既有方法（如 cronUpdate）怎么拿当前会话 key，仿照；简单起见 params.sessionKey 必传，UI 侧总是带）：

```ts
    teamPanelSnapshot: async (input: { sessionKey?: string }) => {
      return buildTeamPanelSnapshot(teamDb, presence);
    },
    teamToolCall: async (input: { tool: string; input: Record<string, unknown>; sessionKey?: string }) => {
      const tool = toolRegistry.get(input.tool); // createBuiltinRegistry({team}) 实例
      if (!tool) {
        return { ok: false, error: { code: "team_unknown_tool", message: `工具 ${input.tool} 不存在` } };
      }
      try {
        const out = await tool.execute(input.input as never, { sessionId: input.sessionKey ?? "" } as never);
        return { ok: true, data: out.data };
      } catch (error) {
        const code = error instanceof SatiToolRuntimeError ? error.code : "tool_execution_failed";
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { code, message } };
      }
    },
```

- [ ] **Step 5: 测试 + 回归**

Run: `pnpm build && node --test dist/tests/gateway/teamPanel.spec.js && find dist/tests/gateway -name '*.spec.js' | xargs node --test`
预期：纯函数用例 PASS；gateway 既有测试不回归（新增可选方法）。

- [ ] **Step 6: 提交**

```bash
git add src/gateway/teamPanel.ts src/gateway/protocol/types.ts src/gateway/server/GatewayWsConnection.ts src/cli/createLocalGateway.ts tests/gateway/teamPanel.spec.ts
git commit -m "feat(gateway): 面板数据/操作方法（team_panel_snapshot 快照 + team_tool_call 工具直调）"
```

---

### Task 7: ui/server 面板 REST 路由（/api/teams 系列）+ RemoteGateway 客户端方法

**Files:**
- Create: `ui/server/routes/teams.js`
- Modify: `ui/server/index.js`（挂载路由）
- Modify: `src/gateway/client/RemoteGateway.ts`（panelHeartbeat/teamPanelSnapshot/teamToolCall 客户端方法）
- Test: `ui/server/routes/teams.test.js`（新建；对齐 routes 既有测试形态）

- [ ] **Step 1: 读既有 REST 路由模式**

Run: `sed -n '1,60p' ui/server/routes/discovery-plans.js`（或 commands.js）
预期：Express Router 形态 + 错误处理中间件 + 挂载方式（index.js 里 `app.use("/api/...", router)`）。RemoteGateway 客户端方法形态：`grep -n "cronUpdate" src/gateway/client/RemoteGateway.ts`。

- [ ] **Step 2: RemoteGateway 客户端方法**

Modify: `src/gateway/client/RemoteGateway.ts`——仿 cronUpdate 客户端方法（send 帧 → 映射结果）：

```ts
  panelHeartbeat(input: { sessionKeys: string[] }): Promise<{ touched: number }> {
    return this.request("panel_heartbeat", input);
  }
  teamPanelSnapshot(input: { sessionKey?: string }): Promise<{ teams: unknown[] }> {
    return this.request("team_panel_snapshot", input);
  }
  teamToolCall(input: { tool: string; input: Record<string, unknown>; sessionKey?: string }): Promise<{
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  }> {
    return this.request("team_tool_call", input);
  }
```

（`this.request` 为既有私有方法名，按实际实现适配。）

- [ ] **Step 3: 写失败测试**

Create: `ui/server/routes/teams.test.js`（对齐 routes 既有测试形态——mock gateway 客户端；先读 `discovery-plans.js` 对应测试确认 mock 模式）：

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTeamsRouter } = require("./teams.js");

function mockGateway() {
  const calls = [];
  return {
    calls,
    panelHeartbeat: async input => { calls.push(["heartbeat", input]); return { touched: input.sessionKeys.length }; },
    teamPanelSnapshot: async () => ({ teams: [{ id: "t1", name: "x", captainOnline: true }] }),
    teamToolCall: async input => {
      calls.push(["tool", input]);
      return { ok: true, data: { messageId: "msg-1" } };
    },
  };
}

test("POST /api/teams/panel → gateway.teamPanelSnapshot", async () => {
  const gateway = mockGateway();
  const router = createTeamsRouter({ getGateway: async () => gateway });
  // 用 supertest 或直接调 handler（对齐既有测试工具——若项目无 supertest，直接构造 req/res 或导出手册式 invoke）
  // 【定向核对指引】对齐 routes 既有测试的 HTTP 调用方式（supertest？直接 handler？），按既有模式写。
  // 断言：200 + teams 数组；gateway.calls 含 ["snapshot", ...]
});

test("POST /api/teams/action 调 team_tool_call（转派/归档等全部操作走此口）", async () => {
  // tool: "team_reassign_task" + input → gateway.teamToolCall 转发 + 返回 data
});

test("POST /api/teams/heartbeat → gateway.panelHeartbeat", async () => {
  // sessionKeys 数组转发
});
```

- [ ] **Step 4: 实现路由**

Create: `ui/server/routes/teams.js`：

```js
/**
 * 团队活动面板 REST 路由（M4）：浏览器 → ui/server → gateway 协议方法。
 * 面板不直接碰 TeamDb（ui/server 无 teams.db 访问权），全部经 gateway
 * team_panel_snapshot / team_tool_call / panel_heartbeat 转发；权限/校验/
 * 事件广播在 gateway 侧工具层完成。
 */
const { Router } = require("express");

function createTeamsRouter({ getGateway }) {
  const router = Router();

  router.post("/panel", async (req, res, next) => {
    try {
      const gw = await getGateway();
      const { sessionKey } = req.body ?? {};
      const snapshot = await gw.teamPanelSnapshot({ sessionKey });
      res.json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  router.post("/action", async (req, res, next) => {
    try {
      const { tool, input, sessionKey } = req.body ?? {};
      if (typeof tool !== "string" || !input || typeof input !== "object") {
        return res.status(400).json({ ok: false, error: { code: "invalid_request", message: "tool/input 必填" } });
      }
      const gw = await getGateway();
      const result = await gw.teamToolCall({ tool, input, sessionKey });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/heartbeat", async (req, res, next) => {
    try {
      const { sessionKeys } = req.body ?? {};
      if (!Array.isArray(sessionKeys)) {
        return res.status(400).json({ touched: 0 });
      }
      const gw = await getGateway();
      res.json(await gw.panelHeartbeat({ sessionKeys }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createTeamsRouter };
```

Modify: `ui/server/index.js`——挂载（仿既有路由挂载行）：

```js
app.use("/api/teams", createTeamsRouter({ getGateway: ensureGateway }));
```

- [ ] **Step 5: 测试 + 回归**

Run: `cd ui && pnpm test`（Vitest/Node runner 对齐既有）或项目内路由测试运行方式（`node --test ui/server/routes/teams.test.js`——按既有路由测试的运行方式）；`pnpm build` 验证 RemoteGateway 类型。
预期：3 用例 PASS；既有路由测试不回归。

- [ ] **Step 6: 提交**

```bash
git add ui/server/routes/teams.js ui/server/index.js src/gateway/client/RemoteGateway.ts ui/server/routes/teams.test.js
git commit -m "feat(ui): 团队面板 REST 路由（/api/teams panel/action/heartbeat）+ RemoteGateway 客户端方法"
```

---

### Task 8: UI 面板数据层（useTeamPanel hook：快照轮询 + 事件订阅 + 操作调用）

**Files:**
- Create: `ui/src/components/team-panel/types.ts`
- Create: `ui/src/components/team-panel/constants.ts`
- Create: `ui/src/components/team-panel/hooks/useTeamPanel.ts`
- Test: `ui/src/components/team-panel/hooks/useTeamPanel.test.tsx`（新建）

- [ ] **Step 1: 读参照模式**

Run: `ls ui/src/components/git-panel/ ui/src/components/git-panel/hooks/` 与 `sed -n '1,80p' ui/src/components/git-panel/hooks/useGitPanel.ts`（或实际文件名）
预期：git-panel 扁平结构（components/ + hooks/ + types.ts + constants.ts + utils.ts）；hook 用 fetch/axios 调 /api/** REST + useState/useEffect。

- [ ] **Step 2: 类型 + 常量**

Create: `ui/src/components/team-panel/types.ts`：

```ts
/** 面板快照（与 gateway team_panel_snapshot 契约对应；ui 侧类型本地声明，不导入 src/）。 */
export type PanelMember = {
  memberId: string;
  roleSlug: string;
  status: "idle" | "working";
  modelRoute: { provider?: string; model?: string };
  retired: boolean;
};

export type PanelTask = {
  taskId: string;
  subject: string;
  status: string;
  attempt: number;
  attemptId?: string;
  assigneeId?: string;
  dependencies: string[];
  blockedByCount: number;
  handoffId?: string;
  output?: string;
};

export type PanelTeam = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
  archivedAt?: string;
  captainOnline: boolean;
  members: PanelMember[];
  tasks: PanelTask[];
  unreadForCaptain: number;
};

export type TeamPanelSnapshot = { teams: PanelTeam[] };

export type PanelActionResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };
```

Create: `ui/src/components/team-panel/constants.ts`：

```ts
export const TEAM_PANEL_POLL_MS = 5_000;
export const TEAM_ROLE_OPTIONS = [
  "technical_analyzer",
  "prior_art_searcher",
  "patent_analyzer",
  "drafter",
  "claim_drafter",
  "spec_drafter",
  "adjudicator",
  "adversarial-reviewer",
  "applicant-counsel",
  "case-manager",
  "formal-examiner",
  "tech-investigator",
] as const;
```

（12 岗清单以 `skills/patent-teams/` 目录实际角色为准——implementer ls 该目录核对后定。）

- [ ] **Step 3: 写失败测试**

Create: `ui/src/components/team-panel/hooks/useTeamPanel.test.tsx`（Vitest + Testing Library，fetch mock 模式对齐 git-panel 既有测试）：

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTeamPanel } from "./useTeamPanel";

const snapshot = {
  teams: [{ id: "t1", name: "x", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z", captainOnline: true, members: [], tasks: [], unreadForCaptain: 0 }],
};

describe("useTeamPanel", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } })) as never;
  });

  it("加载快照并轮询刷新", async () => {
    const { result } = renderHook(() => useTeamPanel());
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));
    expect(result.current.loading).toBe(false);
  });

  it("action 调用 POST /api/teams/action 并透传结果", async () => {
    const { result } = renderHook(() => useTeamPanel());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const out = await result.current.callAction("team_reassign_task", { teamId: "t1", taskId: "a", memberId: "m2" });
    expect(out).toEqual({ ok: true, data: expect.anything() });
    const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
    expect(call[0]).toContain("/api/teams/action");
  });

  it("错误响应 → ok: false", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: "team_not_captain", message: "x" } }), { status: 200 }),
    );
    const { result } = renderHook(() => useTeamPanel());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const out = await result.current.callAction("team_archive", { teamId: "t1" });
    expect(out.ok).toBe(false);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd ui && pnpm test -- team-panel`
预期：FAIL——useTeamPanel 不存在。

- [ ] **Step 5: 实现 hook**

Create: `ui/src/components/team-panel/hooks/useTeamPanel.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelActionResult, TeamPanelSnapshot } from "../types";
import { TEAM_PANEL_POLL_MS } from "../constants";

async function fetchSnapshot(): Promise<TeamPanelSnapshot> {
  const res = await fetch("/api/teams/panel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey: undefined }),
  });
  if (!res.ok) throw new Error(`panel snapshot failed: ${res.status}`);
  return (await res.json()) as TeamPanelSnapshot;
}

async function callTool(tool: string, input: Record<string, unknown>): Promise<PanelActionResult> {
  const res = await fetch("/api/teams/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, input }),
  });
  return (await res.json()) as PanelActionResult;
}

/** 团队面板数据层：快照轮询 + 操作调用（事件流由 useSessionWatch 既有链路订阅，见 Task 9 接线）。 */
export function useTeamPanel() {
  const [snapshot, setSnapshot] = useState<TeamPanelSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchSnapshot();
      setSnapshot(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => void refresh(), TEAM_PANEL_POLL_MS);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [refresh]);

  const callAction = useCallback(
    async (tool: string, input: Record<string, unknown>): Promise<PanelActionResult> => {
      const result = await callTool(tool, input);
      if (result.ok) void refresh(); // 操作成功立即刷新（不等下一轮询）
      return result;
    },
    [refresh],
  );

  return { snapshot, loading, error, refresh, callAction };
}
```

（fetch mock 的 Response 可用性：Vitest 环境（jsdom/node）需确认 Response 全局存在——若测试环境无 fetch/Response，用 vi.stubGlobal 补；对齐 git-panel 测试既有 mock 方式。）

- [ ] **Step 6: 测试 + typecheck**

Run: `cd ui && pnpm test -- team-panel && pnpm typecheck`
预期：3 用例 PASS；typecheck 绿。

- [ ] **Step 7: 提交**

```bash
git add ui/src/components/team-panel/
git commit -m "feat(ui): 团队面板数据层（useTeamPanel 快照轮询 + 操作调用）"
```

---

### Task 9: UI 面板视图（团队概览/成员卡/任务看板/消息/事件流）

**Files:**
- Create: `ui/src/components/team-panel/TeamPanel.tsx`（容器）
- Create: `ui/src/components/team-panel/TeamOverview.tsx`（团队卡 + 建队表单）
- Create: `ui/src/components/team-panel/MemberGrid.tsx`（成员状态卡 + 在线点）
- Create: `ui/src/components/team-panel/TaskBoard.tsx`（任务列表 + 状态徽章 + 依赖）
- Create: `ui/src/components/team-panel/EventStream.tsx`（TeamEvent 滚动）
- Modify: `ui/src/i18n/locales/en/*.json` + `zh-CN/*.json`（面板文案）

- [ ] **Step 1: 读 git-panel 组件与 shadcn 用法**

Run: `ls ui/src/components/git-panel/` 与 `sed -n '1,60p' ui/src/components/git-panel/GitPanel.tsx`（或实际容器文件名）
预期：容器组件接收 hook 数据 + shadcn/ui 组件（Card/Badge/Button）组合；Tailwind 样式内联。

- [ ] **Step 2: 实现容器 + 子视图（视图组件以 tailwind + shadcn 基础组件实现，文案走 i18n t()）**

Create: `ui/src/components/team-panel/TeamPanel.tsx`：

```tsx
import { useTranslation } from "react-i18next";
import { useTeamPanel } from "./hooks/useTeamPanel";
import { TeamOverview } from "./TeamOverview";
import { MemberGrid } from "./MemberGrid";
import { TaskBoard } from "./TaskBoard";
import { EventStream } from "./EventStream";

/** 团队活动面板（M4 全操作）：概览（建队）+ 成员 + 任务 + 事件流；操作经 callAction 走 gateway 工具链。 */
export function TeamPanel() {
  const { t } = useTranslation();
  const { snapshot, loading, error, refresh, callAction } = useTeamPanel();
  if (loading && snapshot === null) {
    return <div className="p-6 text-sm text-muted-foreground">{t("teamPanel.loading")}</div>;
  }
  const teams = snapshot?.teams ?? [];
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      {error !== null && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <TeamOverview teams={teams} onCreated={() => void refresh()} onCreate={async (name) => {
        const r = await callAction("team_create", { name });
        return r.ok;
      }} />
      {teams.filter(t => !t.archivedAt).map(team => (
        <div key={team.id} className="space-y-4">
          <MemberGrid team={team} onAction={callAction} />
          <TaskBoard team={team} onAction={callAction} />
        </div>
      ))}
      <EventStream />
    </div>
  );
}
```

（子组件实现要点——implementer 按此骨架写实，组件 props 类型在 types.ts 补全：）
- `TeamOverview`：团队卡列表（id/name/captain 在线徽章/归档态）+ 「新建团队」输入框 + 按钮（`team_create`）。
- `MemberGrid`：成员卡（memberId/roleSlug 徽章/status 圆点 idle 灰 working 绿/retired 置灰 + 退休标）；每队卡右上角「添加成员」输入（roleSlug 下拉选 TEAM_ROLE_OPTIONS）→ `team_add_member`；成员「转派」入口放在任务卡（见 TaskBoard）。
- `TaskBoard`：任务行（taskId/subject/status Badge 按色：pending 灰/claimed 蓝/in_progress 琥珀/completed 绿/failed 红/cancelled 灰 + attempt 计数 + blockedByCount + assigneeId）；操作：队长视角每个非终态任务「转派」下拉（选 idle 成员 → `team_reassign_task`）；「归档团队」按钮 → `team_archive`（confirm 二次确认）。
- `EventStream`：事件流容器（数据源见 Task 10 接线——useSessionWatch 事件过滤 TeamEvent 类型后滚动渲染；无数据时显示空态文案）。

- [ ] **Step 3: i18n 文案**

Modify: `ui/src/i18n/locales/en/` 与 `zh-CN/` 对应 namespace——新增 `teamPanel.*` 键（loading/新建团队/添加成员/转派/归档/成员/任务/在线/离线/工作中/空闲/已退休/事件流/空态/操作成功/操作失败等）。**强制项**：UI 新文案必须进 i18n，不硬编码。

- [ ] **Step 4: 组件测试（冒烟）**

Create: `ui/src/components/team-panel/TeamPanel.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TeamPanel } from "./TeamPanel";

describe("TeamPanel", () => {
  it("渲染团队卡与成员/任务区", async () => {
    // fetch mock 返回含 t1 团队（1 成员 1 任务）的快照
    render(<TeamPanel />);
    expect(await screen.findByText(/t1/)).toBeTruthy();
    expect(screen.getByText(/researcher/)).toBeTruthy();
  });
});
```

（i18n 初始化：对齐 git-panel 测试的 i18n setup——若既有测试都挂 i18next 全局则复用，否则 TeamPanel 测试里先 `import "../../../i18n"` 或 mock useTranslation。**定向核对指引**。）

- [ ] **Step 5: 测试 + typecheck**

Run: `cd ui && pnpm test -- team-panel && pnpm typecheck`
预期：冒烟测试 PASS；typecheck 绿。

- [ ] **Step 6: 提交**

```bash
git add ui/src/components/team-panel/ ui/src/i18n/locales/
git commit -m "feat(ui): 团队面板视图（概览/成员/任务/事件流 + i18n）"
```

---

### Task 10: 面板事件订阅接线 + 挂载（Sidebar 入口 + 主区页面）

**Files:**
- Modify: `ui/src/components/team-panel/EventStream.tsx`（useSessionWatch 事件订阅）
- Modify: `ui/src/components/app-shell/SidebarV2.tsx`（团队入口）
- Modify: `ui/src/components/app-shell/MainAreaV2.tsx`（团队面板视图切换）
- Modify: `ui/src/components/team-panel/TeamPanel.tsx`（接收事件流数据）

- [ ] **Step 1: 读既有挂载模式**

Run: `grep -rn "GitPanel\|git-panel" ui/src/components/app-shell/` 与 `grep -rn "useSessionWatch" ui/src/components/ | head -5`
预期：git-panel 已有 SidebarV2 入口 + MainAreaV2 切换的完整先例；useSessionWatch 返回会话事件数组（含类型字段）。

- [ ] **Step 2: 事件流接线**

Modify: `ui/src/components/team-panel/EventStream.tsx`——用 useSessionWatch 收当前会话事件，过滤 TeamEvent 形态（type 前缀 `team_` 或 M3 事件类型 task_claimed/task_completed/task_failed/task_retried/message_delivered/member_idle 等）：

```tsx
import { useSessionWatch } from "../../web/..."; // 按既有导入路径
import type { PanelTeam } from "../types";

const TEAM_EVENT_TYPES = new Set(["task_claimed", "task_completed", "task_failed", "task_retried", "message_delivered", "member_idle"]);

export function EventStream({ teams }: { teams: PanelTeam[] }) {
  const events = useSessionWatch(); // 既有 hook；返回会话事件（含 TeamEvent 经 emitForSession 广播的形态）
  const teamEvents = events.filter(e => TEAM_EVENT_TYPES.has(e.type));
  // 滚动渲染：时间戳 + type 徽章 + 关键字段（taskId/memberId/attempt）
}
```

**定向核对指引**：useSessionWatch 的返回结构与 TeamEvent 经 relay 到达浏览器的帧形态（eventMapping.ts 是否需为 TeamEvent 补映射——若未映射则 UI 收不到，需在 `src/web/client/eventMapping.ts`（Node 侧复用路径）或浏览器侧映射补 TeamEvent 类型）。先跑通确认：浏览器 watch 会话 → gateway emitForSession 广播 TeamEvent → relay 透传 → useSessionWatch 数组中出现 team 事件；若类型被过滤/不识别则补映射。

- [ ] **Step 3: Sidebar 入口 + 主区切换**

Modify: `ui/src/components/app-shell/SidebarV2.tsx`——仿 GitPanel 入口加「团队」导航项（icon + label i18n `teamPanel.nav`）。
Modify: `ui/src/components/app-shell/MainAreaV2.tsx`——仿 git 面板切换分支加 `TeamPanel` 渲染（view 状态值按既有枚举/字符串模式）。

- [ ] **Step 4: 测试 + typecheck + 手动冒烟**

Run: `cd ui && pnpm test -- team-panel && pnpm typecheck`
预期：既有 app-shell 测试不回归；typecheck 绿。（手动冒烟可选：`pnpm dev` 起服务开面板看数据。）

- [ ] **Step 5: 提交**

```bash
git add ui/src/components/team-panel/ ui/src/components/app-shell/ src/web/client/
git commit -m "feat(ui): 团队面板挂载（Sidebar 入口 + 主区切换 + TeamEvent 事件流订阅）"
```

---

### Task 11: 集成测试 + stress 场景 + 事件矩阵

**Files:**
- Modify: `tests/agent/team/`（集成测试扩展：自动转派全链）
- Modify: `tests/` stress 场景（场景 10：失败自动转派；面板 REST 链冒烟）
- Modify: `docs/event-producer-consumer.md`（task_retried 新事件）

- [ ] **Step 1: 自动转派集成测试**

Modify: 集成测试（M3 工具驱动全链测试所在文件，`tests/agent/team/` 下找 scheduler 集成 spec）追加：

```ts
test("失败任务自动转派：成员回合置 failed（未耗尽）→ 调度器重置回池 → 其他 idle 成员认领", async () => {
  // 用集成 harness（M3 既有）：双成员 + 单任务；m1 回合内 team_update_task(failed)；
  // onTaskGraphChanged → kickTeam → m2（idle）认领同一任务 attempt=2；
  // 断言：任务最终 claimed（assignee m2, attempt 2, attemptId 新）+ task_retried 事件已广播 + m2 收到 assignmentPrompt 含 attempt 2
});
```

（沿用 M3 集成测试 harness 的构造方式；若 harness 不便复用则直接测 scheduler：TeamDb + fake wake + emit 收集，`kickTeam` 后断言任务状态与事件。）

- [ ] **Step 2: 耗尽防环用例**

追加：

```ts
test("attempt 达 maxAttempts 的 failed 任务不再重置（防无限循环）", async () => {
  // 任务 attempt=3/maxAttempts=3 置 failed → kickTeam → 仍 failed；无 task_retried 事件
});
```

- [ ] **Step 3: stress 场景 10（自动转派收敛）**

Modify: stress 矩阵（`tests/agent/team/stress*.spec.ts` 或既有 stress 文件）追加场景 10：3 成员 + 5 任务链，前两任务成员失败（未耗尽）→ 自动转派收敛到全部 completed；断言最终任务数 + 转派次数 ≤ maxAttempts 总余量。

- [ ] **Step 4: 事件矩阵重生成**

Run: `pnpm gen:event-matrix`（新增 task_retried 声明/emit 边入矩阵；若 gen 脚本已自动覆盖则直接 `pnpm check:event-matrix`）
预期：`docs/event-producer-consumer.md` 更新含 task_retried；lint 门禁绿。

- [ ] **Step 5: 全量团队 + 工具测试**

Run: `pnpm build && find dist/tests/agent/team dist/tests/tool -name '*.spec.js' | xargs node --test`
预期：团队 suite（117+ 用例）与工具 suite 全绿。

- [ ] **Step 6: 提交**

```bash
git add tests/ docs/event-producer-consumer.md
git commit -m "test(team): 自动转派集成 + stress 场景 10 + 事件矩阵 task_retried"
```

---

### Task 12: 全量验证 + 记忆更新

**Files:**
- Modify: `docs/superpowers/specs/`（M4 无新 spec——计划即交付文档；如需补设计说明写 `docs/agent-teams-m4-notes.md`）
- Modify: `memory/agent-teams-m4-complete.md`（新建记忆）

- [ ] **Step 1: 全量验证链**

Run: `pnpm build && find dist/tests -name '*.spec.js' | xargs node --test`
预期：全量 3410+ 用例（新增约 +30）全绿，0 fail。

Run: `pnpm lint && pnpm format:check && cd ui && pnpm typecheck && cd .. && pnpm typecheck`
预期：lint 4 门禁（含 check:event-matrix/check:patent-sop）绿；biome 无待格式化；双 typecheck 绿。

- [ ] **Step 2: llm-replay 确认**

Run: `pnpm record:replay tests/fixtures/llm-replay/deepseek-v4-flash-basic && find dist/tests -name 'llm-replay*' | xargs node --test`
预期：fixture valid；重放测试 PASS（T1-T4 不进重放请求路径——团队工具条件注册 + 角色资产不进无参 registry；若意外失配，按 llm-replay-fixture-reregister 记忆流程重录）。

- [ ] **Step 3: 更新记忆**

Create: `memory/agent-teams-m4-complete.md`（frontmatter 仿 m3 记忆）+ `MEMORY.md` 索引行：
内容：M4 交付六项（全操作面板/自动转派/Web 下线判定/modelRoute 消费/插件解析器修复/domains 缺口）+ 协议 1.4 + 关键决策（team_tool_call 工具直调复用权限链、panel_heartbeat 心跳窗语义、自动转派 reassigning 保持 false 的原因）+ 验证数字 + M5 遗留（如 unarchive、宽限窗参数化、面板审批卡片深化）。

- [ ] **Step 4: 最终 code reviewer 全量审查**

按 subagent-driven-development 流程派最终 reviewer（无 Critical/Important 遗留 → 收尾）；遗留项处理原则：可快速修复的修复 + 补测；结构性边界（如 relay 单连接本质）文档化注释。

- [ ] **Step 5: 提交收尾**

```bash
git add docs/ memory/ 2>/dev/null; git commit -m "docs(team): M4 交付记录与记忆更新"
```

---

## 自审记录（对照 spec 的覆盖与一致性检查）

**Spec 覆盖**：
- ① 全操作活动面板（建队/加人/转派/归档/审批入面板）→ T6（gateway 操作通道）+ T7（REST）+ T8-T10（UI 全操作视图）。审批：面板审批入口=复用既有 approval 机制（gateway `approval_list_pending`/`approval_decide` 已有、UI 审批卡片已有）——面板事件流展示 approval_pending + 既有卡片处理，不重复实现（YAGNI）。⚠️ 本计划未为「面板内嵌审批待办列表」单独建任务——范围界定：面板聚焦团队操作（审批卡片是既有主聊天链功能）。若用户要求面板内嵌审批列表，追加任务。
- ② 失败任务自动转派 → T1（含防环上限 + task_retried 事件）。
- ③ Web 下线判定接线（最终复审 I1 闭环）→ T5（panel_heartbeat + SessionPresence.panelTouch + ui/server 心跳）。
- ④ modelRoute 消费（wakeMember 接线）→ T2。
- ⑤ 插件链路简易解析器缺陷修复 → T3。
- ⑥ 12 岗 domains 缺口 → T4（tech-investigator 设计意图保留）。

**占位符扫描**：T2/T5/T6/T7/T10 的「定向核对指引」标注了需 implementer 现场确认的接口形态（submitTurn 配置构造点、浏览器消息转发点、TeamDb listMessages 签名、RemoteGateway request 私有方法名、eventMapping 是否需补映射、i18n 测试 setup）——这些是既有代码的具体形态核对，非设计空白；对应代码修改意图与契约（类型/签名/行为）已在本计划中完整给出。若核对结果与计划契约冲突，implementer 应停下询问而非自由发挥。

**类型一致性**：`modelRoute: { provider: string; model: string }`（T2 GatewaySubmitTurnInput）与 T6 PanelTeam.members[].modelRoute（可选字段，面板展示降级）一致；`PanelActionResult`（T8）与 gateway teamToolCall 返回契约（T6）一致；TeamEvent `task_retried` 形态（T1）在 T11 集成测试与事件矩阵中使用一致。`unreadForCaptain`（T6/T8）在快照与面板展示处同名同义。

**依赖顺序**：T1-T4 独立（可并行）；T5→T6（协议 1.4 一次升版）；T6→T7→T8→T9→T10；T11 依赖 T1-T10；T12 收尾。
