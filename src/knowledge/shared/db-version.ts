/**
 * 知识库数据库版本管理（真源 fail-loud、派生索引可重建）。
 *
 * 背景：knowledge 相关数据库此前裸打开（无 PRAGMA user_version /
 * application_id），schema 漂移时会被静默当作新库使用。本工具为所有
 * knowledge 库引入统一打开协议：
 *
 * - 真源（source，随产品发布，如 knowledge.db）：版本不符 → 抛
 *   KnowledgeDbVersionError，拒绝打开，绝不静默降级；
 * - 派生（derived，可从真源重灌，如 embeddings/FTS 索引）：版本过旧 →
 *   返回 needsRebuild，由调用方执行重建。
 * - 版本大于当前支持的库（来自未来版本）一律 fail-loud；
 * - 存量库（user_version = 0，升级前已存在）宽容处理：写路径打上版本戳，
 *   读路径视同当前版本，避免存量用户升级即报错。
 */

import { DatabaseSync } from "node:sqlite";

/** 知识库版本不符错误：消息含当前版本/期望版本/升级提示。 */
export class KnowledgeDbVersionError extends Error {
  constructor(
    dbPath: string,
    message: string,
    options: { currentVersion?: number; expectedVersion: number; cause?: unknown },
  ) {
    const hint =
      options.currentVersion !== undefined
        ? `（当前 ${options.currentVersion}，期望 ${options.expectedVersion}）`
        : `（期望 ${options.expectedVersion}）`;
    super(`${dbPath}${hint}：${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KnowledgeDbVersionError";
  }
}

/** 数据库角色：真源（不可重建）或派生索引（可从真源重灌）。 */
export type KnowledgeDbKind = "source" | "derived";

export type OpenKnowledgeDbSpec = {
  /** 当前版本号（schema-versions.ts 集中声明）。 */
  version: number;
  /** 真源 / 派生索引。 */
  kind: KnowledgeDbKind;
  /** 库身份魔数（防误开他库）；存量库为 0 时宽容跳过。 */
  applicationId?: number;
};

export type OpenKnowledgeDbOptions = {
  /** 只读打开（默认 false）。读路径对存量库打不了版本戳，宽容放行。 */
  readOnly?: boolean;
  /**
   * 派生库专用：version = 0（从未打戳，含构建中断的半成品）视为需重建，
   * 而非存量宽容放行。vectors.db 读端使用——中断构建的库不能静默当空库读。
   */
  treatZeroAsStale?: boolean;
};

export type OpenKnowledgeDbResult =
  | { db: DatabaseSync; needsRebuild: false; version: number }
  | { db: DatabaseSync; needsRebuild: true; version: number };

/**
 * 打开知识库并校验/写入版本戳。
 *
 * 版本语义：
 * - user_version = 0（存量库）：宽容。写路径打戳；读路径视同当前版本。
 * - user_version === expectedVersion：正常。
 * - user_version < expectedVersion：source → 抛错；derived → needsRebuild。
 * - user_version > expectedVersion：一律抛错（来自未来版本，宁拒绝不残缺）。
 * - application_id 已设置且不等于 spec.applicationId：抛错（打开的是别的库）。
 */
export function openKnowledgeDb(
  dbPath: string,
  spec: OpenKnowledgeDbSpec,
  options: OpenKnowledgeDbOptions = {},
): OpenKnowledgeDbResult {
  const readOnly = options.readOnly ?? false;
  try {
    const db = new DatabaseSync(dbPath, { readOnly });
    try {
      if (spec.applicationId !== undefined) {
        const row = db.prepare("PRAGMA application_id").get() as { application_id: number };
        const existing = row.application_id;
        if (existing !== 0 && existing !== spec.applicationId) {
          throw new KnowledgeDbVersionError(
            dbPath,
            `application_id 为 ${existing}，期望 ${spec.applicationId}，可能打开了错误的数据库`,
            { expectedVersion: spec.version },
          );
        }
      }

      const verRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
      const version = verRow.user_version;
      return evaluateVersion(dbPath, spec, readOnly, options.treatZeroAsStale ?? false, version, db);
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    // 打开失败（文件不存在/损坏/权限）与校验失败统一包装为
    // KnowledgeDbVersionError，调用方（含派生库降级路径）依赖统一错误类型。
    if (error instanceof KnowledgeDbVersionError) throw error;
    throw new KnowledgeDbVersionError(dbPath, "打开数据库失败", {
      expectedVersion: spec.version,
      cause: error,
    });
  }
}

/** 版本判定（与打开解耦，便于 try 统一收口）。 */
function evaluateVersion(
  dbPath: string,
  spec: OpenKnowledgeDbSpec,
  readOnly: boolean,
  treatZeroAsStale: boolean,
  version: number,
  db: DatabaseSync,
): OpenKnowledgeDbResult {
  if (version === 0) {
    // 派生库显式要求：version=0 视为未就绪（重建/构建），不静默放行。
    if (spec.kind === "derived" && treatZeroAsStale) {
      return { db, needsRebuild: true, version: 0 };
    }
    // 存量库（升级前已存在，无版本戳）：宽容。写路径补打戳。
    if (!readOnly) {
      db.exec(`PRAGMA user_version = ${spec.version}`);
      if (spec.applicationId !== undefined) {
        db.exec(`PRAGMA application_id = ${spec.applicationId}`);
      }
    }
    return { db, needsRebuild: false, version: 0 };
  }

  if (version === spec.version) {
    return { db, needsRebuild: false, version };
  }

  if (version > spec.version) {
    throw new KnowledgeDbVersionError(dbPath, "数据库版本高于当前程序支持，请升级 Sati 后重试", {
      currentVersion: version,
      expectedVersion: spec.version,
    });
  }

  // version < spec.version
  if (spec.kind === "source") {
    throw new KnowledgeDbVersionError(dbPath, "数据库版本过旧且为真源数据，无法原地升级；请重新安装或更新数据文件", {
      currentVersion: version,
      expectedVersion: spec.version,
    });
  }
  return { db, needsRebuild: true, version };
}
