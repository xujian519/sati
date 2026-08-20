/**
 * src/patent/provenance — 决策溯源存储（per-case 与全局共用同一 schema）。
 *
 * 存储约定（方案 §3.2）：
 *   - `node:sqlite` DatabaseSync，经 openKnowledgeDb 打开（PROVENANCE_DB spec，
 *     kind:"source" —— 版本不符 fail-loud，绝不 needsRebuild 静默重建销毁审计）。
 *   - 打开前调用方须 mkdir 父目录（openKnowledgeDb 不建目录）；用毕 close() 释放
 *     句柄（Windows 上不关闭无法删除/替换库文件，EBUSY 教训见 kg-store.ts）。
 *   - 幂等：activity/entity 以 id 为主键，INSERT OR IGNORE 保证 resume 重放不重复。
 *   - input_ids / derived_from 存 JSON 文本数组（对齐 kg_nodes.law_refs 存法）。
 *   - caseId 过滤三态：undefined=不过滤；null=只查无归属记录（全局库）；string=精确匹配。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { openKnowledgeDb } from "../../knowledge/shared/db-version.js";
import { PROVENANCE_DB } from "../../knowledge/shared/schema-versions.js";
import type { ProvenanceActivity, ProvenanceAgent, ProvenanceEntity } from "./types.js";

type ActivityRow = {
  id: string;
  source: string;
  name: string;
  case_id: string | null;
  run_id: string;
  step_index: number | null;
  started_at: number;
  duration_ms: number | null;
  agent_id: string;
  input_ids: string;
};

type EntityRow = {
  id: string;
  kind: string;
  value: string;
  case_id: string | null;
  generated_by: string | null;
  derived_from: string;
  degraded: number;
};

type AgentRow = {
  id: string;
  kind: string;
  name: string;
  model: string | null;
};

function parseIdArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export class ProvenanceStore {
  private readonly db: DatabaseSync;
  private readonly stmtUpsertActivity: StatementSync;
  private readonly stmtUpsertEntity: StatementSync;
  private readonly stmtUpsertEntityLatest: StatementSync;
  private readonly stmtUpsertAgent: StatementSync;
  private readonly stmtListActivities: StatementSync;
  private readonly stmtListActivitiesByCase: StatementSync;
  private readonly stmtListActivitiesNullCase: StatementSync;
  private readonly stmtListEntities: StatementSync;
  private readonly stmtListEntitiesByCase: StatementSync;
  private readonly stmtListEntitiesNullCase: StatementSync;
  private readonly stmtListAgents: StatementSync;
  private closed = false;

  constructor(dbPath: string) {
    // 打开前建父目录（openKnowledgeDb 直接 new DatabaseSync，不负责目录）
    mkdirSync(dirname(dbPath), { recursive: true });
    const opened = openKnowledgeDb(dbPath, PROVENANCE_DB, { readOnly: false });
    this.db = opened.db;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS activity (
          id          TEXT PRIMARY KEY,
          source      TEXT NOT NULL,
          name        TEXT NOT NULL,
          case_id     TEXT,
          run_id      TEXT NOT NULL,
          step_index  INTEGER,
          started_at  INTEGER NOT NULL,
          duration_ms INTEGER,
          agent_id    TEXT NOT NULL,
          input_ids   TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS entity (
          id            TEXT PRIMARY KEY,
          kind          TEXT NOT NULL,
          value         TEXT NOT NULL,
          case_id       TEXT,
          generated_by  TEXT,
          derived_from  TEXT NOT NULL DEFAULT '[]',
          degraded      INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS agent (
          id    TEXT PRIMARY KEY,
          kind  TEXT NOT NULL,
          name  TEXT NOT NULL,
          model TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_activity_run ON activity (run_id);
        CREATE INDEX IF NOT EXISTS idx_entity_case ON entity (case_id);
      `);
      this.stmtUpsertActivity = this.db.prepare(`
        INSERT OR IGNORE INTO activity
          (id, source, name, case_id, run_id, step_index, started_at, duration_ms, agent_id, input_ids)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtUpsertEntity = this.db.prepare(`
        INSERT OR IGNORE INTO entity
          (id, kind, value, case_id, generated_by, derived_from, degraded)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtUpsertEntityLatest = this.db.prepare(`
        INSERT OR REPLACE INTO entity
          (id, kind, value, case_id, generated_by, derived_from, degraded)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtUpsertAgent = this.db.prepare(`
        INSERT OR IGNORE INTO agent (id, kind, name, model) VALUES (?, ?, ?, ?)
      `);
      this.stmtListActivities = this.db.prepare(`SELECT * FROM activity ORDER BY started_at, id`);
      this.stmtListActivitiesByCase = this.db.prepare(
        `SELECT * FROM activity WHERE case_id = ? ORDER BY started_at, id`,
      );
      this.stmtListActivitiesNullCase = this.db.prepare(
        `SELECT * FROM activity WHERE case_id IS NULL ORDER BY started_at, id`,
      );
      this.stmtListEntities = this.db.prepare(`SELECT * FROM entity ORDER BY id`);
      this.stmtListEntitiesByCase = this.db.prepare(`SELECT * FROM entity WHERE case_id = ? ORDER BY id`);
      this.stmtListEntitiesNullCase = this.db.prepare(`SELECT * FROM entity WHERE case_id IS NULL ORDER BY id`);
      this.stmtListAgents = this.db.prepare(`SELECT * FROM agent ORDER BY id`);
    } catch (error) {
      // fail-closed 抛错路径必须释放句柄（Windows EBUSY，对齐 kg-store.ts:74-78）
      this.db.close();
      throw error;
    }
  }

  /** 幂等写入活动（同 id 二次写忽略；resume 重放安全）。 */
  upsertActivity(activity: ProvenanceActivity): void {
    this.assertOpen();
    this.stmtUpsertActivity.run(
      activity.id,
      activity.source,
      activity.name,
      activity.caseId,
      activity.runId,
      activity.stepIndex ?? null,
      activity.startedAt,
      activity.durationMs ?? null,
      activity.agentId,
      JSON.stringify(activity.inputIds),
    );
  }

  /** 幂等写入实体。 */
  upsertEntity(entity: ProvenanceEntity): void {
    this.assertOpen();
    this.stmtUpsertEntity.run(
      entity.id,
      entity.kind,
      entity.value,
      entity.caseId,
      entity.generatedByActivityId ?? null,
      JSON.stringify(entity.derivedFromIds),
      entity.degraded === true ? 1 : 0,
    );
  }

  /**
   * 覆盖写入实体（INSERT OR REPLACE）：图节点状态快照专用——同 key 被 LWW 重写
   * （如 inventiveness_query 每轮 refine 更新）时快照反映**最新值**；resume 重放
   * 覆盖为相同值，幂等语义不受影响。
   */
  upsertEntityLatest(entity: ProvenanceEntity): void {
    this.assertOpen();
    this.stmtUpsertEntityLatest.run(
      entity.id,
      entity.kind,
      entity.value,
      entity.caseId,
      entity.generatedByActivityId ?? null,
      JSON.stringify(entity.derivedFromIds),
      entity.degraded === true ? 1 : 0,
    );
  }

  /** 幂等写入执行者。 */
  upsertAgent(agent: ProvenanceAgent): void {
    this.assertOpen();
    this.stmtUpsertAgent.run(agent.id, agent.kind, agent.name, agent.model ?? null);
  }

  /** 列出活动；caseId 三态：undefined=全部，null=无归属（全局库），string=精确匹配。 */
  listActivities(caseId?: string | null): ProvenanceActivity[] {
    this.assertOpen();
    const rows = selectRows<ActivityRow>(
      this.stmtListActivities,
      this.stmtListActivitiesByCase,
      this.stmtListActivitiesNullCase,
      caseId,
    );
    return rows.map(row => ({
      id: row.id,
      source: row.source as ProvenanceActivity["source"],
      name: row.name,
      caseId: row.case_id,
      runId: row.run_id,
      ...(row.step_index !== null ? { stepIndex: row.step_index } : {}),
      startedAt: row.started_at,
      ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
      agentId: row.agent_id,
      inputIds: parseIdArray(row.input_ids),
    }));
  }

  /** 列出实体；caseId 三态语义同 listActivities。 */
  listEntities(caseId?: string | null): ProvenanceEntity[] {
    this.assertOpen();
    const rows = selectRows<EntityRow>(
      this.stmtListEntities,
      this.stmtListEntitiesByCase,
      this.stmtListEntitiesNullCase,
      caseId,
    );
    return rows.map(row => ({
      id: row.id,
      kind: row.kind as ProvenanceEntity["kind"],
      value: row.value,
      caseId: row.case_id,
      ...(row.generated_by !== null ? { generatedByActivityId: row.generated_by } : {}),
      derivedFromIds: parseIdArray(row.derived_from),
      ...(row.degraded === 1 ? { degraded: true } : {}),
    }));
  }

  /** 列出执行者。 */
  listAgents(): ProvenanceAgent[] {
    this.assertOpen();
    const rows = this.stmtListAgents.all() as unknown as AgentRow[];
    return rows.map(row => ({
      id: row.id,
      kind: row.kind as ProvenanceAgent["kind"],
      name: row.name,
      ...(row.model !== null ? { model: row.model } : {}),
    }));
  }

  /** 释放句柄（运行结束/导出后调用；Windows 上不关闭无法删库/替换）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("ProvenanceStore: 已关闭");
  }
}

/** 按 caseId 三态选择查询语句并执行（undefined=all / null=无归属 / string=精确）。 */
function selectRows<T>(
  all: StatementSync,
  byCase: StatementSync,
  nullCase: StatementSync,
  caseId: string | null | undefined,
): T[] {
  if (caseId === undefined) return all.all() as T[];
  if (caseId === null) return nullCase.all() as T[];
  return byCase.all(caseId) as T[];
}
