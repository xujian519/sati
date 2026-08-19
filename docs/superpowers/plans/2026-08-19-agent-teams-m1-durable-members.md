# 团队编排层 M1：durable 成员底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立「可唤醒的持续子代理」原语：成员 = 独立持久化会话（独立 sessionKey + 独立转录），经 `gateway.submitTurn` 整条链唤醒，冷恢复与 TaskResumeScanner 互不干扰。

**Architecture:** 新模块 `src/agent/team/`（protocol/member/storage），M1 落地三个组件：teams.db 最小存储（teams/members/retired_members 三表）、成员会话 key 与内部会话过滤（`team:` 前缀 + `isInternalSession` 扩展）、成员注册/唤醒/冷恢复扫描 + 审批转发层。成员转录**不**由成员模块写入——转录写入与上下文重建全部走 gateway 内部（`submitTurn` → resume 路径），与 `runTaskResumeScan` 的续算接线同构（`src/cli/createLocalGateway.ts:1148`）。

**Tech Stack:** TypeScript 5.9（strict/NodeNext）、node:sqlite（`DatabaseSync`，Node ≥ 22.13）、Node test runner（tests/ 镜像 src/ 结构）。

**Spec:** `docs/superpowers/specs/2026-08-19-agent-teams-design.md`（L0 节）
**范围边界：** 本计划只含 M1。M2（任务池/调度/TeamEvent）、M3（team_* 工具 + 角色）、M4（活动面板）另立计划。

**关键设计决策（M1 内已锁死，实施时不得偏离）：**
1. 成员 sessionKey 格式：`team:<teamId>:<memberId>`（纯函数 `memberSessionKey`）
2. 转录隔离 = sessionKey 前缀过滤：`listProjectSessions` 的 `isInternalSession` 识别 `team:` 前缀（`transcriptPath` 固定 chatDir 根目录，`createAgentProjectSessionStorage` 不可定制子目录——**不要**改该函数）
3. 成员唤醒 = `gateway.submitTurn({sessionKey, channelKey: "cron", message, canPrompt: false})`，drain 事件流；不直接拼 AgentLoop/TurnRunner
4. 冷恢复断点检测复用 `findOpenRequest`（`src/session/transcript/interruptedTurn.ts` 导出）+ `readTranscript`（`src/session/transcript/TranscriptReader.ts`）
5. 审批转发：成员 `approval_pending` 事件 → `emitForSession(captainSessionKey, ...)` 转发；决定回写走 `gateway.approvalDecide({sessionKey: 成员key, pendingIndex, verdict})`，转发器校验 captain 与 member 同队

## 文件结构

```
src/agent/team/
├── protocol/
│   └── member-key.ts          # memberSessionKey/parseMemberSessionKey 纯函数 + 前缀常量
├── member/
│   ├── member-registry.ts     # createTeamMember（写 db + 路由快照序列化）
│   ├── member-waker.ts        # wakeMember（submitTurn 构造 + drain + 状态流转）
│   ├── member-scanner.ts      # scanTeamMembers（冷恢复：db → 转录 → findOpenRequest → 重唤醒）
│   └── approval-forwarder.ts  # TeamApprovalForwarder（成员审批事件 → 队长 watcher + 决定回写）
├── storage/
│   └── team-db.ts             # TeamDb（node:sqlite + user_version 迁移 + 三表 CRUD）
└── index.ts                   # barrel

tests/agent/team/
├── protocol/member-key.spec.ts
├── storage/team-db.spec.ts
├── member/member-registry.spec.ts
├── member/member-waker.spec.ts
├── member/member-scanner.spec.ts
├── member/approval-forwarder.spec.ts
└── team-gateway-integration.spec.ts   # createLocalGateway 真实接线集成

修改：
- src/session/storage/SessionList.ts   # isInternalSession 加 team: 前缀（导出函数）
- src/cli/createLocalGateway.ts        # runTeamMemberScan 接线 + dispose 关 db
- tests/session/storage/session-list.spec.ts（若不存在则新建同路径）
```

## 现有接口速查（实施时直接引用，勿重复探索）

| 需要 | 来源 |
|---|---|
| `GatewaySubmitTurnInput` | `src/gateway/protocol/types.ts:114`（sessionKey/channelKey/message/projectKey?/workspaceCwd?/canPrompt?/syntheticMessages?…） |
| `Gateway` 接口（submitTurn/approvalDecide） | `src/gateway/protocol/types.ts:519` |
| `InProcessGateway.emitForSession(sessionKey, event): boolean` | `src/gateway/client/InProcessGateway.ts:282` |
| `approvalDecide(input: {sessionKey, pendingIndex, verdict: "adopted"\|"rejected", feedback?})` | `src/gateway/client/InProcessGateway.ts:755` |
| `approval_pending` 事件结构 | `src/gateway/protocol/types.ts:217`（sessionKey/pendingIndex/textPreview/triggerKeyword/sessionId?/turnId?/createdAt） |
| `readTranscript(path, options?): Promise<AgentTranscriptReadResult>` | `src/session/transcript/TranscriptReader.ts:39`（返回 `{entries}`） |
| `findOpenRequest(entries)`（form "a"/"b" 判定） | `src/session/transcript/interruptedTurn.ts`（TaskResumeScanner.ts 的 import 确认） |
| `sanitizeSessionIdForPath` | `src/session/storage/ProjectSessionStorage.ts` |
| `getPilotProjectChatDir(projectRoot, pilotHome)` | `src/pilot/paths.ts:37` |
| 续算接线先例（fire-and-forget + drain） | `src/cli/createLocalGateway.ts:1148` `runTaskResumeScan` |
| 内部会话过滤先例 | `src/session/storage/SessionList.ts:9,39`（`ALWAYS_ON_AUXILIARY_PATTERN` + `isInternalSession`） |
| 断点 fixture 构造先例 | `tests/session/resume/task-resume-scanner.spec.ts`（baseEntry/acceptedInput/requestHeader/writeTranscript） |
| 事件矩阵门禁 | `pnpm check:event-matrix`（M1 不新增 AgentEvent/GatewayEvent，无需更新矩阵） |

---

### Task 1: teams.db 存储层（TeamDb + 迁移 + 三表 CRUD）

**Files:**
- Create: `src/agent/team/storage/team-db.ts`
- Create: `src/agent/team/index.ts`（本任务先只导出 TeamDb）
- Test: `tests/agent/team/storage/team-db.spec.ts`

- [ ] **Step 1: 写失败测试**

`tests/agent/team/storage/team-db.spec.ts`：

```typescript
/**
 * TeamDb：teams/members/retired_members 三表 CRUD + user_version 迁移。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TeamDb } from "../../../../src/agent/team/index.js";

function openDb(): TeamDb {
  return new TeamDb(":memory:");
}

test("迁移：首次打开建三表，user_version 升到 1", () => {
  const db = openDb();
  try {
    assert.equal(db.userVersion(), 1);
    assert.deepEqual(db.listMembers(), []);
  } finally {
    db.close();
  }
});

test("teams：upsert 与读取往返", () => {
  const db = openDb();
  try {
    db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    assert.deepEqual(db.getTeam("t1"), {
      id: "t1",
      name: "专利团队",
      captainSessionKey: "cap-1",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    // upsert 幂等：同名覆盖
    db.upsertTeam({ id: "t1", name: "改名", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    assert.equal(db.getTeam("t1")?.name, "改名");
    assert.equal(db.getTeam("missing"), undefined);
  } finally {
    db.close();
  }
});

test("members：插入/状态更新/查询往返", () => {
  const db = openDb();
  try {
    db.insertMember({
      id: "m1",
      teamId: "t1",
      roleSlug: "patent-searcher",
      modelRouteJson: JSON.stringify({ provider: "deepseek", model: "deepseek-v4-flash" }),
      status: "idle",
      sessionKey: "team:t1:m1",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const member = db.getMember("m1");
    assert.equal(member?.status, "idle");
    assert.equal(member?.sessionKey, "team:t1:m1");
    db.updateMemberStatus("m1", "working");
    assert.equal(db.getMember("m1")?.status, "working");
    assert.equal(db.listMembers().length, 1);
  } finally {
    db.close();
  }
});

test("retired_members：登记与查询", () => {
  const db = openDb();
  try {
    assert.equal(db.isRetired("team:t1:m1"), false);
    db.insertRetired("team:t1:m1", "m1", "removed");
    assert.equal(db.isRetired("team:t1:m1"), true);
    // 幂等：重复登记不抛错
    db.insertRetired("team:t1:m1", "m1", "removed");
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/storage/team-db.spec.js`
Expected: FAIL——`Cannot find module '../../../../src/agent/team/index.js'`（文件不存在）

- [ ] **Step 3: 实现 TeamDb**

`src/agent/team/storage/team-db.ts`：

```typescript
/**
 * 团队状态库（teams.db）最小实现：node:sqlite DatabaseSync + user_version 迁移。
 * M1 仅三表（teams/members/retired_members）；tasks/messages 表随 M2 以 v2 迁移加入。
 * 语义与 knowledge.db 不同：knowledge.db 只读消费，本库是团队状态的读写真源。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TeamRow = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
};

export type TeamMemberRow = {
  id: string;
  teamId: string;
  roleSlug: string;
  modelRouteJson: string;
  status: "idle" | "working";
  sessionKey: string;
  createdAt: string;
};

type TeamDbRow = { id: string; name: string; captain_session_key: string; created_at: string };
type MemberDbRow = {
  id: string;
  team_id: string;
  role_slug: string;
  model_route_json: string;
  status: string;
  session_key: string;
  created_at: string;
};

const MIGRATIONS: string[] = [
  // v1：成员底座最小集（M2 以 v2 追加 tasks/messages）
  `CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    captain_session_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    role_slug TEXT NOT NULL,
    model_route_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('idle','working')),
    session_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS retired_members (
    session_key TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    retired_at TEXT NOT NULL
  );`,
];

function toTeamRow(row: TeamDbRow): TeamRow {
  return {
    id: row.id,
    name: row.name,
    captainSessionKey: row.captain_session_key,
    createdAt: row.created_at,
  };
}

function toMemberRow(row: MemberDbRow): TeamMemberRow {
  return {
    id: row.id,
    teamId: row.team_id,
    roleSlug: row.role_slug,
    modelRouteJson: row.model_route_json,
    status: row.status === "working" ? "working" : "idle",
    sessionKey: row.session_key,
    createdAt: row.created_at,
  };
}

export class TeamDb {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    // :memory: 的 dirname 是 "."，mkdirSync 无害；真实路径确保 ~/.sati/teams 存在。
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  userVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  upsertTeam(team: TeamRow): void {
    this.db
      .prepare(
        `INSERT INTO teams (id, name, captain_session_key, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, captain_session_key = excluded.captain_session_key`,
      )
      .run(team.id, team.name, team.captainSessionKey, team.createdAt);
  }

  getTeam(id: string): TeamRow | undefined {
    const row = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as TeamDbRow | undefined;
    return row ? toTeamRow(row) : undefined;
  }

  insertMember(row: TeamMemberRow): void {
    this.db
      .prepare(
        `INSERT INTO members (id, team_id, role_slug, model_route_json, status, session_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.teamId, row.roleSlug, row.modelRouteJson, row.status, row.sessionKey, row.createdAt);
  }

  updateMemberStatus(id: string, status: "idle" | "working"): void {
    this.db.prepare("UPDATE members SET status = ? WHERE id = ?").run(status, id);
  }

  getMember(id: string): TeamMemberRow | undefined {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id) as MemberDbRow | undefined;
    return row ? toMemberRow(row) : undefined;
  }

  listMembers(): TeamMemberRow[] {
    const rows = this.db.prepare("SELECT * FROM members ORDER BY created_at ASC").all() as MemberDbRow[];
    return rows.map(toMemberRow);
  }

  insertRetired(sessionKey: string, memberId: string, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO retired_members (session_key, member_id, reason, retired_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET reason = excluded.reason, retired_at = excluded.retired_at`,
      )
      .run(sessionKey, memberId, reason, new Date().toISOString());
  }

  isRetired(sessionKey: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM retired_members WHERE session_key = ?").get(sessionKey);
    return row !== undefined;
  }

  close(): void {
    this.db.close();
  }
}
```

`src/agent/team/index.ts`：

```typescript
export { TeamDb, type TeamRow, type TeamMemberRow } from "./storage/team-db.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tests/agent/team/storage/team-db.spec.js`
Expected: PASS（4 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/agent/team/storage/team-db.ts src/agent/team/index.ts tests/agent/team/storage/team-db.spec.ts
git commit -m "feat(agent): team 域 teams.db 最小存储层（TeamDb + user_version 迁移）"
```

---

### Task 2: 成员会话 key 纯函数 + 内部会话过滤

**Files:**
- Create: `src/agent/team/protocol/member-key.ts`
- Create: `tests/agent/team/protocol/member-key.spec.ts`
- Modify: `src/session/storage/SessionList.ts:39-41`（isInternalSession + 导出）
- Test: `tests/session/storage/session-list-internal.spec.ts`

- [ ] **Step 1: 写失败测试**

`tests/agent/team/protocol/member-key.spec.ts`：

```typescript
/**
 * 成员会话 key：构造/解析纯函数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { MEMBER_SESSION_PREFIX, memberSessionKey, parseMemberSessionKey } from "../../../../src/agent/team/protocol/member-key.js";

test("构造：team:<teamId>:<memberId> 格式", () => {
  assert.equal(memberSessionKey("t1", "m1"), "team:t1:m1");
  assert.equal(memberSessionKey("专利组", "检索员"), "team:专利组:检索员");
});

test("解析：合法 key 往返", () => {
  assert.deepEqual(parseMemberSessionKey("team:t1:m1"), { teamId: "t1", memberId: "m1" });
  // memberId 本身含冒号时按第一个冒号切分（teamId 不得含冒号——注册侧保证）
  assert.deepEqual(parseMemberSessionKey("team:a:b:m1"), { teamId: "a", memberId: "b:m1" });
});

test("解析：非成员 key 返回 null", () => {
  assert.equal(parseMemberSessionKey("web:abc"), null);
  assert.equal(parseMemberSessionKey("always-on-discovery:x"), null);
  assert.equal(parseMemberSessionKey(""), null);
  assert.equal(parseMemberSessionKey("team:"), null);
  assert.equal(parseMemberSessionKey("team:m1"), null); // 缺 teamId 分隔符
});

test("前缀常量：非空且被解析器依赖", () => {
  assert.ok(MEMBER_SESSION_PREFIX.length > 0);
  assert.ok(parseMemberSessionKey(`${MEMBER_SESSION_PREFIX}x:y`) !== null);
});
```

`tests/session/storage/session-list-internal.spec.ts`：

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/protocol/member-key.spec.js dist/tests/session/storage/session-list-internal.spec.js`
Expected: FAIL——member-key 模块不存在；isInternalSession 未导出（`SyntaxError: The requested module ... does not provide an export named 'isInternalSession'`）

- [ ] **Step 3: 实现 key 纯函数 + 过滤扩展**

`src/agent/team/protocol/member-key.ts`：

```typescript
/**
 * 成员会话 key 契约：`team:<teamId>:<memberId>`。
 *
 * 该前缀同时是转录隔离机制：session/storage 的 isInternalSession 识别
 * `team:` 前缀，把成员会话从 listProjectSessions / TaskResumeScanner 扫描中
 * 排除（成员冷恢复由 team 模块独家负责）。改前缀必须同步 SessionList.ts。
 */
export const MEMBER_SESSION_PREFIX = "team:";

export function memberSessionKey(teamId: string, memberId: string): string {
  return `${MEMBER_SESSION_PREFIX}${teamId}:${memberId}`;
}

export function parseMemberSessionKey(
  sessionKey: string,
): { teamId: string; memberId: string } | null {
  if (!sessionKey.startsWith(MEMBER_SESSION_PREFIX)) {
    return null;
  }
  const rest = sessionKey.slice(MEMBER_SESSION_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) {
    return null;
  }
  return { teamId: rest.slice(0, sep), memberId: rest.slice(sep + 1) };
}
```

`src/session/storage/SessionList.ts` 修改（第 9 行 `ALWAYS_ON_AUXILIARY_PATTERN` 之后加常量，第 39-41 行改函数并导出）：

```typescript
const ALWAYS_ON_AUXILIARY_PATTERN = /^always-on-(discovery|workspace|report)[:\-]/;
/** 团队成员会话前缀（与 src/agent/team/protocol/member-key.ts 的 MEMBER_SESSION_PREFIX 保持同步）。 */
const TEAM_MEMBER_SESSION_PREFIX = "team:";
```

```typescript
export function isInternalSession(sessionId: string): boolean {
  return ALWAYS_ON_AUXILIARY_PATTERN.test(sessionId) || sessionId.startsWith(TEAM_MEMBER_SESSION_PREFIX);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tests/agent/team/protocol/member-key.spec.js dist/tests/session/storage/session-list-internal.spec.js`
Expected: PASS（6 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/agent/team/protocol/member-key.ts tests/agent/team/protocol/member-key.spec.ts src/session/storage/SessionList.ts tests/session/storage/session-list-internal.spec.ts
git commit -m "feat(agent): 成员会话 key 契约（team: 前缀）与内部会话过滤扩展"
```

---

### Task 3: 成员创建（createTeamMember）

**Files:**
- Create: `src/agent/team/member/member-registry.ts`
- Create: `tests/agent/team/member/member-registry.spec.ts`
- Modify: `src/agent/team/index.ts`（导出 member-registry 与 member-key）

- [ ] **Step 1: 写失败测试**

`tests/agent/team/member/member-registry.spec.ts`：

```typescript
/**
 * createTeamMember：成员记录落库 + sessionKey 派生 + 路由快照序列化。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { TeamDb, createTeamMember } from "../../../../src/agent/team/index.js";

function setupDb(): TeamDb {
  const db = new TeamDb(":memory:");
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
  return db;
}

test("创建：写库并返回完整行", () => {
  const db = setupDb();
  try {
    const row = createTeamMember(db, {
      teamId: "t1",
      memberId: "m1",
      roleSlug: "patent-searcher",
      modelRoute: { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "low" },
      now: () => new Date("2026-08-19T08:00:00.000Z"),
    });
    assert.equal(row.sessionKey, "team:t1:m1");
    assert.equal(row.status, "idle");
    assert.deepEqual(JSON.parse(row.modelRouteJson), {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
    });
    assert.equal(db.getMember("m1")?.roleSlug, "patent-searcher");
  } finally {
    db.close();
  }
});

test("创建：同一 team 不同成员 sessionKey 不冲突", () => {
  const db = setupDb();
  try {
    createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    createTeamMember(db, { teamId: "t1", memberId: "m2", roleSlug: "y", modelRoute: { provider: "p", model: "m" } });
    assert.equal(db.listMembers().length, 2);
    assert.equal(db.getMember("m2")?.sessionKey, "team:t1:m2");
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-registry.spec.js`
Expected: FAIL——`createTeamMember` 未导出

- [ ] **Step 3: 实现**

`src/agent/team/member/member-registry.ts`：

```typescript
/**
 * 成员注册：把成员行写入 teams.db。
 * LLM 路由快照由调用方解析后传入（M3 工具面接 resolveModelInfo），
 * M1 只负责序列化持久化与 sessionKey 派生。
 */
import type { TeamDb, TeamMemberRow } from "../storage/team-db.js";
import { memberSessionKey } from "../protocol/member-key.js";

export type MemberModelRoute = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

export type CreateTeamMemberOptions = {
  teamId: string;
  memberId: string;
  roleSlug: string;
  modelRoute: MemberModelRoute;
  now?: () => Date;
};

export function createTeamMember(db: TeamDb, options: CreateTeamMemberOptions): TeamMemberRow {
  const now = options.now ?? (() => new Date());
  const row: TeamMemberRow = {
    id: options.memberId,
    teamId: options.teamId,
    roleSlug: options.roleSlug,
    modelRouteJson: JSON.stringify(options.modelRoute),
    status: "idle",
    sessionKey: memberSessionKey(options.teamId, options.memberId),
    createdAt: now().toISOString(),
  };
  db.insertMember(row);
  return row;
}
```

`src/agent/team/index.ts` 追加：

```typescript
export { MEMBER_SESSION_PREFIX, memberSessionKey, parseMemberSessionKey } from "./protocol/member-key.js";
export { createTeamMember, type MemberModelRoute, type CreateTeamMemberOptions } from "./member/member-registry.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-registry.spec.js`
Expected: PASS（2 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/agent/team/member/member-registry.ts src/agent/team/index.ts tests/agent/team/member/member-registry.spec.ts
git commit -m "feat(agent): createTeamMember 成员注册（路由快照落库 + sessionKey 派生）"
```

---

### Task 4: 成员唤醒（wakeMember → gateway.submitTurn）

**Files:**
- Create: `src/agent/team/member/member-waker.ts`
- Create: `tests/agent/team/member/member-waker.spec.ts`
- Modify: `src/agent/team/index.ts`（导出 member-waker）

- [ ] **Step 1: 写失败测试**

`tests/agent/team/member/member-waker.spec.ts`：

```typescript
/**
 * wakeMember：构造 GatewaySubmitTurnInput 提交成员会话，drain 事件流，状态流转 idle→working→idle。
 */
import assert from "node:assert/strict";
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
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "patent-searcher", modelRoute: { provider: "deepseek", model: "deepseek-v4-flash" } });
  const recorded = { inputs: [] as GatewaySubmitTurnInput[] };
  return { db, recorded, gateway: makeFakeGateway(recorded) };
}

test("唤醒：以成员 sessionKey + channelKey cron + canPrompt false 提交", async () => {
  const { db, recorded, gateway } = setup();
  try {
    await wakeMember(db, gateway, "m1", "请继续检索任务 T-1");
    assert.equal(recorded.inputs.length, 1);
    assert.deepEqual(recorded.inputs[0], {
      sessionKey: "team:t1:m1",
      channelKey: "cron",
      message: "请继续检索任务 T-1",
      canPrompt: false,
    });
  } finally {
    db.close();
  }
});

test("唤醒：状态流转 working → 完成后回 idle", async () => {
  const { db, gateway } = setup();
  try {
    let seenWorking = false;
    const instrumented: FakeGateway = {
      async *submitTurn(input) {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-waker.spec.js`
Expected: FAIL——`wakeMember` 未导出

- [ ] **Step 3: 实现**

`src/agent/team/member/member-waker.ts`：

```typescript
/**
 * 成员唤醒：followup = 构造成员 sessionKey 的 gateway.submitTurn。
 *
 * 不直接拼 AgentLoop/TurnRunner——走 submitTurn 整条链保住 TurnRunner 内的
 * PatentOutputGate（审批门禁）、事件广播与 usage 记账。转录写入与上下文重建
 * 由 gateway 内部 resume 路径完成（与 runTaskResumeScan 的续算接线同构）。
 */
import type { GatewayEvent, GatewaySubmitTurnInput } from "../../../gateway/protocol/types.js";
import type { TeamDb } from "../storage/team-db.js";

export type MemberGateway = Pick<import("../../../gateway/protocol/types.js").Gateway, "submitTurn">;

export class TeamMemberNotFoundError extends Error {
  constructor(memberId: string) {
    super(`Team member not found: ${memberId}`);
    this.name = "TeamMemberNotFoundError";
  }
}

export class TeamMemberRetiredError extends Error {
  constructor(memberId: string) {
    super(`Team member is retired: ${memberId}`);
    this.name = "TeamMemberRetiredError";
  }
}

export type WakeMemberOptions = {
  syntheticMessages?: Array<{ text: string; purpose?: string }>;
  /** 每事件回调（审批转发层接线点，Task 6）。 */
  onEvent?: (event: GatewayEvent) => void;
};

export async function wakeMember(
  db: TeamDb,
  gateway: MemberGateway,
  memberId: string,
  followupMessage: string,
  options: WakeMemberOptions = {},
): Promise<void> {
  const member = db.getMember(memberId);
  if (!member) {
    throw new TeamMemberNotFoundError(memberId);
  }
  if (db.isRetired(member.sessionKey)) {
    throw new TeamMemberRetiredError(memberId);
  }
  db.updateMemberStatus(memberId, "working");
  try {
    const input: GatewaySubmitTurnInput = {
      sessionKey: member.sessionKey,
      channelKey: "cron",
      message: followupMessage,
      canPrompt: false,
      ...(options.syntheticMessages ? { syntheticMessages: options.syntheticMessages } : {}),
    };
    for await (const event of gateway.submitTurn(input)) {
      options.onEvent?.(event);
    }
  } finally {
    db.updateMemberStatus(memberId, "idle");
  }
}
```

`src/agent/team/index.ts` 追加：

```typescript
export {
  wakeMember,
  TeamMemberNotFoundError,
  TeamMemberRetiredError,
  type MemberGateway,
  type WakeMemberOptions,
} from "./member/member-waker.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-waker.spec.js`
Expected: PASS（5 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/agent/team/member/member-waker.ts src/agent/team/index.ts tests/agent/team/member/member-waker.spec.ts
git commit -m "feat(agent): wakeMember 成员唤醒（submitTurn 整条链 + 状态流转 + 退休拒绝）"
```

---

### Task 5: 冷恢复扫描（scanTeamMembers）

**Files:**
- Create: `src/agent/team/member/member-scanner.ts`
- Create: `tests/agent/team/member/member-scanner.spec.ts`
- Modify: `src/agent/team/index.ts`（导出 scanner）

- [ ] **Step 1: 写失败测试**

`tests/agent/team/member/member-scanner.spec.ts`：

```typescript
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
import { TeamDb, createTeamMember, scanTeamMembers } from "../../../../src/agent/team/index.js";

type JsonEntry = Record<string, unknown>;

function baseEntry(sessionId: string, turnId: string, sequence: number, type: string, extra: JsonEntry = {}): JsonEntry {
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

async function writeMemberTranscript(
  root: string,
  sessionKey: string,
  lines: JsonEntry[],
): Promise<void> {
  const chatDir = getPilotProjectChatDir(root, root);
  await mkdir(chatDir, { recursive: true });
  await writeFile(join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function makeGateway(recorded: { messages: string[] }): { submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> } {
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
    createTeamMember(db, { teamId: "t1", memberId: "m-broken", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    createTeamMember(db, { teamId: "t1", memberId: "m-healthy", roleSlug: "y", modelRoute: { provider: "p", model: "m" } });
    // 断点形态：request_header 已落、响应未到
    await writeMemberTranscript(root, "team:t1:m-broken", [
      acceptedInput("team:t1:m-broken", "t1", 1, "开始检索"),
      requestHeader("team:t1:m-broken", "t1", 2),
    ]);
    // 健康形态：accepted_input 后无 request_header（回合已正常结束）
    await writeMemberTranscript(root, "team:t1:m-healthy", [
      acceptedInput("team:t1:m-healthy", "t1", 1, "检索完成"),
    ]);

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
    createTeamMember(db, { teamId: "t1", memberId: "m-fresh", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    const result = await scanTeamMembers({
      db,
      gateway: makeGateway(recorded),
      projectRoot: root,
      pilotHome: root,
    });
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 0);
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
    createTeamMember(db, { teamId: "t1", memberId: "m-gone", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
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
    createTeamMember(db, { teamId: "t1", memberId: "m-wait", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
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
    assert.equal(result.resumed, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-scanner.spec.js`
Expected: FAIL——`scanTeamMembers` 未导出

- [ ] **Step 3: 实现**

`src/agent/team/member/member-scanner.ts`：

```typescript
/**
 * 成员冷恢复：gateway 启动时扫描 members 表，对 (a) 形态断点成员重唤醒。
 *
 * 与 TaskResumeScanner 的分工：主会话扫描走 TaskResumeScanner（listProjectSessions
 * 已把 team: 前缀成员排除在 includeInternal:false 之外），成员的冷恢复由本模块
 * 独家负责——两个冷恢复机制互不打架。
 */
import { join } from "node:path";
import { getPilotProjectChatDir } from "../../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../../session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../../session/transcript/TranscriptReader.js";
import { findOpenRequest } from "../../../session/transcript/interruptedTurn.js";
import type { TeamDb } from "../storage/team-db.js";
import { wakeMember, type MemberGateway } from "./member-waker.js";

export const TEAM_MEMBER_RESUME_MARKER = "[team-resume]";

export const TEAM_MEMBER_RESUME_MESSAGE =
  `${TEAM_MEMBER_RESUME_MARKER} 你上一次运行因进程中断而停止。请先检查当前已完成的进度（不要重复执行已经完成的工作），然后继续完成未完成的工作。`;

export type ScanTeamMembersOptions = {
  db: TeamDb;
  gateway: MemberGateway;
  projectRoot: string;
  pilotHome: string;
  resumeMessage?: string;
  /** 成员会话是否有挂起审批（输出门禁态在 gateway 内存，崩溃即失，须跳过）。 */
  hasPendingApprovals?: (sessionKey: string) => boolean;
};

export type ScanTeamMembersResult = {
  scanned: number;
  resumed: number;
};

export async function scanTeamMembers(options: ScanTeamMembersOptions): Promise<ScanTeamMembersResult> {
  const members = options.db.listMembers();
  let resumed = 0;
  for (const member of members) {
    if (options.db.isRetired(member.sessionKey)) {
      continue;
    }
    try {
      const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
      const path = join(chatDir, `${sanitizeSessionIdForPath(member.sessionKey)}.jsonl`);
      const { entries } = await readTranscript(path);
      const open = findOpenRequest(entries);
      if (open === undefined) {
        continue;
      }
      if (open.form !== "a") {
        continue;
      }
      if (options.hasPendingApprovals?.(member.sessionKey)) {
        continue;
      }
      await wakeMember(
        options.db,
        options.gateway,
        member.id,
        options.resumeMessage ?? TEAM_MEMBER_RESUME_MESSAGE,
      );
      resumed += 1;
    } catch {
      // 单个成员失败（转录缺失/损坏）不阻塞其余成员；无转录 = 从未唤醒，跳过。
      continue;
    }
  }
  return { scanned: members.length, resumed };
}
```

`src/agent/team/index.ts` 追加：

```typescript
export {
  scanTeamMembers,
  TEAM_MEMBER_RESUME_MARKER,
  TEAM_MEMBER_RESUME_MESSAGE,
  type ScanTeamMembersOptions,
  type ScanTeamMembersResult,
} from "./member/member-scanner.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tests/agent/team/member/member-scanner.spec.js`
Expected: PASS（4 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/agent/team/member/member-scanner.ts src/agent/team/index.ts tests/agent/team/member/member-scanner.spec.ts
git commit -m "feat(agent): scanTeamMembers 成员冷恢复（findOpenRequest 断点重唤醒 + 退休/审批跳过）"
```

---

### Task 6: 审批转发层（TeamApprovalForwarder）

**Files:**
- Create: `src/agent/team/member/approval-forwarder.ts`
- Create: `tests/agent/team/member/approval-forwarder.spec.ts`
- Modify: `src/agent/team/index.ts`（导出转发器）

- [ ] **Step 1: 写失败测试**

`tests/agent/team/member/approval-forwarder.spec.ts`：

```typescript
/**
 * TeamApprovalForwarder：成员 approval_pending → 队长会话 watcher 转发；决定回写成员 sessionKey。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayEvent } from "../../../../src/gateway/protocol/types.js";
import {
  TeamApprovalForwarder,
  TeamDb,
  createTeamMember,
} from "../../../../src/agent/team/index.js";

function setup(): { db: TeamDb; forwarder: TeamApprovalForwarder; emitted: Array<{ sessionKey: string; event: GatewayEvent }>; decided: Array<{ sessionKey: string; pendingIndex: number; verdict: string }> } {
  const db = new TeamDb(":memory:");
  db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
  createTeamMember(db, { teamId: "t1", memberId: "m1", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
  const emitted: Array<{ sessionKey: string; event: GatewayEvent }> = [];
  const decided: Array<{ sessionKey: string; pendingIndex: number; verdict: string }> = [];
  const forwarder = new TeamApprovalForwarder({
    db,
    emitForSession: (sessionKey, event) => {
      emitted.push({ sessionKey, event });
      return true;
    },
    approvalDecide: async input => {
      decided.push({ sessionKey: input.sessionKey, pendingIndex: input.pendingIndex, verdict: input.verdict });
      return { delivered: true };
    },
  });
  return { db, forwarder, emitted, decided };
}

const pendingEvent = (memberSessionKey: string): GatewayEvent => ({
  type: "approval_pending",
  sessionKey: memberSessionKey,
  pendingIndex: 1,
  textPreview: "结论待审批",
  triggerKeyword: "可专利性",
  sessionId: memberSessionKey,
  createdAt: 1756000000000,
});

test("转发：成员 approval_pending 转发到队长会话 watcher（标注成员来源）", () => {
  const { db, forwarder, emitted } = setup();
  try {
    const member = db.getMember("m1")!;
    forwarder.handleMemberEvent(member, pendingEvent("team:t1:m1"));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.sessionKey, "cap-1");
    const event = emitted[0]?.event as Extract<GatewayEvent, { type: "approval_pending" }>;
    assert.equal(event.sessionKey, "cap-1");
    assert.equal(event.sessionId, "team:t1:m1"); // 保留成员来源
    assert.equal(event.pendingIndex, 1);
  } finally {
    db.close();
  }
});

test("转发：非 approval 事件忽略", () => {
  const { db, forwarder, emitted } = setup();
  try {
    const member = db.getMember("m1")!;
    forwarder.handleMemberEvent(member, { type: "turn_completed", usage: {}, finishReason: "completed" });
    assert.equal(emitted.length, 0);
  } finally {
    db.close();
  }
});

test("转发：无团队的成员事件忽略（不抛错）", () => {
  const { db, forwarder, emitted } = setup();
  try {
    // 造一个 teamId 不存在的成员行（直接插库绕过 createTeamMember 的 team 存在性）
    db.insertMember({
      id: "m-orphan",
      teamId: "missing-team",
      roleSlug: "x",
      modelRouteJson: "{}",
      status: "idle",
      sessionKey: "team:missing-team:m-orphan",
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const orphan = db.getMember("m-orphan")!;
    forwarder.handleMemberEvent(orphan, pendingEvent("team:missing-team:m-orphan"));
    assert.equal(emitted.length, 0);
  } finally {
    db.close();
  }
});

test("决定回写：队长决定回写成员 sessionKey", async () => {
  const { db, forwarder, decided } = setup();
  try {
    const result = await forwarder.decide("cap-1", "team:t1:m1", 1, "adopted");
    assert.equal(result.delivered, true);
    assert.deepEqual(decided, [{ sessionKey: "team:t1:m1", pendingIndex: 1, verdict: "adopted" }]);
  } finally {
    db.close();
  }
});

test("决定回写：队长与成员不同队时拒绝（安全校验）", async () => {
  const { db, forwarder, decided } = setup();
  try {
    db.upsertTeam({ id: "t2", name: "另一队", captainSessionKey: "cap-2", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(db, { teamId: "t2", memberId: "m2", roleSlug: "x", modelRoute: { provider: "p", model: "m" } });
    const result = await forwarder.decide("cap-1", "team:t2:m2", 1, "adopted");
    assert.equal(result.delivered, false);
    assert.equal(decided.length, 0);
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/member/approval-forwarder.spec.js`
Expected: FAIL——`TeamApprovalForwarder` 未导出

- [ ] **Step 3: 实现**

`src/agent/team/member/approval-forwarder.ts`：

```typescript
/**
 * 审批冒泡转发层：GatewayApprovalBus 按 sessionKey 分桶，成员挂起的审批不会
 * 自动出现在队长 UI。本层把成员会话的 approval_pending 转发到队长会话 watcher
 * （审批卡片标注成员来源），队长的决定经 approvalDecide 回写成员 sessionKey。
 */
import type { GatewayEvent } from "../../../gateway/protocol/types.js";
import type { TeamDb, TeamMemberRow } from "../storage/team-db.js";

export type TeamApprovalForwarderOptions = {
  db: TeamDb;
  /** 生产接线到 InProcessGateway.emitForSession（src/gateway/client/InProcessGateway.ts:282）。 */
  emitForSession: (sessionKey: string, event: GatewayEvent) => boolean;
  /** 生产接线到 gateway.approvalDecide（src/gateway/client/InProcessGateway.ts:755）。 */
  approvalDecide: (input: {
    sessionKey: string;
    pendingIndex: number;
    verdict: "adopted" | "rejected";
    feedback?: string;
  }) => Promise<{ delivered: boolean }>;
};

export class TeamApprovalForwarder {
  constructor(private readonly options: TeamApprovalForwarderOptions) {}

  /** 成员回合事件入口：由 wakeMember 的 onEvent 回调接线（Task 4）。 */
  handleMemberEvent(member: TeamMemberRow, event: GatewayEvent): void {
    if (event.type !== "approval_pending") {
      return;
    }
    const team = this.options.db.getTeam(member.teamId);
    if (!team) {
      return;
    }
    // 队长 UI 以 sessionKey 匹配自己的 watcher；成员来源保留在 sessionId。
    this.options.emitForSession(team.captainSessionKey, {
      ...event,
      sessionKey: team.captainSessionKey,
      sessionId: member.sessionKey,
    });
  }

  /** 队长审批决定回写成员会话（校验 captain 与 member 同队）。 */
  async decide(
    captainSessionKey: string,
    memberSessionKey: string,
    pendingIndex: number,
    verdict: "adopted" | "rejected",
    feedback?: string,
  ): Promise<{ delivered: boolean }> {
    const member = this.findMemberBySessionKey(memberSessionKey);
    if (!member) {
      return { delivered: false };
    }
    const team = this.options.db.getTeam(member.teamId);
    if (!team || team.captainSessionKey !== captainSessionKey) {
      return { delivered: false };
    }
    return this.options.approvalDecide({ sessionKey: memberSessionKey, pendingIndex, verdict, feedback });
  }

  private findMemberBySessionKey(sessionKey: string): TeamMemberRow | undefined {
    return this.options.db.listMembers().find(member => member.sessionKey === sessionKey);
  }
}
```

`src/agent/team/index.ts` 追加：

```typescript
export { TeamApprovalForwarder, type TeamApprovalForwarderOptions } from "./member/approval-forwarder.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tests/agent/team/member/approval-forwarder.spec.js`
Expected: PASS（5 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/agent/team/member/approval-forwarder.ts src/agent/team/index.ts tests/agent/team/member/approval-forwarder.spec.ts
git commit -m "feat(agent): TeamApprovalForwarder 审批冒泡（成员 pending → 队长 watcher + 同队校验回写）"
```

---

### Task 7: createLocalGateway 接线 + 集成验证

**Files:**
- Modify: `src/cli/createLocalGateway.ts`（runTeamMemberScan 接线 + teams.db 生命周期 + wakeMember 的 onEvent 接转发器）
- Create: `tests/agent/team/team-gateway-integration.spec.ts`
- Modify: `src/agent/team/index.ts`（导出 teams.db 默认路径常量）

- [ ] **Step 1: 写失败集成测试**

`tests/agent/team/team-gateway-integration.spec.ts`：

```typescript
/**
 * 集成：createLocalGateway 真实接线——成员创建 → 唤醒（fake model 驱动）→ 转录落盘 → 冷恢复扫描。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../../src/cli/createLocalGateway.js";
import { createTeamMember, scanTeamMembers, wakeMember } from "../../../src/agent/team/index.js";
import type { ModelRuntime } from "../../../src/model/protocol.js";

test("集成：成员唤醒经 submitTurn 整条链产出转录，冷恢复可续", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-team-integration-"));
  const result = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    __testModelFactory: (): ModelRuntime => ({
      provider: "fake",
      model: "fake-model",
      // 一次工具调用也不做的单轮模型：直接产出文本后结束
      stream: async function* () {
        yield { type: "text_delta", text: "已完成检索。" };
      },
    }),
  });
  try {
    result.gateway;
    // 接线：createLocalGateway 结果新增 team 子系统句柄（本任务加入）
    const team = result.teamSubsystem;
    assert.ok(team, "teamSubsystem 未接线");
    team.db.upsertTeam({ id: "t1", name: "专利团队", captainSessionKey: "cap-1", createdAt: "2026-08-19T00:00:00.000Z" });
    createTeamMember(team.db, { teamId: "t1", memberId: "m1", roleSlug: "patent-searcher", modelRoute: { provider: "fake", model: "fake-model" } });

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

    // 健康成员不会被冷恢复误扫
    const scan = await scanTeamMembers({ db: team.db, gateway: result.gateway, projectRoot: root, pilotHome: root });
    assert.equal(scan.resumed, 0);
  } finally {
    result.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && node --test dist/tests/agent/team/team-gateway-integration.spec.js`
Expected: FAIL——`result.teamSubsystem` 不存在（CreateLocalGatewayResult 无此字段）

- [ ] **Step 3: 接线 createLocalGateway**

`src/agent/team/index.ts` 追加：

```typescript
import { join } from "node:path";

/** teams.db 默认路径（pilotHome 下）；`SATI_TEAMS_DB` 环境变量可覆盖（测试/治理用）。 */
export function defaultTeamDbPath(pilotHome: string, env: Record<string, string | undefined> = process.env): string {
  return env.SATI_TEAMS_DB ?? join(pilotHome, "teams", "teams.db");
}
```

`src/cli/createLocalGateway.ts` 修改（三处）：

1. 类型扩展（`CreateLocalGatewayResult` 定义处，约第 185 行）：

```typescript
export type CreateLocalGatewayResult = {
  gateway: Gateway;
  configStore: PilotConfigStore;
  registry: ProjectRuntimeRegistry;
  dispose: () => void;
  bindServer: (server: { broadcastNotification(name: string, payload?: unknown): void }) => void;
  isProjectBusy: (projectKey: string) => boolean;
  updateSubsystems: (update: SubsystemUpdate) => void;
  /** 团队子系统句柄（M1）：teams.db + 冷恢复扫描。M2 起扩展调度器/任务池入口。 */
  teamSubsystem: TeamSubsystemHandle;
};

export type TeamSubsystemHandle = {
  db: TeamDb;
  /** 启动时 fire-and-forget 冷恢复扫描。 */
  runMemberScan: () => void;
};
```

2. 函数体接线（`createLocalGateway` 内，`runTaskResumeScan` 定义附近，约第 1181 行之后）：

```typescript
  // ── 团队子系统（M1）：durable 成员底座 ──
  const teamDb = new TeamDb(defaultTeamDbPath(pilotHome, env));
  const teamForwarder = new TeamApprovalForwarder({
    db: teamDb,
    emitForSession: (sessionKey, event) => gateway.emitForSession(sessionKey, event),
    approvalDecide: input => gateway.approvalDecide(input),
  });
  const runMemberScan = (): void => {
    void scanTeamMembers({
      db: teamDb,
      gateway,
      projectRoot: fallbackProjectRoot,
      pilotHome,
      hasPendingApprovals: sessionKey => gateway.getApprovalBus().list(sessionKey).length > 0,
    })
      .then(result => {
        if (result.resumed > 0) {
          console.log(`[sati] Team member resume: scanned=${result.scanned}, resumed=${result.resumed}`);
        }
      })
      .catch(() => undefined);
  };
```

3. 返回对象与 dispose 扩展（`return` 语句与 `dispose` 定义处）：

```typescript
  dispose: () => {
    teamDb.close();
    ...
  },
  teamSubsystem: { db: teamDb, runMemberScan },
```

注意：`gateway` 是 `InProcessGateway`（含 emitForSession/getApprovalBus/approvalDecide）。若闭包内 `gateway` 变量为 `Gateway` 接口类型，用局部断言：

```typescript
const inProcess = gateway as InProcessGateway;
```

（`InProcessGateway` 已在本文件 import，参照 `runTaskResumeScan` 的 `this.gateway` 用法与 `getApprovalBus` 调用点。）

4. 启动触发：`createLocalGateway` 末尾（`runTaskResumeScan` 定义后）：

```typescript
  runMemberScan();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm build && node --test dist/tests/agent/team/team-gateway-integration.spec.js`
Expected: PASS（集成测试全绿）

- [ ] **Step 5: 全量回归 + 门禁**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: 全绿。特别注意 `tests/session/resume/task-resume-scanner.spec.ts` 与 `tests/session/storage/` 下既有测试不受 `isInternalSession` 扩展影响（always-on 前缀行为未变）。

- [ ] **Step 6: 提交**

```bash
git add src/cli/createLocalGateway.ts src/agent/team/index.ts tests/agent/team/team-gateway-integration.spec.ts
git commit -m "feat(agent): createLocalGateway 接线团队子系统（teams.db + 冷恢复扫描 + 审批转发）"
```

---

## Self-Review（写计划时已执行）

1. **Spec 覆盖（M1/L0 节）**：成员创建（Task 3）/ 唤醒走 submitTurn 整条链（Task 4）/ LLM 路由快照持久化（Task 3，modelRouteJson；resolveModelInfo 解析留 M3 工具面）/ 冷恢复（Task 5）/ 退休 deny-list（Task 1 retired_members + Task 4 拒绝 + Task 5 跳过）/ 转录隔离（Task 2 + Task 7 集成断言）/ 审批转发层（Task 6）。**无缺口**。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整可编译代码。
3. **类型一致性**：`TeamMemberRow`/`TeamDb` 方法名在 Task 1 定义、Task 3-7 引用一致；`wakeMember` 的 `onEvent` 回调在 Task 4 定义、Task 6 消费一致；`TEAM_MEMBER_RESUME_MESSAGE` 在 Task 5 定义并自用；`defaultTeamDbPath` 在 Task 7 定义并接线。
4. **已知取舍（有意为之）**：`team:` 前缀字符串在 member-key.ts 与 SessionList.ts 各定义一次（避免 session → agent 反向依赖），Task 2 测试锁行为一致；`scanTeamMembers` 的 `scanned` 计数不含退休成员（跳过在计数前），spec 测试即契约。
