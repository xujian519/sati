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
  private closed = false;

  constructor(dbPath: string) {
    // :memory: 的 dirname 是 "."，mkdirSync 无害；真实路径确保 ~/.sati/teams 存在。
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (current > MIGRATIONS.length) {
      throw new Error(`teams.db schema version ${current} is newer than supported (${MIGRATIONS.length})`);
    }
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
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}
