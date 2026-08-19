# 团队编排层 M2（任务池/邮箱/调度器 + TeamEvent）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M1 durable 成员底座之上落地 L1+L2——共享任务池（状态机 + attempt 能力机制）、成员邮箱（投递租约）、事件驱动调度器（原子认领 + 并发闸 + 冷恢复 re-claim）、TeamEvent 事件族（进事件矩阵门禁），并追加专利团队资产移植（7 场景角色包）与角色映射表。

**Architecture:** 复用 M1 的 `src/agent/team/`（TeamDb + wakeMember + scanTeamMembers）；任务池/邮箱/调度器均为**锁内 read-modify-write + 纯函数不可变更新**（参照 dsh patent-teams 的 scheduler/state 语义，落到 SQLite 单进程事务模型）；调度触发 = 任务图变更 + 成员回合结束（`member_idle`）双触发，`wakeMember` 的 `onEvent` 接线点捕获回合结束事件；TeamEvent 经 `emitForSession` 广播（GatewayEvent 追加 `team_event` 变体，协议不升版，Web 客户端未知帧走 default 忽略，M4 再消费）。

**Tech Stack:** TypeScript 5.9（strict/ES2022/NodeNext）+ node:sqlite DatabaseSync + node:crypto randomUUID + Node test runner；验证脚本用 .mjs（node --test）。

**范围边界：** 本计划只含 M2（设计文档 §九 里程碑 M2 = L1+L2 + 验证出口）。M3（team_* 工具 + 角色注册接线）、M4（活动面板）另立计划。**用户追加待办**：Task 9（资产移植）、Task 10（角色映射表，注册接线明确留 M3）。**M1 遗留小项**融入：Task 2（searchChatHistory isInternalSession 同步）、Task 3（事件矩阵）、Task 5（onEvent → forwarder 审批冒泡接线）、Task 6（scanner 跳过 working + resume 消息共享）、Task 7（dispose 竞态注释）、Task 1（fail-loud 单测补强）。

**前置条件：** M1 已合入 main（2ee2468b）。设计文档：`docs/superpowers/specs/2026-08-19-agent-teams-design.md`（§三 L1、§四 L2、§八 测试）。参考实现：dsh `packages/patent/patent-teams/src/{types,scheduler,state}.ts`（已精读）。

---

## 文件结构

```
src/agent/team/
├── protocol/
│   ├── member-key.ts            # M1 已有，不动
│   ├── events.ts                # 新：TeamEvent 事件族 + TeamEventEmitter
│   └── broadcast.ts             # 新：toGatewayEvent 包装（TeamEvent → GatewayEvent team_event 变体）
├── storage/
│   └── team-db.ts               # 改：v2 迁移（tasks/messages）+ TaskRow/MessageRow + CRUD
├── member/                      # M1 已有
│   └── member-scanner.ts        # 改：跳过 working + scanStrandedTasks
├── taskpool/
│   ├── task-status.ts           # 新：TeamTaskStatus + TASK_TRANSITIONS + transitionError + unsatisfiedDependencies + 终态
│   ├── attempt.ts               # 新：beginTaskAttempt / invalidateTaskAttempt / validateAttemptUpdate / attemptsExhausted（纯函数）
│   └── index.ts                 # 新：barrel
├── mailbox/
│   ├── mailbox.ts               # 新：MAILBOX_LEASE_MS + claimDelivery / expiredClaims（纯函数）
│   └── index.ts                 # 新：barrel
├── scheduler/
│   ├── lock.ts                  # 新：withTeamLock（per-team promise 链）
│   ├── scheduler.ts             # 新：TeamScheduler（kickTeam/kickMember/双触发/并发闸/邮箱优先/失败回滚）
│   └── index.ts                 # 新：barrel
└── index.ts                     # 改：barrel 扩展
src/gateway/protocol/types.ts    # 改：GatewayEvent union 追加 team_event 变体
src/cli/createLocalGateway.ts    # 改：teamSubsystem 扩展（scheduler 句柄）+ dispose 竞态注释
src/session/search/searchChatHistory.ts  # 改：私有 isInternalSession 副本同步（Task 2）
scripts/team-stress-verify.mjs   # 新：故障注入验证矩阵（Task 8）
skills/patent-team-composition/SKILL.md  # 新：资产移植（Task 9）
docs/team-role-mapping.md        # 新：12 岗位 ↔ 34 角色映射（Task 10）
skills/patent-teams/             # 新：5 个缺位角色 SKILL.md（Task 10）
tests/agent/team/...             # 镜像单测（每任务）
docs/event-producer-consumer.md  # Task 3 重新生成
```

---

### Task 1: teams.db v2 迁移（tasks/messages 表 + TeamDb CRUD 扩展）

**Files:**
- Modify: `src/agent/team/storage/team-db.ts`
- Test: `tests/agent/team/storage/team-db-v2.spec.ts`（新）

- [ ] **Step 1: 写失败测试**（v2 迁移建表 + CRUD + 迁移保护）

```typescript
// tests/agent/team/storage/team-db-v2.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import { TeamDb } from "../../../src/agent/team/index.js";
import type { TeamTaskRow, TeamMessageRow } from "../../../src/agent/team/storage/team-db.js";

const TASK_BASE = {
  teamId: "t1",
  subject: "撰写答复稿",
  description: "",
  status: "pending" as const,
  dependencies: [] as string[],
  attempt: 0,
  reassigning: false,
  blockedByCount: 0,
  maxAttempts: 3,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

test("v2 迁移：tasks/messages 表可用，userVersion=2", () => {
  const db = new TeamDb(":memory:");
  try {
    assert.equal(db.userVersion(), 2);
    db.insertTask({ id: "t1", ...TASK_BASE });
    const task = db.getTask("t1", "t1");
    assert.equal(task?.subject, "撰写答复稿");
    assert.equal(task?.status, "pending");
  } finally {
    db.close();
  }
});

test("insertTask 拒绝重复 id（fail-loud）", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertTask({ id: "t1", ...TASK_BASE });
    assert.throws(() => db.insertTask({ id: "t1", ...TASK_BASE }), /UNIQUE constraint/);
  } finally {
    db.close();
  }
});

test("updateTask 全字段 upsert；依赖 JSON 往返保序", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertTask({ id: "t1", ...TASK_BASE });
    db.updateTask({
      id: "t1", ...TASK_BASE,
      status: "claimed", assigneeId: "m1", attempt: 1,
      attemptId: "a1", dependencies: ["t0", "t2"],
    });
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.status, "claimed");
    assert.equal(task.assigneeId, "m1");
    assert.equal(task.attemptId, "a1");
    assert.deepEqual(task.dependencies, ["t0", "t2"]);
  } finally {
    db.close();
  }
});

test("listTasks 按 created_at ASC 排序", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertTask({ id: "t1", ...TASK_BASE, createdAt: "2026-08-20T00:00:00.000Z" });
    db.insertTask({ id: "t2", ...TASK_BASE, createdAt: "2026-08-20T00:00:01.000Z" });
    assert.deepEqual(db.listTasks("t1").map(t => t.id), ["t1", "t2"]);
  } finally {
    db.close();
  }
});

test("listMessages：按 recipient 过滤 + insert/update 往返", () => {
  const db = new TeamDb(":memory:");
  try {
    db.insertMessage({
      id: "m1", teamId: "t1", sender: "captain", recipient: "m1", content: "补充检索",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    db.insertMessage({
      id: "m2", teamId: "t1", sender: "captain", recipient: "m2", content: "撰写答复",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    assert.deepEqual(db.listMessages("t1", "m1").map(m => m.id), ["m1"]);
    const msg = db.listMessages("t1", "m1")[0]!;
    db.updateMessage({ ...msg, deliveredAt: "2026-08-20T00:01:00.000Z" });
    assert.equal(db.listMessages("t1", "m1")[0]?.deliveredAt, "2026-08-20T00:01:00.000Z");
    assert.equal(db.listMessages("t1", "m2")[0]?.deliveredAt, undefined);
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/storage/team-db-v2.spec.js`
Expected: FAIL（`insertTask`/`getTask` 不存在；`userVersion()` 返回 1）

- [ ] **Step 3: 实现 v2 迁移与类型**

在 `src/agent/team/storage/team-db.ts` 追加（MIGRATIONS 数组 push 第二条）：

```typescript
export type TeamTaskRow = {
  id: string;                 // team 内唯一（"t1"…），由调用方生成
  teamId: string;
  subject: string;
  description: string;
  status: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "cancelled";
  assigneeId?: string;        // 成员 id 或 "captain"
  dependencies: string[];
  attempt: number;
  attemptId?: string;
  handoffId?: string;
  reassigning: boolean;
  blockedByCount: number;
  maxAttempts: number;
  output?: string;
  createdAt: string;
  updatedAt: string;
};

export type TeamMessageRow = {
  id: string;
  teamId: string;
  sender: string;             // "captain" 或成员 id
  recipient: string;          // 成员 id 或 "captain"
  content: string;
  createdAt: string;
  deliveryClaimedAt?: string;
  deliveredAt?: string;
  readAt?: string;
};
```

```typescript
// MIGRATIONS[1]：v2 tasks/messages
`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('pending','claimed','in_progress','completed','failed','cancelled')),
    assignee_id TEXT,
    dependencies_json TEXT NOT NULL DEFAULT '[]',
    attempt INTEGER NOT NULL DEFAULT 0,
    attempt_id TEXT,
    handoff_id TEXT,
    reassigning INTEGER NOT NULL DEFAULT 0,
    blocked_by_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    output TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivery_claimed_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    PRIMARY KEY (team_id, id)
  );`,
```

- [ ] **Step 4: 实现 CRUD 方法**（类内追加；SQLite 同步 API，行映射函数 `toTaskRow`/`toMessageRow` 参照既有 `toMemberRow`）

```typescript
  listTasks(teamId: string): TeamTaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE team_id = ? ORDER BY created_at ASC")
      .all(teamId) as TaskDbRow[];
    return rows.map(toTaskRow);
  }

  getTask(teamId: string, taskId: string): TeamTaskRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE team_id = ? AND id = ?")
      .get(teamId, taskId) as TaskDbRow | undefined;
    return row ? toTaskRow(row) : undefined;
  }

  insertTask(row: TeamTaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, team_id, subject, description, status, assignee_id,
           dependencies_json, attempt, attempt_id, handoff_id, reassigning,
           blocked_by_count, max_attempts, output, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.teamId, row.subject, row.description, row.status,
        row.assigneeId ?? null, JSON.stringify(row.dependencies), row.attempt,
        row.attemptId ?? null, row.handoffId ?? null, row.reassigning ? 1 : 0,
        row.blockedByCount, row.maxAttempts, row.output ?? null,
        row.createdAt, row.updatedAt,
      );
  }

  /** 全字段 upsert：调用方在锁内 read-modify-write 后落盘（乐观覆盖）。 */
  updateTask(row: TeamTaskRow): void {
    this.db
      .prepare(
        `UPDATE tasks SET subject=?, description=?, status=?, assignee_id=?,
           dependencies_json=?, attempt=?, attempt_id=?, handoff_id=?, reassigning=?,
           blocked_by_count=?, max_attempts=?, output=?, updated_at=?
         WHERE team_id = ? AND id = ?`,
      )
      .run(
        row.subject, row.description, row.status, row.assigneeId ?? null,
        JSON.stringify(row.dependencies), row.attempt, row.attemptId ?? null,
        row.handoffId ?? null, row.reassigning ? 1 : 0, row.blockedByCount,
        row.maxAttempts, row.output ?? null, row.updatedAt, row.teamId, row.id,
      );
  }

  listMessages(teamId: string, recipient?: string): TeamMessageRow[] {
    const rows = recipient === undefined
      ? this.db.prepare("SELECT * FROM messages WHERE team_id = ? ORDER BY created_at ASC").all(teamId)
      : this.db.prepare("SELECT * FROM messages WHERE team_id = ? AND recipient = ? ORDER BY created_at ASC").all(teamId, recipient);
    return (rows as MessageDbRow[]).map(toMessageRow);
  }

  insertMessage(row: TeamMessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, team_id, sender, recipient, content, created_at,
           delivery_claimed_at, delivered_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.teamId, row.sender, row.recipient, row.content, row.createdAt,
        row.deliveryClaimedAt ?? null, row.deliveredAt ?? null, row.readAt ?? null,
      );
  }

  updateMessage(row: TeamMessageRow): void {
    this.db
      .prepare(
        `UPDATE messages SET delivery_claimed_at=?, delivered_at=?, read_at=? WHERE team_id=? AND id=?`,
      )
      .run(
        row.deliveryClaimedAt ?? null, row.deliveredAt ?? null, row.readAt ?? null,
        row.teamId, row.id,
      );
  }
```

- [ ] **Step 5: 迁移保护测试补强（M1 遗留）**——追加到 `tests/agent/team/storage/team-db.spec.ts`（M1 既有文件）

```typescript
test("高版本库 fail-loud（M1 遗留补强）", () => {
  // 用 :memory: 建库 → PRAGMA user_version=99 → 再 new TeamDb 同一路径需抛错
  const db = new TeamDb(":memory:");
  db["db"].exec("PRAGMA user_version = 99"); // 绕过封装直接抬高版本
  assert.throws(() => new TeamDb(":memory:") /* 注：同进程新连接 */, /newer than supported/);
  db.close();
});
```

（若 `:memory:` 单例限制无法复现，改用 `mkdtemp` 真实文件路径建库再重开——见 `tests/agent/team/team-db.spec.ts` 既有写法，参照其临时目录模式。）

- [ ] **Step 6: 全量验证**

Run: `pnpm build && node --test dist/tests/agent/team/`
Expected: 全部 PASS（含 M1 既有 team 测试）

- [ ] **Step 7: Commit**

```bash
git add src/agent/team/storage/team-db.ts tests/agent/team/storage/ tests/agent/team/team-db.spec.ts
git commit -m "feat(agent): teams.db v2 迁移 tasks/messages 表与 CRUD（Task 1）"
```

---

### Task 2: 任务池协议（状态机 + attempt 纯函数）

**Files:**
- Create: `src/agent/team/taskpool/task-status.ts`、`src/agent/team/taskpool/attempt.ts`、`src/agent/team/taskpool/index.ts`
- Modify: `src/session/search/searchChatHistory.ts:392`（M1 遗留：私有 isInternalSession 副本同步）
- Test: `tests/agent/team/taskpool/task-status.spec.ts`、`tests/agent/team/taskpool/attempt.spec.ts`（新）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/agent/team/taskpool/task-status.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_TASK_STATUSES,
  TASK_TRANSITIONS,
  transitionError,
  unsatisfiedDependencies,
  type TeamTaskStatus,
} from "../../../src/agent/team/index.js";

test("终态无出边；白名单迁移矩阵完整", () => {
  assert.deepEqual(TASK_TRANSITIONS.pending, ["claimed", "cancelled"]);
  assert.deepEqual(TASK_TRANSITIONS.claimed, ["in_progress", "failed", "cancelled"]);
  assert.deepEqual(TASK_TRANSITIONS.in_progress, ["completed", "failed", "cancelled"]);
  for (const terminal of TERMINAL_TASK_STATUSES) {
    assert.deepEqual(TASK_TRANSITIONS[terminal], []);
  }
});

test("transitionError：非法迁移返回错误，同态/合法返回 undefined", () => {
  assert.equal(transitionError("pending", "completed"), "task status cannot move from \"pending\" to \"completed\"");
  assert.equal(transitionError("claimed", "in_progress"), undefined);
  assert.equal(transitionError("completed", "completed"), undefined);
});

test("unsatisfiedDependencies：只认 completed，缺失 id 也算未满足", () => {
  const tasks = [
    { id: "t1", status: "completed" as TeamTaskStatus },
    { id: "t2", status: "failed" as TeamTaskStatus },
  ];
  assert.deepEqual(unsatisfiedDependencies(tasks as never, ["t1", "t2", "t-missing"]), ["t2", "t-missing"]);
});
```

```typescript
// tests/agent/team/taskpool/attempt.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptsExhausted,
  beginTaskAttempt,
  invalidateTaskAttempt,
  validateAttemptUpdate,
  type TeamTaskRow,
} from "../../../src/agent/team/index.js";

function baseTask(overrides: Partial<TeamTaskRow> = {}): TeamTaskRow {
  return {
    id: "t1", teamId: "t1", subject: "x", description: "", status: "pending",
    dependencies: [], attempt: 0, reassigning: false, blockedByCount: 0,
    maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("beginTaskAttempt：attempt+1、claimed、attemptId、清 handoff/reassigning/output（不可变）", () => {
  const input = baseTask({ status: "pending", handoffId: "h1", reassigning: true, output: "旧" });
  const next = beginTaskAttempt(input, "m1", "cap-a1");
  assert.notEqual(next, input);                       // 不可变
  assert.equal(input.attempt, 0);                     // 原对象不变
  assert.equal(next.attempt, 1);
  assert.equal(next.status, "claimed");
  assert.equal(next.assigneeId, "m1");
  assert.equal(next.attemptId, "cap-a1");
  assert.equal(next.handoffId, undefined);
  assert.equal(next.reassigning, false);
  assert.equal(next.output, undefined);
});

test("invalidateTaskAttempt：清 attemptId、置 handoffId、回 pending；nextAssigneeId 控制 assignee", () => {
  const claimed = baseTask({ status: "claimed", assigneeId: "m1", attemptId: "a1", attempt: 2 });
  const revoked = invalidateTaskAttempt(claimed, { handoffId: "cap-h1" });
  assert.equal(revoked.status, "pending");
  assert.equal(revoked.attemptId, undefined);
  assert.equal(revoked.handoffId, "cap-h1");
  assert.equal(revoked.assigneeId, undefined);
  assert.equal(revoked.attempt, 2);                   // attempt 不重置

  const handed = invalidateTaskAttempt(claimed, { handoffId: "cap-h2", nextAssigneeId: "m2", reassigning: true });
  assert.equal(handed.assigneeId, "m2");
  assert.equal(handed.reassigning, true);
  assert.equal(handed.handoffId, "cap-h2");
});

test("validateAttemptUpdate：attemptId 匹配通过，不匹配/缺失拒绝", () => {
  const claimed = baseTask({ status: "in_progress", attemptId: "a1" });
  assert.equal(validateAttemptUpdate(claimed, "a1"), undefined);
  assert.equal(validateAttemptUpdate(claimed, "a2"), "stale-attempt: attemptId mismatch");
  assert.equal(validateAttemptUpdate(baseTask({ status: "completed" }), undefined), "stale-attempt: task is terminal");
});

test("attemptsExhausted：attempt >= maxAttempts 判定", () => {
  assert.equal(attemptsExhausted(baseTask({ attempt: 2 })), false);
  assert.equal(attemptsExhausted(baseTask({ attempt: 3 })), true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/taskpool/`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 task-status.ts**

```typescript
/**
 * 任务池状态机（移植 dsh patent-teams TASK_TRANSITIONS 语义到 Sati 契约）。
 * pending → claimed → in_progress → completed | failed | cancelled；终态不可变。
 */
import type { TeamTaskRow } from "../storage/team-db.js";

export type TeamTaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "failed" | "cancelled";

export const TASK_TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
  pending: ["claimed", "cancelled"],
  claimed: ["in_progress", "failed", "cancelled"],
  in_progress: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: readonly TeamTaskStatus[] = ["completed", "failed", "cancelled"];

export function transitionError(current: TeamTaskStatus, next: TeamTaskStatus): string | undefined {
  if (current === next) return undefined;
  if (!TASK_TRANSITIONS[current].includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`;
  }
  return undefined;
}

/** 依赖满足判定：dep 存在且 completed 才算满足；缺失/非完成均返回未满足 id。 */
export function unsatisfiedDependencies(
  tasks: readonly Pick<TeamTaskRow, "id" | "status">[],
  dependencies: string[],
): string[] {
  const byId = new Map(tasks.map(task => [task.id, task.status]));
  return dependencies.filter(id => byId.get(id) !== "completed");
}
```

- [ ] **Step 4: 实现 attempt.ts**（纯函数，不可变更新——返回新行，调用方落盘）

```typescript
import { randomUUID } from "node:crypto";
import type { TeamTaskRow } from "../storage/team-db.js";
import { TERMINAL_TASK_STATUSES } from "./task-status.js";

export type TaskAttemptResult = { task: TeamTaskRow; attemptId: string };

/** 开启新 attempt 代际：attempt+1、status=claimed、assignee、清 handoff/reassigning/output。 */
export function beginTaskAttempt(task: TeamTaskRow, assigneeId: string, attemptId = randomUUID()): TaskAttemptResult {
  return {
    attemptId,
    task: { ...task, status: "claimed", assigneeId, attempt: task.attempt + 1, attemptId, handoffId: undefined, reassigning: false, output: undefined, updatedAt: new Date().toISOString() },
  };
}

/** 撤销当前 attempt（转派/重试）：清 attemptId、置 handoffId、回 pending；attempt 计数保留。 */
export function invalidateTaskAttempt(
  task: TeamTaskRow,
  opts: { nextAssigneeId?: string; reassigning?: boolean; handoffId?: string } = {},
): TeamTaskRow {
  const { nextAssigneeId, reassigning = false, handoffId = randomUUID() } = opts;
  return {
    ...task,
    status: "pending",
    assigneeId: nextAssigneeId,
    attemptId: undefined,
    handoffId,
    reassigning,
    output: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/** 迟到写校验：终态任务或 attemptId 不匹配即拒绝（fail-closed）。 */
export function validateAttemptUpdate(task: TeamTaskRow, attemptId: string | undefined): string | undefined {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    return "stale-attempt: task is terminal";
  }
  if (task.attemptId === undefined || task.attemptId !== attemptId) {
    return "stale-attempt: attemptId mismatch";
  }
  return undefined;
}

export function attemptsExhausted(task: TeamTaskRow): boolean {
  return task.attempt >= task.maxAttempts;
}
```

`src/agent/team/taskpool/index.ts`：barrel 导出以上全部。

- [ ] **Step 5: searchChatHistory 私有副本同步（M1 遗留 #3）**

`src/session/search/searchChatHistory.ts:392` 附近的私有 `isInternalSession` 实现（识别 `channel:` 等内部前缀）不识 `team:` 前缀。改为导入共享实现：

```typescript
// 原私有实现删除，改为：
import { isInternalSession } from "../../storage/SessionList.js"; // 或既有共享导出位置（以实际为准）
```

先 `grep -n "isInternalSession" src/session/` 确认共享实现位置与导出；若共享实现已导出则直接复用并删除私有副本；若未导出则从私有副本提升为共享导出（放 `src/session/storage/SessionList.ts`，与 `TEAM_MEMBER_SESSION_PATTERN` 同文件）。补测试：`team:` 前缀会话在 searchChatHistory 中不可见。

- [ ] **Step 6: 全量验证**

Run: `pnpm build && node --test dist/tests/agent/team/taskpool/ && pnpm lint`
Expected: 全 PASS；lint 绿

- [ ] **Step 7: Commit**

```bash
git add src/agent/team/taskpool/ src/session/search/searchChatHistory.ts src/session/storage/SessionList.ts tests/agent/team/taskpool/
git commit -m "feat(agent): 任务池协议——状态机白名单 + attempt 能力机制纯函数（Task 2）"
```

---

### Task 3: TeamEvent 事件族 + 事件矩阵

**Files:**
- Create: `src/agent/team/protocol/events.ts`、`src/agent/team/protocol/broadcast.ts`
- Modify: `src/gateway/protocol/types.ts`（GatewayEvent union 追加 `team_event` 变体）
- Test: `tests/agent/team/protocol/events.spec.ts`（新）
- Modify: `docs/event-producer-consumer.md`（重新生成）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/agent/team/protocol/events.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import { toGatewayEvent } from "../../../../src/agent/team/index.js";
import type { TeamEvent } from "../../../../src/agent/team/protocol/events.js";

test("toGatewayEvent：TeamEvent 包装为 team_event 帧，载荷保真", () => {
  const event: TeamEvent = { type: "task_claimed", teamId: "t1", taskId: "t2", memberId: "m1", attempt: 1, attemptId: "a1" };
  const frame = toGatewayEvent(event);
  assert.equal(frame.type, "team_event");
  assert.equal(frame.teamId, "t1");
  assert.deepEqual(frame.event, event);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/protocol/events.spec.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 events.ts**

```typescript
/**
 * TeamEvent 事件族（M2）：团队编排层的对外事件契约。
 * 广播通道：经 gateway 复用现有事件帧（GatewayEvent team_event 变体）按队长会话扇出，
 * 协议不升版（无新增方法）；Web 客户端未知帧走 default 忽略（M4 再消费）。
 * 全部事件入事件矩阵（pnpm gen:event-matrix 重新生成 + check:event-matrix 门禁）。
 */
import type { TeamTaskStatus } from "../taskpool/task-status.js";

export type TeamEvent =
  | { type: "team_created"; teamId: string; name: string; captainSessionKey: string }
  | { type: "member_added"; teamId: string; memberId: string; roleSlug: string }
  | { type: "member_removed"; teamId: string; memberId: string; reason: string }
  | { type: "member_status"; teamId: string; memberId: string; status: "idle" | "working" }
  | { type: "member_idle"; teamId: string; memberId: string }
  | { type: "task_created"; teamId: string; taskId: string; subject: string; dependencies: string[] }
  | { type: "task_claimed"; teamId: string; taskId: string; memberId: string; attempt: number; attemptId: string }
  | { type: "task_updated"; teamId: string; taskId: string; status: TeamTaskStatus; attemptId?: string }
  | { type: "task_completed"; teamId: string; taskId: string; memberId: string; attempt: number; output?: string }
  | { type: "task_failed"; teamId: string; taskId: string; memberId: string; attempt: number; reason?: string }
  | { type: "task_reassigned"; teamId: string; taskId: string; fromMemberId: string; toMemberId: string }
  | { type: "message_delivered"; teamId: string; recipient: string; sender: string }
  | { type: "team_archived"; teamId: string };

/** 广播出口：按队长会话扇出（注入 InProcessGateway.emitForSession 闭包）。 */
export type TeamEventEmitter = (captainSessionKey: string, event: TeamEvent) => boolean;
```

- [ ] **Step 4: broadcast.ts + GatewayEvent 变体**

```typescript
// src/agent/team/protocol/broadcast.ts
import type { GatewayEvent } from "../../../gateway/protocol/types.js";
import type { TeamEvent } from "./events.js";

/** TeamEvent → GatewayEvent team_event 帧（gateway 协议不升版，事件载荷扩展）。 */
export function toGatewayEvent(event: TeamEvent): Extract<GatewayEvent, { type: "team_event" }> {
  return { type: "team_event", teamId: event.teamId, event };
}
```

`src/gateway/protocol/types.ts` GatewayEvent union 追加（放在 approval_resolved 之后、elicitation_request 之前均可，保持 union 尾部）：

```typescript
    /**
     * 团队编排事件（M2）：TeamEvent 事件族经现有广播通道按队长会话扇出。
     * 协议不升版（复用 agent_event 帧，无新增方法）；Web 端 M4 起消费，未知帧忽略。
     */
    | {
        type: "team_event";
        teamId: string;
        event: import("../../agent/team/protocol/events.js").TeamEvent;
      }
```

- [ ] **Step 5: 事件矩阵门禁**

Run: `pnpm gen:event-matrix && pnpm check:event-matrix`
Expected: 矩阵重新生成，`docs/event-producer-consumer.md` diff 含 `team_event` 相关行（含 TeamEvent 语汇/emit 边；若 TeamEvent 声明未被 AST 归入 AgentEvent 语汇，按 `scripts/gen-event-matrix.ts:246` 的启发式将 emit 点命名对齐 `emitEvent*` 或在矩阵脚本登记，并说明取舍）
注意：矩阵门禁对行号敏感——本任务后任何改动 `src/gateway/protocol/types.ts` 行数的后续任务（Task 5/7）完成时须复查 `pnpm check:event-matrix`。

- [ ] **Step 6: 全量验证**

Run: `pnpm build && node --test dist/tests/agent/team/ && pnpm lint`
Expected: 全 PASS；lint 绿（check:event-matrix 已挂 lint）

- [ ] **Step 7: Commit**

```bash
git add src/agent/team/protocol/ src/gateway/protocol/types.ts tests/agent/team/protocol/ docs/event-producer-consumer.md
git commit -m "feat(agent): TeamEvent 事件族与 gateway team_event 帧（事件矩阵门禁通过）（Task 3）"
```

---

### Task 4: 成员邮箱（投递租约）

**Files:**
- Create: `src/agent/team/mailbox/mailbox.ts`、`src/agent/team/mailbox/index.ts`
- Test: `tests/agent/team/mailbox/mailbox.spec.ts`（新）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/agent/team/mailbox/mailbox.spec.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAILBOX_LEASE_MS,
  claimDelivery,
  expiredClaims,
  unreadMessages,
  type TeamMessageRow,
} from "../../../src/agent/team/index.js";

function msg(id: string, overrides: Partial<TeamMessageRow> = {}): TeamMessageRow {
  return {
    id, teamId: "t1", sender: "captain", recipient: "m1", content: "x",
    createdAt: "2026-08-20T00:00:00.000Z", ...overrides,
  };
}

test("unreadMessages：未投递未认领（或租约过期未投递）为未读", () => {
  const now = 1756000000000;
  const rows = [
    msg("a"),                                                       // 未认领 → 未读
    msg("b", { deliveryClaimedAt: new Date(now - MAILBOX_LEASE_MS - 1).toISOString() }), // 租约过期 → 未读
    msg("c", { deliveredAt: "2026-08-20T00:00:00.000Z" }),          // 已投递 → 已读
    msg("d", { deliveryClaimedAt: new Date(now - 1000).toISOString() }), // 租约内 → 不算未读
  ];
  assert.deepEqual(unreadMessages(rows, now).map(m => m.id), ["a", "b"]);
});

test("claimDelivery：仅认领未认领消息，返回认领后的完整列表（不可变）", () => {
  const rows = [msg("a"), msg("b")];
  const claimedAt = "2026-08-20T00:01:00.000Z";
  const next = claimDelivery(rows, claimedAt);
  assert.notEqual(next, rows);
  assert.equal(rows[0]?.deliveryClaimedAt, undefined);   // 原列表不变
  assert.equal(next[0]?.deliveryClaimedAt, claimedAt);
  assert.equal(next[1]?.deliveryClaimedAt, claimedAt);
});

test("expiredClaims：已认领未投递且超租约的（用于释放重投）", () => {
  const now = 1756000000000;
  const rows = [
    msg("a", { deliveryClaimedAt: new Date(now - MAILBOX_LEASE_MS - 1).toISOString() }),
    msg("b", { deliveryClaimedAt: new Date(now - 1000).toISOString() }),
    msg("c", { deliveredAt: "2026-08-20T00:00:00.000Z" }),
  ];
  assert.deepEqual(expiredClaims(rows, now).map(m => m.id), ["a"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/mailbox/mailbox.spec.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 mailbox.ts**

```typescript
/**
 * 成员邮箱（M2）：队长/成员间持久消息 + 投递租约。
 * 租约语义（dsh 同构）：投递前 claimMailboxDelivery 写租约，唤醒被接受后
 * acknowledge（delivered_at），唤醒失败/超时由 expiredClaims 释放重投。
 * 损坏行（无法解析）由调用方跳过不阻塞团队（Task 5 处理）。
 */
import type { TeamMessageRow } from "../storage/team-db.js";

export const MAILBOX_LEASE_MS = 60_000;

/** 未读判定：未投递且（未认领 或 认领租约已过期）。 */
export function unreadMessages(rows: readonly TeamMessageRow[], now: number): TeamMessageRow[] {
  const leaseStart = now - MAILBOX_LEASE_MS;
  return rows.filter(row => {
    if (row.deliveredAt !== undefined) return false;
    if (row.deliveryClaimedAt === undefined) return true;
    return Date.parse(row.deliveryClaimedAt) < leaseStart;
  });
}

/** 认领投递（写租约）；不可变更新。 */
export function claimDelivery(rows: readonly TeamMessageRow[], claimedAt: string): TeamMessageRow[] {
  return rows.map(row => (row.deliveryClaimedAt === undefined ? { ...row, deliveryClaimedAt: claimedAt } : row));
}

/** 已认领未投递且超租约 → 释放（清 deliveryClaimedAt 由调用方落盘重投）。 */
export function expiredClaims(rows: readonly TeamMessageRow[], now: number): TeamMessageRow[] {
  const leaseStart = now - MAILBOX_LEASE_MS;
  return rows.filter(row => {
    if (row.deliveredAt !== undefined || row.deliveryClaimedAt === undefined) return false;
    return Date.parse(row.deliveryClaimedAt) < leaseStart;
  });
}
```

- [ ] **Step 4: 全量验证**

Run: `pnpm build && node --test dist/tests/agent/team/mailbox/mailbox.spec.js`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/team/mailbox/ tests/agent/team/mailbox/
git commit -m "feat(agent): 成员邮箱投递租约纯函数（未读/认领/过期释放）（Task 4）"
```

---

### Task 5: 事件驱动调度器（原子认领 + 并发闸 + 邮箱优先）

**Files:**
- Create: `src/agent/team/scheduler/lock.ts`、`src/agent/team/scheduler/scheduler.ts`、`src/agent/team/scheduler/index.ts`
- Test: `tests/agent/team/scheduler/scheduler.spec.ts`（新）

- [ ] **Step 1: 写失败测试**（fake db + fake gateway + fake emit，锁内行为全部可断言）

```typescript
// tests/agent/team/scheduler/scheduler.spec.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamDb, createTeamMember, TeamScheduler } from "../../../src/agent/team/index.js";
import type { TeamEvent } from "../../../src/agent/team/protocol/events.js";

type WakeRecord = { memberId: string; message: string };
type EmitRecord = { captain: string; event: TeamEvent };

async function setup(overrides: {
  maxConcurrentMembers?: number;
  isCaptainOnline?: () => boolean;
  wake?: (memberId: string, message: string) => Promise<boolean>;
} = {}): Promise<{ db: TeamDb; scheduler: TeamScheduler; wakes: WakeRecord[]; emits: EmitRecord[]; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "sati-team-sched-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "researcher", modelRoute: { provider: "p", model: "m" } });
  createTeamMember(db, { teamId: "t1", memberId: "m2", roleSlug: "drafter", modelRoute: { provider: "p", model: "m" } });
  const wakes: WakeRecord[] = [];
  const emits: EmitRecord[] = [];
  const scheduler = new TeamScheduler({
    db,
    emit: (captain, event) => { emits.push({ captain, event }); return true; },
    wake: async (memberId, message) => { wakes.push({ memberId, message }); return overrides.wake?.(memberId, message) ?? true; },
    maxConcurrentMembers: overrides.maxConcurrentMembers ?? 4,
    isCaptainOnline: overrides.isCaptainOnline ?? (() => true),
  });
  return { db, scheduler, wakes, emits, root };
}

test("kickTeam：依赖满足的 pending 任务派给未指派成员（邮箱优先于新任务）", async () => {
  const { db, scheduler, wakes, emits, root } = await setup();
  try {
    db.insertTask({ id: "t1", teamId: "t1", subject: "检索", description: "", status: "pending", dependencies: [], attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.memberId, "m1");
    assert.match(wakes[0]?.message ?? "", /Attempt id:/);
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.status, "claimed");
    assert.equal(task.assigneeId, "m1");
    assert.equal(task.attempt, 1);
    assert.ok(task.attemptId);
    assert.ok(emits.some(e => e.event.type === "task_claimed"));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("依赖未满足不认领；assignee 优先于未指派", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    const base = { teamId: "t1", subject: "x", description: "", attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: ["t1"] });   // 依赖未满足
    db.insertTask({ id: "t3", ...base, status: "pending", dependencies: [], assigneeId: "m2" }); // 指派 m2
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.memberId, "m2");
    assert.equal(db.getTask("t1", "t2")?.status, "pending");
    assert.equal(db.getTask("t1", "t3")?.status, "claimed");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("并发闸：working 成员数达上限不再派新任务（邮箱仍投递）", async () => {
  const { db, scheduler, wakes, root } = await setup({ maxConcurrentMembers: 1 });
  try {
    const base = { teamId: "t1", subject: "x", description: "", attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
    db.insertTask({ id: "t1", ...base, status: "pending", dependencies: [] });
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: [] });
    await scheduler.kickTeam("t1");
    await scheduler.kickTeam("t1");   // 再次触发：m1 已 working，m2 受闸限制
    assert.equal(wakes.length, 1);
    assert.equal(db.getTask("t1", "t2")?.status, "pending");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("唤醒失败回滚：只回滚自己的 ticket（attemptId 校验），成员回 idle", async () => {
  const { db, scheduler, wakes, root } = await setup({ wake: async () => false });
  try {
    db.insertTask({ id: "t1", teamId: "t1", subject: "x", description: "", status: "pending", dependencies: [], attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
    await scheduler.kickTeam("t1");
    const task = db.getTask("t1", "t1")!;
    assert.equal(task.status, "pending");
    assert.equal(task.attemptId, undefined);
    assert.equal(task.assigneeId, undefined);
    assert.equal(db.getMember("m1")?.status, "idle");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("邮箱优先：未读消息先投递（fallbackMailboxPrompt），投递成功才 ack", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    db.insertMessage({ id: "m1", teamId: "t1", sender: "captain", recipient: "m1", content: "补充检索 D2 参数", createdAt: "2026-08-20T00:00:00.000Z" });
    await scheduler.kickMember("t1", "m1");
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]?.message ?? "", /补充检索 D2 参数/);
    assert.equal(db.listMessages("t1", "m1")[0]?.deliveredAt !== undefined, true);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("队长离线：暂停认领（在途回合不派新任务）", async () => {
  const { db, scheduler, wakes, root } = await setup({ isCaptainOnline: () => false });
  try {
    db.insertTask({ id: "t1", teamId: "t1", subject: "x", description: "", status: "pending", dependencies: [], attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 0);
    assert.equal(db.getTask("t1", "t1")?.status, "pending");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("onMemberIdle：成员完成依赖链首任务后 idle → 触发接手下一任务（member_idle 广播）", async () => {
  const { db, scheduler, wakes, emits, root } = await setup();
  try {
    const base = { teamId: "t1", subject: "x", description: "", attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
    db.insertTask({ id: "t1", ...base, status: "pending", dependencies: [] });
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: ["t1"] });   // t2 依赖 t1，首轮无人可领
    await scheduler.kickTeam("t1");
    assert.equal(wakes.length, 1);   // 仅 m1 领到 t1
    // m1 完成 t1 后 idle → 调度器触发：t2 依赖解除，m1 接手
    const completed = db.getTask("t1", "t1")!;
    db.updateTask({ ...completed, status: "completed", updatedAt: "2026-08-20T00:00:01.000Z" });
    await scheduler.onMemberIdle("t1", "m1");
    assert.equal(wakes.length, 2);
    assert.equal(db.getTask("t1", "t2")?.status, "claimed");
    assert.equal(db.getTask("t1", "t2")?.assigneeId, "m1");
    assert.ok(emits.some(e => e.event.type === "member_idle"));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ownedOpenTask 优先：claimed/in_progress 且 assignee 成员的先重试（冷恢复语义）", async () => {
  const { db, scheduler, wakes, root } = await setup();
  try {
    const base = { teamId: "t1", subject: "x", description: "", dependencies: [], reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
    db.insertTask({ id: "t1", ...base, status: "claimed", assigneeId: "m1", attempt: 1, attemptId: "a1" });
    db.insertTask({ id: "t2", ...base, status: "pending", dependencies: [] });
    await scheduler.kickMember("t1", "m1");
    const task1 = db.getTask("t1", "t1")!;
    assert.equal(task1.attempt, 2);
    assert.notEqual(task1.attemptId, "a1");
    assert.equal(wakes[0]?.memberId, "m1");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/scheduler/scheduler.spec.js`
Expected: FAIL（TeamScheduler 不存在）

- [ ] **Step 3: 实现 lock.ts**

```typescript
/**
 * per-team 内存锁：promise 链串行化（dsh scheduler serializeMember 同构）。
 * Sati 单 gateway 进程常驻——锁保证同团队内 read-modify-write 原子性，
 * SQLite 事务兜底持久层一致性（进程崩溃安全由冷恢复负责）。
 */
const queues = new Map<string, Promise<unknown>>();

export async function withTeamLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  queues.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
```

- [ ] **Step 4: 实现 scheduler.ts**（核心：邮箱优先 → ownedOpenTask → nextReadyTask，锁内原子认领，失败回滚校验 attemptId）

```typescript
/**
 * 事件驱动调度器（M2）：非轮询——任务图变更（onTaskGraphChanged）与成员回合
 * 结束（onMemberIdle）双触发，锁内读最新状态原子认领。
 * 语义（dsh scheduler 同构）：
 * - 邮箱优先：未读消息先投递（投递租约 60s），成功才 ack；
 * - ownedOpenTask（成员名下 claimed/in_progress）优先于 nextReadyTask（依赖满足；
 *   先指派给自己的、其次未指派；reassigning 跳过）；
 * - 并发闸：working 成员数达 maxConcurrentMembers（默认 4）不派新任务（邮箱仍投递）；
 * - 唤醒失败回滚：锁内校验 attemptId 只回滚自己那次派发，不覆盖并发转派；
 * - 队长离线：isCaptainOnline 返回 false 时暂停认领（在途回合跑完即停）。
 */
import type { TeamDb, TeamTaskRow } from "../storage/team-db.js";
import { unsatisfiedDependencies } from "../taskpool/task-status.js";
import { beginTaskAttempt, invalidateTaskAttempt, type TaskAttemptResult } from "../taskpool/attempt.js";
import { claimDelivery, unreadMessages } from "../mailbox/mailbox.js";
import type { TeamEvent, TeamEventEmitter } from "../protocol/events.js";
import { withTeamLock } from "./lock.js";

export type TeamSchedulerOptions = {
  db: TeamDb;
  /** 广播出口（注入 gateway.emitForSession 闭包；Task 7 接线）。 */
  emit: TeamEventEmitter;
  /** 成员唤醒（复用 M1 wakeMember；返回 true = 接受）。 */
  wake: (memberId: string, followupMessage: string) => Promise<boolean>;
  /** 并发闸上限（默认 4）。 */
  maxConcurrentMembers?: number;
  /** 队长在线判定（默认常在线）；离线暂停认领。 */
  isCaptainOnline?: (captainSessionKey: string) => boolean;
};

export type DispatchTicket = {
  taskId: string;
  memberId: string;
  attempt: number;
  attemptId: string;
  subject: string;
  description?: string;
};

export function ownedOpenTask(tasks: readonly TeamTaskRow[], memberId: string): TeamTaskRow | undefined {
  return tasks.find(task => task.assigneeId === memberId && (task.status === "claimed" || task.status === "in_progress"));
}

export function nextReadyTask(tasks: readonly TeamTaskRow[], memberId: string): TeamTaskRow | undefined {
  const ready = tasks.filter(task =>
    task.status === "pending" && !task.reassigning && unsatisfiedDependencies(tasks, task.dependencies).length === 0,
  );
  return ready.find(task => task.assigneeId === memberId) ?? ready.find(task => task.assigneeId === undefined);
}

export function assignmentPrompt(ticket: DispatchTicket): string {
  return `Sati 团队调度器自动分派（共享任务池）。

任务: ${ticket.taskId} — ${ticket.subject}${ticket.description ? `\n\n${ticket.description}` : ""}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

本回合只执行此任务；完成后汇报队长。若后续更新被拒绝为 stale-attempt，说明任务已被转派，立即停止。
团队状态以 team 工具/队长会话为准，不要臆测任务状态。`;
}

export function fallbackMailboxPrompt(messages: Array<{ sender: string; content: string }>): string {
  return [
    "Sati 团队投递的持久消息（实时投递不可用期间的落盘消息）：",
    ...messages.map(m => `From ${m.sender}:\n${m.content}`),
    "\n本回合处理这些消息；任务分派仍以当前 attempt id 为准。",
  ].join("\n");
}

export class TeamScheduler {
  private readonly db: TeamDb;
  private readonly emit: TeamEventEmitter;
  private readonly wake: (memberId: string, message: string) => Promise<boolean>;
  private readonly maxConcurrentMembers: number;
  private readonly isCaptainOnline: (captainSessionKey: string) => boolean;

  constructor(options: TeamSchedulerOptions) {
    this.db = options.db;
    this.emit = options.emit;
    this.wake = options.wake;
    this.maxConcurrentMembers = options.maxConcurrentMembers ?? 4;
    this.isCaptainOnline = options.isCaptainOnline ?? (() => true);
  }

  /** 团队级触发：对每个 idle 成员给一件就绪工作。 */
  async kickTeam(teamId: string): Promise<void> {
    const team = this.db.getTeam(teamId);
    if (team === undefined || !this.isCaptainOnline(team.captainSessionKey)) return;
    const members = this.db.listMembers().filter(m => m.teamId === teamId);
    for (const member of members) {
      if (member.status !== "idle") continue;
      await this.kickMember(teamId, member.id);
    }
  }

  /** 成员级触发：邮箱投递优先，其次 ownedOpenTask/nextReadyTask 原子认领。 */
  async kickMember(teamId: string, memberId: string): Promise<void> {
    const team = this.db.getTeam(teamId);
    if (team === undefined || !this.isCaptainOnline(team.captainSessionKey)) return;
    const member = this.db.getMember(memberId);
    if (member === undefined || member.teamId !== teamId || member.status !== "idle" || this.db.isRetired(member.sessionKey)) return;

    await withTeamLock(teamId, async () => {
      // 1) 邮箱优先
      const unread = unreadMessages(this.db.listMessages(teamId, memberId), Date.now());
      if (unread.length > 0) {
        const claimedAt = new Date().toISOString();
        for (const message of claimDelivery(unread, claimedAt)) {
          this.db.updateMessage(message);
        }
        const accepted = await this.wake(memberId, fallbackMailboxPrompt(unread.map(m => ({ sender: m.sender, content: m.content }))));
        const fresh = this.db.listMessages(teamId, memberId);
        for (const message of fresh) {
          if (!unread.some(u => u.id === message.id)) continue;
          this.db.updateMessage(accepted ? { ...message, deliveredAt: new Date().toISOString() } : { ...message, deliveryClaimedAt: undefined });
        }
        if (accepted) this.emit(team.captainSessionKey, { type: "message_delivered", teamId, recipient: memberId, sender: unread[0]?.sender ?? "captain" });
        return;
      }

      // 2) 任务认领（锁内 read-modify-write）
      const tasks = this.db.listTasks(teamId);
      const task = ownedOpenTask(tasks, memberId) ?? nextReadyTask(tasks, memberId);
      if (task === undefined) return;
      const working = this.db.listMembers().filter(m => m.teamId === teamId && m.status === "working").length;
      if (task.status === "pending" && working >= this.maxConcurrentMembers) return; // 并发闸（重试自己的 open task 不受闸限）

      const { task: next, attemptId } = beginTaskAttempt(task, memberId);
      this.db.updateTask(next);
      this.db.updateMemberStatus(memberId, "working");
      this.emit(team.captainSessionKey, { type: "task_claimed", teamId, taskId: task.id, memberId, attempt: next.attempt, attemptId });

      const accepted = await this.wake(memberId, assignmentPrompt({ taskId: task.id, memberId, attempt: next.attempt, attemptId, subject: task.subject, ...(task.description ? { description: task.description } : {}) }));
      if (accepted) return;

      // 3) 唤醒失败回滚：只回滚自己的 ticket（attemptId 校验），不覆盖并发转派
      const fresh = this.db.getTask(teamId, task.id);
      if (fresh === undefined || fresh.attemptId !== attemptId) return;
      const revoked = invalidateTaskAttempt(fresh, {});
      this.db.updateTask(revoked);
      this.db.updateMemberStatus(memberId, "idle");
    });
  }

  /** 任务图变更触发（M3 team_create_task/update 等工具调用点；M2 供编程式入口）。 */
  async onTaskGraphChanged(teamId: string): Promise<void> {
    await this.kickTeam(teamId);
  }

  /** 成员回合结束触发（wakeMember onEvent 接线点；M1 已知限制在此闭环）。 */
  async onMemberIdle(teamId: string, memberId: string): Promise<void> {
    const team = this.db.getTeam(teamId);
    if (team === undefined) return;
    this.db.updateMemberStatus(memberId, "idle");
    this.emit(team.captainSessionKey, { type: "member_idle", teamId, memberId });
    await this.kickMember(teamId, memberId);
  }
}
```

- [ ] **Step 5: 成员状态迁移补强**（`member-waker.ts`：`updateMemberStatus` 已由 wakeMember 维护；本任务不重复改，调度器独占调用点。若测试暴露「wakeMember 与调度器双写状态」竞态——wakeMember 的 finally 置 idle 与 onMemberIdle 置 idle 幂等，无竞态，注释说明即可）

- [ ] **Step 6: 全量验证**

Run: `pnpm build && node --test dist/tests/agent/team/scheduler/ && pnpm lint`
Expected: 全 PASS；lint 绿（若 types.ts 行数变化触发矩阵 stale，先 `pnpm gen:event-matrix` 再验）

- [ ] **Step 7: Commit**

```bash
git add src/agent/team/scheduler/ tests/agent/team/scheduler/ docs/event-producer-consumer.md
git commit -m "feat(agent): 事件驱动调度器——锁内原子认领/邮箱优先/并发闸/失败回滚（Task 5）"
```

---

### Task 6: 冷恢复扩展（scanner 跳过 working + stranded 任务 re-claim）

**Files:**
- Modify: `src/agent/team/member/member-scanner.ts`、`src/agent/team/member/member-waker.ts`（文案共享）
- Test: `tests/agent/team/member/member-scanner.spec.ts`（追加）、`tests/agent/team/member/stranded-tasks.spec.ts`（新）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/agent/team/member/stranded-tasks.spec.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamDb, createTeamMember, scanStrandedTasks } from "../../../src/agent/team/index.js";

async function setup(): Promise<{ db: TeamDb; root: string; invalidated: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "sati-team-stranded-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "researcher", modelRoute: { provider: "p", model: "m" } });
  createTeamMember(db, { teamId: "t1", memberId: "m2", roleSlug: "drafter", modelRoute: { provider: "p", model: "m" } });
  const invalidated: string[] = [];
  const result = await scanStrandedTasks({
    db,
    invalidateAndKick: async (teamId, taskId, memberId) => { invalidated.push(`${teamId}:${taskId}:${memberId}`); },
  });
  return { db, root, invalidated };
}

test("stranded 任务（claimed/in_progress 但成员 idle）→ invalidate + re-claim 回调", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-stranded-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
  const base = { teamId: "t1", subject: "x", description: "", attempt: 1, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
  db.insertTask({ id: "t1", ...base, status: "claimed", assigneeId: "m1", attemptId: "a1" });   // 成员 idle + claimed → stranded
  db.insertTask({ id: "t2", ...base, status: "in_progress", assigneeId: "m1", attemptId: "a2" }); // 同上
  db.insertTask({ id: "t3", ...base, status: "claimed", assigneeId: "m2" });                     // 成员不存在 → stranded
  db.insertTask({ id: "t4", ...base, status: "pending" });                                       // 非 open → 不动
  const invalidated: string[] = [];
  const result = await scanStrandedTasks({
    db,
    invalidateAndKick: async (teamId, taskId, memberId) => { invalidated.push(`${teamId}:${taskId}:${memberId}`); },
  });
  assert.deepEqual(result.stranded, 3);
  assert.deepEqual(invalidated.sort(), ["t1:t1:m1", "t1:t2:m1", "t1:t3:m2"]);
  // 终态/依赖未满足任务不受影响
  db.close();
  await rm(root, { recursive: true, force: true });
});

test("working 成员的名下任务不算 stranded（未中断）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-stranded-"));
  const db = new TeamDb(join(root, "teams.db"));
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
  db.updateMemberStatus("m1", "working");
  const base = { teamId: "t1", subject: "x", description: "", attempt: 1, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
  db.insertTask({ id: "t1", ...base, status: "claimed", assigneeId: "m1", attemptId: "a1" });
  const invalidated: string[] = [];
  const result = await scanStrandedTasks({ db, invalidateAndKick: async (teamId, taskId, memberId) => { invalidated.push(`${teamId}:${taskId}:${memberId}`); } });
  assert.equal(result.stranded, 0);
  db.close();
  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/member/`
Expected: FAIL（scanStrandedTasks 不存在）

- [ ] **Step 3: 实现 scanner 扩展**（member-scanner.ts 追加；M1 遗留 #2：scanTeamMembers 跳过 working 成员）

```typescript
export type ScanStrandedTasksOptions = {
  db: TeamDb;
  /** 回调：stranded 任务的 invalidate + 重新认领（Task 7 接线到 TeamScheduler.kickMember）。 */
  invalidateAndKick: (teamId: string, taskId: string, memberId: string) => Promise<void>;
};

export type ScanStrandedTasksResult = { stranded: number };

/**
 * 冷恢复（M2 扩展）：stranded 任务 = claimed/in_progress 但 assignee 成员 idle
 * （或成员已退休/不存在）→ invalidate 旧 attempt（生成 handoffId 拒绝迟到写）
 * → 回调重新认领（新 attempt）。依赖未满足/终态任务不处理。
 * 不抛错：单团队失败跳过，宿主负责日志（与 scanTeamMembers 契约一致）。
 */
export async function scanStrandedTasks(options: ScanStrandedTasksOptions): Promise<ScanStrandedTasksResult> {
  const { db, invalidateAndKick } = options;
  let stranded = 0;
  for (const team of db.listTeams()) {
    const members = new Map(db.listMembers().filter(m => m.teamId === team.id).map(m => [m.id, m]));
    for (const task of db.listTasks(team.id)) {
      if (task.status !== "claimed" && task.status !== "in_progress") continue;
      if (task.assigneeId === undefined) continue;
      const member = members.get(task.assigneeId);
      const isStranded = member === undefined || db.isRetired(member.sessionKey) || member.status !== "working";
      if (!isStranded) continue;
      try {
        await invalidateAndKick(team.id, task.id, task.assigneeId);
        stranded += 1;
      } catch {
        // 单任务失败不阻塞团队扫描
      }
    }
  }
  return { stranded };
}
```

`scanTeamMembers` 增加 working 跳过（M1 遗留 #2）：成员循环内 `if (member.status !== "idle") continue;`（当前仅按断点形态跳过，补显式状态检查）。`TEAM_MEMBER_RESUME_MESSAGE` 文案由 scanner 导出供 scheduler 复用（已有导出，确认 scheduler 不再自造文案）。

`TeamDb` 补 `listTeams(): TeamRow[]`（当前缺——`team-db.ts:117-131` 只有 upsertTeam/getTeam；实现参照 `listMembers()` 的模式：`SELECT * FROM teams ORDER BY created_at ASC` + `toTeamRow` 映射）。

- [ ] **Step 4: 全量验证**

Run: `pnpm build && node --test dist/tests/agent/team/ && pnpm lint`
Expected: 全 PASS；lint 绿

- [ ] **Step 5: Commit**

```bash
git add src/agent/team/member/ tests/agent/team/member/
git commit -m "feat(agent): 冷恢复扩展——scanner 跳过 working + stranded 任务 invalidate/re-claim（Task 6）"
```

---

### Task 7: createLocalGateway 接线（teamSubsystem 扩展 + 集成验证）

**Files:**
- Modify: `src/cli/createLocalGateway.ts`
- Test: `tests/agent/team/team-gateway-integration.spec.ts`（追加）

- [ ] **Step 1: 接线改造**

`CreateLocalGatewayResult.teamSubsystem` 扩展（`src/cli/createLocalGateway.ts:214` 附近）：

```typescript
export type TeamSubsystemHandle = {
  db: TeamDb;
  runMemberScan: () => Promise<ScanTeamMembersResult>;
  /** M2：任务池调度器（事件驱动；M3 起由 team_* 工具驱动）。 */
  scheduler: TeamScheduler;
  /** M2：冷恢复 stranded 任务扫描（启动时与 runMemberScan 并列调用）。 */
  runStrandedScan: () => Promise<ScanStrandedTasksResult>;
};
```

接线（createLocalGateway 内）：
- `const teamScheduler = new TeamScheduler({ db: teamDb, emit: (captain, event) => gateway.emitForSession(captain, toGatewayEvent(event)), wake: (memberId, message) => wakeMember(teamDb, gateway, memberId, message).then(() => true).catch(() => false), isCaptainOnline: ... })`——`isCaptainOnline` 默认常在线；`wake` 失败返回 false（调度器回滚路径）
- `runStrandedScan = () => scanStrandedTasks({ db: teamDb, invalidateAndKick: async (teamId, taskId, memberId) => { /* invalidate 旧 attempt（invalidateTaskAttempt + updateTask）+ scheduler.kickMember */ } })`
- 启动末尾（冷恢复两段串行编排——Task 6 code review 修复要求）：
  `void (async () => { teamDb.resetMemberStatuses(); await runMemberScan(); await runStrandedScan(); })();`
  - `resetMemberStatuses()`（Task 6 已实现）：进程重启后不存在存活 turn，崩溃残留的 working 必为死状态，必须先行重置，否则 working-skip/stranded 判定会让崩溃成员永久失去冷恢复
  - 串行 await（先成员扫描后 stranded 扫描）：避免双扫描交错对同一成员双重唤醒（scanTeamMembers 内另有唤醒前状态复查兜底）
- **M1 已知限制闭环**：`wakeMember` 的 `onEvent` 接线——调度器唤醒成员时捕获 `turn_completed` → `teamScheduler.onMemberIdle(teamId, memberId)`（`wake` 包装层内实现；turn 内 `approval_pending` 仍经既有 TeamApprovalForwarder 转发，冷恢复 turn 的审批冒泡由此接通）
- **实现修正（最终 code review，b77ce85a）**：
  - 冷恢复 turn 审批冒泡接线兑现：`scanTeamMembers` 增 `onEvent?` 透传（per-member 闭包），`runMemberScan` 接 `TeamApprovalForwarder.handleMemberEvent`——上方"由此接通"承诺闭环
  - C1：stranded invalidate 进团队锁 + 锁内复查（任务仍 claimed/in_progress、成员非 working 且未退休才 invalidate）——防扫描快照与调度器锁内 claim 的 TOCTOU 双执行；kickMember 留在锁外（自身锁内，避免重入死锁）
  - C2：re-claim 有界——`turn_completed` 后检查 ownedOpenTask，`attempt >= maxAttempts` 且 `validateAttemptUpdate` 通过 → 置 `failed` 终止循环（M2 无 team 工具在回合内完成任务，原"回合结束持续 re-claim"收敛为最多 maxAttempts 轮；集成测试由时序断言改为轮询收敛断言，偶发挂起消除）
  - 顺手项：`assigneeId === "captain"` 任务跳过 stranded 判定；`isCaptainOnline` 未接线（默认常在线）与 `message_delivered` 批次 sender 语义以注释标注留 M3
- dispose 竞态注释（M1 遗留 #5）：`dispose` 内 `teamDb.close()` 前的顺序注释——「先关 db 后 registry.invalidate 存在窗口：invalidate 回调可能再触 db 读。M2 调度器已注入 emit/wake 闭包，dispose 后闭包调用由 gateway 生命周期保证不再触发；db.close() 幂等守卫已防双关」；并加 `teamScheduler` 无资源需释放的注释

- [ ] **Step 2: 集成测试追加**（`tests/agent/team/team-gateway-integration.spec.ts`，M1 测试后追加用例）

```typescript
test("集成：任务图变更 → 调度器原子认领 → 成员转录产出（fake model）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-integration2-"));
  await writeFile(join(root, "sati.yaml"), [...最小配置同 M1 测试...].join("\n"), "utf8");
  const result = createLocalGateway({
    projectRoot: root, pilotHome: root, env: {},
    __testModelFactory: () => ({ stream: async function* () { yield { type: "text_delta", text: "已完成。" }; }, complete: async () => { throw new Error("unused"); }, getCapabilities: () => DEFAULT_MODEL_CAPABILITIES, getMultimodal: () => ({ input: ["text"] }), getProviderProtocol: () => undefined, getProviderBaseUrl: () => undefined }),
  });
  try {
    const team = result.teamSubsystem;
    team.db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-20T00:00:00.000Z" });
    createTeamMember(team.db, { teamId: "t1", memberId: "m1", roleSlug: "researcher", modelRoute: { provider: "fake", model: "fake-model" } });
    team.db.insertTask({ id: "t1", teamId: "t1", subject: "检索 D2", description: "", status: "pending", dependencies: [], attempt: 0, reassigning: false, blockedByCount: 0, maxAttempts: 3, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" });
    await team.scheduler.onTaskGraphChanged("t1");
    assert.equal(team.db.getTask("t1", "t1")?.status, "claimed");
    // 成员回合真实跑完（fake model 单轮结束）→ 转录落盘
    const { readTranscript } = await import("../../../src/session/transcript/TranscriptReader.js");
    const { getPilotProjectChatDir } = await import("../../../src/pilot/index.js");
    const { sanitizeSessionIdForPath } = await import("../../../src/session/storage/ProjectSessionStorage.js");
    const chatDir = getPilotProjectChatDir(root, root);
    const transcript = await readTranscript(join(chatDir, `${sanitizeSessionIdForPath("team:t1:m1")}.jsonl`));
    assert.ok(transcript.entries.some(entry => entry.type === "turn_completed" || entry.type === "durable_message"));
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
```

（若 `turn_completed` 条目类型名与转录实际不符，以 M1 集成测试断言的 `accepted_input` + 实际回合条目为准调整。）

- [ ] **Step 3: 全量验证**

Run: `pnpm build && node --test dist/tests/agent/team/ && pnpm lint && pnpm format:check`
Expected: 全 PASS；lint/format 绿；若 types.ts/createLocalGateway.ts 行数变化 → `pnpm gen:event-matrix` 后重验

- [ ] **Step 4: Commit**

```bash
git add src/cli/createLocalGateway.ts tests/agent/team/team-gateway-integration.spec.ts docs/event-producer-consumer.md
git commit -m "feat(agent): createLocalGateway 接线调度器/stranded 扫描 + 审批冒泡闭环（Task 7）"
```

---

### Task 8: 故障注入验证矩阵（team-stress-verify.mjs）

**Files:**
- Create: `scripts/team-stress-verify.mjs`（node:sqlite 直接驱动 TeamDb + TeamScheduler 纯逻辑，不启 gateway）

- [ ] **Step 1: 写验证脚本**（设计文档 §八.2：8 成员 × 31 节点多层 DAG + 并发接管 + 迟到写入风暴 + 冷重启 + 认领竞争 + 终态覆盖 + 消息突发 + 归档）

```javascript
#!/usr/bin/env node
/**
 * 团队编排 M2 故障注入验证矩阵（dsh 式，脚本直驱不启 gateway）：
 * 1) 8 成员 × 31 节点多层 DAG（依赖链 4 层）全量跑通（模拟 wake 即完成，attempt 递增）
 * 2) 并发接管/移除：扫描期间随机 invalidate（handoff 竞态）→ 迟到写全部被 stale-attempt 拒绝
 * 3) 迟到写入风暴：50 次带旧 attemptId 的 updateTask → 全部拒绝、终态不变
 * 4) 冷重启：4 个 open 任务（claimed/in_progress）→ scanStrandedTasks 全部 re-claim 新 attempt
 * 5) 认领竞争：7 路并发 kickMember 同一任务 → 恰好一个 attempt 生效
 * 6) 终态覆盖：40 次终态任务 updateTask 尝试 → 全部拒绝
 * 7) 消息突发：42 条未读消息 → 调度器按租约逐批投递、无丢
 * 8) 最终归档：全部任务终态后 team_archived 事件发出
 * 退出码 0=全过；任一断言失败即抛错退出 1。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 直接 import dist（计划实施时以 dist 或 tsx 直跑为准——用 node:sqlite + 构建后 dist）
const { TeamDb, TeamScheduler, createTeamMember, scanStrandedTasks } = await import("../dist/src/agent/team/index.js");
// ...
```

（脚本骨架如上；具体场景实现要求：使用 `mkdtempSync` 临时目录 + `:memory:` 不可跨场景共享；每个场景独立建库；wake 模拟为「写 completed + attemptId 校验通过」的即时完成函数；统计断言硬性抛错。**场景 2/3/6 的断言核心**：`updateTask` 携带旧 attemptId 时必须被 `validateAttemptUpdate` 拒绝（调度器外直调 `validateAttemptUpdate` 断言 + 状态不变）。）

- [ ] **Step 2: 运行验证**

Run: `pnpm build && node scripts/team-stress-verify.mjs`
Expected: 8 个场景全部通过，输出 `team-stress-verify: 8/8 scenarios passed`，退出码 0

- [ ] **Step 3: 挂 npm script**（根 package.json scripts 追加）

```json
"test:team-stress": "pnpm build && node scripts/team-stress-verify.mjs"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/team-stress-verify.mjs package.json
git commit -m "test(agent): 团队编排故障注入验证矩阵 8 场景（Task 8）"
```

---

### Task 9: 专利团队资产移植（patent-team-composition SKILL.md）

**Files:**
- Create: `skills/patent-team-composition/SKILL.md`

- [ ] **Step 1: 移植资产**（镜像 dsh `apps/cli/config/agent-presets/patent/skills/patent-team-composition/SKILL.md`，适配 Sati 语境）

要求：
- 内容主体照搬 dsh 版：12 角色总表（case-manager/researcher/drafter/technical-expert/adversarial-reviewer/applicant-counsel/formal-examiner/invalidity-petitioner/patentee-defender/adjudicator/defendant-counsel/tech-investigator + role id + 立场 + 职责 + 适用场景）、7 场景角色包与任务 DAG（立案 4/撰写 5/答复 5/补正 2/复审 5/无效 6/诉讼 6-7）、立场纪律、创建序列、协作纪律
- 适配点：`agent_teams_*` 工具名 → Sati `team_*` 工具（标注「M3 落地，M2 起团队层可编程式使用」）；「dsh-agent-teams 插件已挂载」→「Sati 团队编排层（M2 起）」；成员上限 8 → Sati `maxConcurrentMembers` 默认 4 的说明（并发闸）；LLM 路由继承语义按 Sati 成员模型
- 角色 id 与 M2 协议 roleSlug 自由字符串一致，直接可用
- frontmatter：`type: role` 之外本文档是**技能资产**（非角色注册）——`name: patent-team-composition` + `description`（触发：复杂专利作业建队前）

- [ ] **Step 2: 验证**

Run: `pnpm build`（不动 TS）+ 人工核验 SKILL.md 格式（frontmatter + 表格渲染）
Expected: 无编译影响；markdown 结构完整

- [ ] **Step 3: Commit**

```bash
git add skills/patent-team-composition/SKILL.md
git commit -m "feat(agent): 专利团队资产移植——7 场景角色包与任务 DAG（Task 9）"
```

---

### Task 10: 角色映射表 + 缺位角色资产（注册接线留 M3）

**Files:**
- Create: `docs/team-role-mapping.md`
- Create: `skills/patent-teams/`（5 个缺位角色 SKILL.md：case-manager / formal-examiner / applicant-counsel / defendant-counsel / tech-investigator）

- [ ] **Step 1: 写映射表**（`docs/team-role-mapping.md`）

内容要求（表格完整给出，来源：本计划 Task 9 资产 + Sati 现有 `skills/` 34 角色）：
- 12 团队岗位 ↔ Sati 现有角色映射（复用列 + 差异说明）：
  - researcher → patent-retriever（复用；dsh 岗位职责含覆盖度评估，patent-retriever 若缺该能力标注差异）
  - drafter → patent-writer + provision-drafting-claims/spec（复用）
  - adversarial-reviewer → patent-reviewer + patent-quality-checker（复用）
  - technical-expert → patent-analyzer（+ patent-electrical-agent 电学领域）（复用）
  - invalidity-petitioner → patent-invalidity-checker + provision-invalidity-procedure（复用）
  - patentee-defender → patent-invalidity-checker（视角复用）+ provision-*（复用）
  - adjudicator → patent-reviewer + provision-reexamination（复用）
  - case-manager / formal-examiner / applicant-counsel / defendant-counsel / tech-investigator → **无既有对应，新增**
- 新增 5 岗的角色定义（职责/立场/工具域建议）→ 落 `skills/patent-teams/*.md`
- **明确标注**：「注册接线（registerRoleDefinition + visibleDomains 裁剪）留 M3」——本任务只做资产与映射，不注册

- [ ] **Step 2: 写 5 个缺位角色 SKILL.md**

每个文件结构（frontmatter `type: role` + name/description + 正文：立场、职责、工具域建议（建议 domains）、协作边界）：内容以 Task 9 资产的角色表为准展开（案例见 `skills/patent-agent/SKILL.md` 的既有格式）。

- [ ] **Step 3: 验证**

Run: `pnpm lint`（skills 不入 lint 范围则跳过）；人工核验 5 文件格式与映射表一致性
Expected: 无编译影响；文档互引完整

- [ ] **Step 4: Commit**

```bash
git add docs/team-role-mapping.md skills/patent-teams/
git commit -m "docs(agent): 团队岗位-角色映射表 + 5 缺位角色资产（注册接线留 M3）（Task 10）"
```

---

## 收尾验证

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`（全量回归基线：M1 为 3306 tests / 3303 pass / 0 fail / 3 skip；M2 实况 3346 tests / 3343 pass / 0 fail / 3 skip，含最终审查修复新增 1 用例）
- [ ] `node scripts/team-stress-verify.mjs`（8/8 场景）
- [ ] `pnpm check:event-matrix`（TeamEvent 已入矩阵）
- [ ] 事件矩阵 diff 仅含 team_event 相关行（纯机械）

## 留待 M3/M4

- M3：10 个 `team_*` 工具（`src/tool/builtin/team*.ts`，domain: team）+ 角色注册接线（Task 10 资产 → `registerRoleDefinition`）+ `patent-team-composition` 角色化；llm-replay fixture 在 toolSchema 稳定后重录
- M4：活动面板（`ui/src/components/team-panel/` + 手写 SVG DAG + 事件消费）
- 归档/删除（quiesce + `team_archived`）的完整流程随 M3 工具面落地
- M3：`isCaptainOnline` 接线 gateway 在线状态（当前默认常在线，代码注释已标注）；`message_delivered` 事件 payload 演进（当前批次粒度取首条 sender，完整 sender 列表随协议演进）；`blockedByCount` 随任务更新工具维护（当前依赖判定走 dependencies 数组，字段为 M3 预留）
