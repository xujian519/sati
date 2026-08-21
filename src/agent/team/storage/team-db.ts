/**
 * 团队状态库（teams.db）最小实现：node:sqlite DatabaseSync + user_version 迁移。
 * M1 仅三表（teams/members/retired_members）；tasks/messages 表随 M2 以 v2 迁移加入。
 * 语义与 knowledge.db 不同：knowledge.db 只读消费，本库是团队状态的读写真源。
 *
 * ⚠️ 单进程边界（质量审阅 I4）：本库无 WAL/多进程并发协调（DatabaseSync 单连接），
 * 进程内并发由 withTeamLock（per-team 内存锁）串行化，进程崩溃安全由冷恢复
 * （resetMemberStatuses + scanTeamMembers + scanStrandedTasks）负责——多 gateway
 * 进程共享同一 teams.db 文件不在支持范围内（任务认领竞态无跨进程锁）。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { prepareCached } from "../../../shared/sqlite.js";

export type TeamRow = {
  id: string;
  name: string;
  captainSessionKey: string;
  createdAt: string;
  /** M3：归档时刻（ISO）；undefined = 未归档。归档不可逆（无 unarchive）。 */
  archivedAt?: string;
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

export type TeamTaskRow = {
  id: string; // team 内唯一（"t1"…），由调用方生成
  teamId: string;
  subject: string;
  description: string;
  status: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "cancelled";
  assigneeId?: string; // 成员 id 或 "captain"
  dependencies: string[];
  attempt: number;
  attemptId?: string;
  handoffId?: string;
  reassigning: boolean;
  blockedByCount: number;
  maxAttempts: number;
  output?: string;
  /** 阶段 3：任务期望执行的专业 worker 契约名（分派时按角色 tier 校验）。 */
  workerName?: string;
  createdAt: string;
  updatedAt: string;
};

export type TeamMessageRow = {
  id: string;
  teamId: string;
  sender: string; // "captain" 或成员 id
  recipient: string; // 成员 id 或 "captain"
  content: string;
  createdAt: string;
  deliveryClaimedAt?: string;
  deliveredAt?: string;
  readAt?: string;
};

type TeamDbRow = {
  id: string;
  name: string;
  captain_session_key: string;
  created_at: string;
  archived_at: string | null;
};
type MemberDbRow = {
  id: string;
  team_id: string;
  role_slug: string;
  model_route_json: string;
  status: string;
  session_key: string;
  created_at: string;
};
type TaskDbRow = {
  id: string;
  team_id: string;
  subject: string;
  description: string;
  status: string;
  assignee_id: string | null;
  dependencies_json: string;
  attempt: number;
  attempt_id: string | null;
  handoff_id: string | null;
  reassigning: number;
  blocked_by_count: number;
  max_attempts: number;
  output: string | null;
  worker_name: string | null;
  created_at: string;
  updated_at: string;
};
type MessageDbRow = {
  id: string;
  team_id: string;
  sender: string;
  recipient: string;
  content: string;
  created_at: string;
  delivery_claimed_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
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
  // v2：任务池 + 成员邮箱（M2）
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
  // v3：团队归档（M3）——archived_at 置位后调度器跳过该团队、成员全退休
  `ALTER TABLE teams ADD COLUMN archived_at TEXT;`,
  // v4：任务 worker 契约声明（阶段 3）——worker_name 供分派时角色 tier 校验
  `ALTER TABLE tasks ADD COLUMN worker_name TEXT;`,
];

function toTeamRow(row: TeamDbRow): TeamRow {
  return {
    id: row.id,
    name: row.name,
    captainSessionKey: row.captain_session_key,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? undefined,
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

function toTaskRow(row: TaskDbRow): TeamTaskRow {
  return {
    id: row.id,
    teamId: row.team_id,
    subject: row.subject,
    description: row.description,
    status: row.status as TeamTaskRow["status"],
    assigneeId: row.assignee_id ?? undefined,
    dependencies: JSON.parse(row.dependencies_json) as string[],
    attempt: row.attempt,
    attemptId: row.attempt_id ?? undefined,
    handoffId: row.handoff_id ?? undefined,
    reassigning: row.reassigning === 1,
    blockedByCount: row.blocked_by_count,
    maxAttempts: row.max_attempts,
    output: row.output ?? undefined,
    workerName: row.worker_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessageRow(row: MessageDbRow): TeamMessageRow {
  return {
    id: row.id,
    teamId: row.team_id,
    sender: row.sender,
    recipient: row.recipient,
    content: row.content,
    createdAt: row.created_at,
    deliveryClaimedAt: row.delivery_claimed_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    readAt: row.read_at ?? undefined,
  };
}

export class TeamDb {
  private readonly db: DatabaseSync;
  private closed = false;
  /**
   * 固定 SQL prepare 缓存：同形状 SQL 复用 StatementSync。团队调度器为常驻
   * 高频路径（wakeMember/任务认领/消息投递每轮多次查询），逐次 prepare 会
   * 重复 SQLite 解析与查询计划。
   */
  private readonly preparedCache = new Map<string, StatementSync>();

  constructor(dbPath: string) {
    // :memory: 的 dirname 是 "."，mkdirSync 无害；真实路径确保 ~/.sati/teams 存在。
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    const current = (
      prepareCached(this.preparedCache, this.db, "PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (current > MIGRATIONS.length) {
      throw new Error(`teams.db schema version ${current} is newer than supported (${MIGRATIONS.length})`);
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      // 每版本一事务（精简 B1）：复用 transaction() 原语，替代重复的 BEGIN/COMMIT/ROLLBACK 样板
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  /**
   * 通用同步事务原语：migrate() 与变更类多步操作共用（T8 review I-1 引入）。
   * 事务内任一步抛错即回滚并 rethrow；提交成功后才对外可见。node:sqlite 单连接串行，
   * 本方法不重入（事务内不得再嵌套调用）。
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertTeam(team: TeamRow): void {
    prepareCached(
      this.preparedCache,
      this.db,
      `INSERT INTO teams (id, name, captain_session_key, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, captain_session_key = excluded.captain_session_key`,
    ).run(team.id, team.name, team.captainSessionKey, team.createdAt);
  }

  getTeam(id: string): TeamRow | undefined {
    const row = prepareCached(this.preparedCache, this.db, "SELECT * FROM teams WHERE id = ?").get(id) as
      | TeamDbRow
      | undefined;
    return row ? toTeamRow(row) : undefined;
  }

  listTeams(): TeamRow[] {
    const rows = prepareCached(
      this.preparedCache,
      this.db,
      "SELECT * FROM teams ORDER BY created_at ASC",
    ).all() as TeamDbRow[];
    return rows.map(toTeamRow);
  }

  /** 归档团队：置 archived_at（仅未归档团队可归档）。返回是否生效。 */
  archiveTeam(teamId: string, archivedAt: string): boolean {
    const result = prepareCached(
      this.preparedCache,
      this.db,
      "UPDATE teams SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
    ).run(archivedAt, teamId);
    return result.changes > 0;
  }

  insertMember(row: TeamMemberRow): void {
    prepareCached(
      this.preparedCache,
      this.db,
      `INSERT INTO members (id, team_id, role_slug, model_route_json, status, session_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.teamId, row.roleSlug, row.modelRouteJson, row.status, row.sessionKey, row.createdAt);
  }

  updateMemberStatus(id: string, status: "idle" | "working"): void {
    prepareCached(this.preparedCache, this.db, "UPDATE members SET status = ? WHERE id = ?").run(status, id);
  }

  /** 进程冷启动时重置全部成员为 idle：崩溃残留的 working 必为死状态（无存活 turn），
   * 由宿主在启动扫描前调用（否则冷恢复会永久跳过这些成员）。 */
  resetMemberStatuses(): void {
    prepareCached(this.preparedCache, this.db, "UPDATE members SET status = 'idle'").run();
  }

  getMember(id: string): TeamMemberRow | undefined {
    const row = prepareCached(this.preparedCache, this.db, "SELECT * FROM members WHERE id = ?").get(id) as
      | MemberDbRow
      | undefined;
    return row ? toMemberRow(row) : undefined;
  }

  listMembers(): TeamMemberRow[] {
    const rows = prepareCached(
      this.preparedCache,
      this.db,
      "SELECT * FROM members ORDER BY created_at ASC",
    ).all() as MemberDbRow[];
    return rows.map(toMemberRow);
  }

  insertRetired(sessionKey: string, memberId: string, reason: string): void {
    prepareCached(
      this.preparedCache,
      this.db,
      `INSERT INTO retired_members (session_key, member_id, reason, retired_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET reason = excluded.reason, retired_at = excluded.retired_at`,
    ).run(sessionKey, memberId, reason, new Date().toISOString());
  }

  isRetired(sessionKey: string): boolean {
    const row = prepareCached(this.preparedCache, this.db, "SELECT 1 FROM retired_members WHERE session_key = ?").get(
      sessionKey,
    );
    return row !== undefined;
  }

  listTasks(teamId: string): TeamTaskRow[] {
    const rows = prepareCached(
      this.preparedCache,
      this.db,
      "SELECT * FROM tasks WHERE team_id = ? ORDER BY created_at ASC",
    ).all(teamId) as TaskDbRow[];
    return rows.map(toTaskRow);
  }

  getTask(teamId: string, taskId: string): TeamTaskRow | undefined {
    const row = prepareCached(this.preparedCache, this.db, "SELECT * FROM tasks WHERE team_id = ? AND id = ?").get(
      teamId,
      taskId,
    ) as TaskDbRow | undefined;
    return row ? toTaskRow(row) : undefined;
  }

  insertTask(row: TeamTaskRow): void {
    prepareCached(
      this.preparedCache,
      this.db,
      `INSERT INTO tasks (id, team_id, subject, description, status, assignee_id, dependencies_json,
          attempt, attempt_id, handoff_id, reassigning, blocked_by_count, max_attempts, output, worker_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.teamId,
      row.subject,
      row.description,
      row.status,
      row.assigneeId ?? null,
      JSON.stringify(row.dependencies),
      row.attempt,
      row.attemptId ?? null,
      row.handoffId ?? null,
      row.reassigning ? 1 : 0,
      row.blockedByCount,
      row.maxAttempts,
      row.output ?? null,
      row.workerName ?? null,
      row.createdAt,
      row.updatedAt,
    );
  }

  updateTask(row: TeamTaskRow): void {
    prepareCached(
      this.preparedCache,
      this.db,
      `UPDATE tasks SET subject = ?, description = ?, status = ?, assignee_id = ?, dependencies_json = ?,
          attempt = ?, attempt_id = ?, handoff_id = ?, reassigning = ?, blocked_by_count = ?, max_attempts = ?,
          output = ?, worker_name = ?, updated_at = ?
         WHERE team_id = ? AND id = ?`,
    ).run(
      row.subject,
      row.description,
      row.status,
      row.assigneeId ?? null,
      JSON.stringify(row.dependencies),
      row.attempt,
      row.attemptId ?? null,
      row.handoffId ?? null,
      row.reassigning ? 1 : 0,
      row.blockedByCount,
      row.maxAttempts,
      row.output ?? null,
      row.workerName ?? null,
      row.updatedAt,
      row.teamId,
      row.id,
    );
  }

  listMessages(teamId: string, recipient?: string): TeamMessageRow[] {
    const rows = recipient
      ? (prepareCached(
          this.preparedCache,
          this.db,
          "SELECT * FROM messages WHERE team_id = ? AND recipient = ? ORDER BY created_at ASC",
        ).all(teamId, recipient) as MessageDbRow[])
      : (prepareCached(
          this.preparedCache,
          this.db,
          "SELECT * FROM messages WHERE team_id = ? ORDER BY created_at ASC",
        ).all(teamId) as MessageDbRow[]);
    return rows.map(toMessageRow);
  }

  // 插入时不含投递状态（deliveryClaimedAt/deliveredAt/readAt 由 updateMessage 生命周期管理，insert 传入会被忽略）
  insertMessage(row: TeamMessageRow): void {
    prepareCached(
      this.preparedCache,
      this.db,
      `INSERT INTO messages (id, team_id, sender, recipient, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.teamId, row.sender, row.recipient, row.content, row.createdAt);
  }

  updateMessage(row: TeamMessageRow): void {
    // 仅更新投递生命周期三列；其余列（含 content）不可变
    prepareCached(
      this.preparedCache,
      this.db,
      `UPDATE messages SET delivery_claimed_at = ?, delivered_at = ?, read_at = ? WHERE team_id = ? AND id = ?`,
    ).run(row.deliveryClaimedAt ?? null, row.deliveredAt ?? null, row.readAt ?? null, row.teamId, row.id);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.preparedCache.clear();
    this.db.close();
  }
}
