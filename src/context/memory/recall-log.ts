/**
 * 记忆召回日志（memory recall log）—— WS1 可观测层。
 *
 * 每次记忆检索（注入 / 空结果 / 超时 / 取消 / 预算 deferred）落一行
 * `memory_recall_log`，turn 收尾按「注入条目 id / 标题前缀」在 assistant
 * 输出中判定引用并回填 `cited_ids_json`。设计来源与取舍见
 * docs/notes/2026-10-14-memory-recall-log.md（草稿闸门计划的 WS1）。
 *
 * 关键约束：
 *  - 日志库为 Sati 自有状态库（默认 `~/.sati/state/memory-recall-log.db`），
 *    **不写 knowledge.db**（XiaoNuo 管道产物，避免污染外部数据契约）；
 *  - 打开失败 → 一次性 warn 后 fail-open 停用（AGENTS.md 铁律 11：降级可观测、
 *    绝不打断 agent turn）；已在 assets/degradation/registry.yaml 登记；
 *  - 引用判定保守优先：前缀碰撞宁可漏标不可瞎标（对齐 dsh autoCite 原则）。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../../telemetry/index.js";
import type { CanonicalMessage } from "../../model/index.js";
import type { MemoryDiagnostic, MemoryHit } from "./MemoryResolver.js";

/** 库身份魔数（"RLOG"），防误开他库。 */
export const RECALL_LOG_APPLICATION_ID = 0x524c4f47;

/** 当前 schema 版本（迁移阶梯见 MIGRATIONS）。 */
export const RECALL_LOG_SCHEMA_VERSION = 1;

/** 滚动保留行数（对齐 dsh knowledge_recall_log 的 KEEP_ROWS=2000）。 */
export const RECALL_LOG_KEEP_ROWS = 2000;

/** 引用判定最小 id 长度（防短 id 噪声误判）。 */
const MIN_HIT_ID_CHARS = 6;
/** 标题前缀引用判定的最小前缀长度（对齐 dsh 的 12 字符口径）。 */
const MIN_TITLE_PREFIX_CHARS = 12;

export type RecallLogSkipReason = "timeout" | "error" | "empty_context" | "aborted" | "deferred";

export type RecallLogEntry = {
  sessionId: string;
  turnId?: string;
  query: string;
  hits?: MemoryHit[];
  injected: boolean;
  skipReason?: RecallLogSkipReason;
  diagnostics?: MemoryDiagnostic[];
};

/** 日志出口抽象：builder / runtime 只依赖本接口，测试注入记录假实现。 */
export type RecallLogSink = {
  log(entry: RecallLogEntry): void;
  cite(input: { sessionId: string; citedIds: string[] }): void;
};

/** schema 迁移阶梯：MIGRATIONS[n-1] 把库从 n-1 升到 n。 */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  db => {
    db.exec(`
      CREATE TABLE memory_recall_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL DEFAULT '',
        query TEXT NOT NULL DEFAULT '',
        hit_ids_json TEXT NOT NULL DEFAULT '[]',
        injected INTEGER NOT NULL DEFAULT 0,
        skip_reason TEXT,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        cited_ids_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_memory_recall_log_session ON memory_recall_log(session_id, id);
    `);
  },
];

/**
 * 打开召回日志库并校验/迁移版本戳（协议对齐 src/knowledge/shared/db-version.ts：
 * 未来版本与 application_id 不符一律 fail-loud，绝不静默降级）。
 */
export function openRecallLogDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    const appId = (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
    if (appId !== 0 && appId !== RECALL_LOG_APPLICATION_ID) {
      throw new Error(`application_id 为 ${appId}，不是记忆召回日志库（期望 ${RECALL_LOG_APPLICATION_ID}）`);
    }
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > RECALL_LOG_SCHEMA_VERSION) {
      throw new Error(
        `召回日志库版本（${version}）高于当前程序支持（${RECALL_LOG_SCHEMA_VERSION}），请升级 Sati 后重试`,
      );
    }
    for (let v = version; v < RECALL_LOG_SCHEMA_VERSION; v += 1) {
      MIGRATIONS[v]?.(db);
    }
    db.exec(`PRAGMA user_version = ${RECALL_LOG_SCHEMA_VERSION}`);
    db.exec(`PRAGMA application_id = ${RECALL_LOG_APPLICATION_ID}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** 追加一条召回日志并滚动清理（保留最近 RECALL_LOG_KEEP_ROWS 行）。 */
export function appendRecallLog(db: DatabaseSync, entry: RecallLogEntry): void {
  db.prepare(
    `INSERT INTO memory_recall_log
       (session_id, turn_id, query, hit_ids_json, injected, skip_reason, diagnostics_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.sessionId,
    entry.turnId ?? "",
    entry.query,
    JSON.stringify(entry.hits ?? []),
    entry.injected ? 1 : 0,
    entry.skipReason ?? null,
    JSON.stringify(entry.diagnostics ?? []),
    new Date().toISOString(),
  );
  db.prepare(
    `DELETE FROM memory_recall_log
     WHERE id NOT IN (SELECT id FROM memory_recall_log ORDER BY id DESC LIMIT ?)`,
  ).run(RECALL_LOG_KEEP_ROWS);
}

/**
 * 引用回填：只更新「同会话 + cited_ids_json 为 NULL + 命中交集非空」的行，
 * 交集剔除未注入的 id；无交集行与其他会话行保持 NULL（漏标不瞎标）。
 */
export function citeRecallLog(db: DatabaseSync, input: { sessionId: string; citedIds: string[] }): void {
  if (input.citedIds.length === 0) return;
  const rows = db
    .prepare("SELECT id, hit_ids_json FROM memory_recall_log WHERE session_id = ? AND cited_ids_json IS NULL")
    .all(input.sessionId) as Array<{ id: number; hit_ids_json: string }>;
  const update = db.prepare("UPDATE memory_recall_log SET cited_ids_json = ? WHERE id = ?");
  for (const row of rows) {
    let hitIds: string[] = [];
    try {
      const parsed = JSON.parse(row.hit_ids_json) as unknown;
      if (Array.isArray(parsed)) {
        hitIds = parsed.map(h => (h as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
      }
    } catch {
      // hit_ids_json 损坏：该行跳过引用回填（日志数据不得反过来打断主流程）。
      continue;
    }
    const cited = input.citedIds.filter(id => hitIds.includes(id));
    if (cited.length > 0) {
      update.run(JSON.stringify(cited), row.id);
    }
  }
}

/**
 * 基于文件的 RecallLogSink：首次使用时惰性打开并缓存连接；
 * 打开或写入失败 → 记一次 warn 后永久停用（fail-open）。
 */
export class FileRecallLogSink implements RecallLogSink {
  private db: DatabaseSync | undefined;
  private disabled = false;
  private readonly logger = createLogger("context:memory-recall-log");

  constructor(private readonly dbPath: string) {}

  log(entry: RecallLogEntry): void {
    this.withDb(db => appendRecallLog(db, entry));
  }

  cite(input: { sessionId: string; citedIds: string[] }): void {
    this.withDb(db => citeRecallLog(db, input));
  }

  private withDb(fn: (db: DatabaseSync) => void): void {
    if (this.disabled) return;
    try {
      this.db ??= openRecallLogDb(this.dbPath);
      fn(this.db);
    } catch (error) {
      // 降级但不静默：一次性 warn 记录「谁漏了什么」，之后 no-op（注册表
      // memory-recall-log-db 条目登记的 fail-open 语义）。
      this.disabled = true;
      this.safeWarn(`recall log disabled (${this.dbPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private safeWarn(message: string): void {
    try {
      this.logger.warn(message);
    } catch {
      // 日志器自身失败不再上抛（可观测路径的最后一道兜底）。
    }
  }
}

/** 提取 assistant 消息的全部文本块（工具结果不参与引用判定）。 */
export function collectAssistantText(messages: CanonicalMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * 保守引用判定：assistant 文本出现注入条目 id，或出现某条目标题的唯一
 * ≥12 字前缀，才判为引用。两条命中共享同一前缀（碰撞）时都不标。
 */
export function matchCitedHits(text: string, hits: MemoryHit[]): string[] {
  if (!text || hits.length === 0) return [];
  const cited = new Set<string>();
  const prefixOwners = new Map<string, string[]>();

  for (const hit of hits) {
    if (hit.id.length >= MIN_HIT_ID_CHARS && text.includes(hit.id)) {
      cited.add(hit.id);
    }
    const title = hit.title?.trim();
    if (title && Array.from(title).length >= MIN_TITLE_PREFIX_CHARS) {
      const prefix = Array.from(title).slice(0, MIN_TITLE_PREFIX_CHARS).join("");
      const owners = prefixOwners.get(prefix) ?? [];
      owners.push(hit.id);
      prefixOwners.set(prefix, owners);
    }
  }

  for (const [prefix, owners] of prefixOwners) {
    if (owners.length > 1) continue;
    const owner = owners[0];
    if (owner && text.includes(prefix)) {
      cited.add(owner);
    }
  }

  return [...cited];
}
