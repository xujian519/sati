/**
 * 知识库 schema 版本集中声明（单一来源）。
 *
 * 每个数据库分配：
 * - 当前版本号（schema 结构变化时 +1，并用重建/重发数据文件的方式升级）；
 * - application_id 魔数（防误开他库；存量库为 0 时宽容跳过）。
 *
 * 版本语义见 shared/db-version.ts：真源（source）版本不符拒绝打开，
 * 派生索引（derived）版本过旧由调用方重建。
 */

import type { OpenKnowledgeDbSpec } from "./db-version.js";

/**
 * 每库一个完整 spec 对象（satisfies OpenKnowledgeDbSpec），供
 * openKnowledgeDb(path, SPEC, opts) 直接消费，避免调用点手拼版本/魔数/角色。
 */
export const KNOWLEDGE_DB = {
  version: 1,
  applicationId: 0x53415449, // "SATI"
  kind: "source",
} as const satisfies OpenKnowledgeDbSpec;

/** laws-full.db / laws-full-local.db：法规全文真源（law/law_fts）。 */
export const LAWS_DB = {
  version: 1,
  applicationId: 0x4c415753, // "LAWS"
  kind: "source",
} as const satisfies OpenKnowledgeDbSpec;

/** vectors.db：legacy 语义索引（可从真源重灌，derived；不可用时应降级而非报错）。 */
export const VECTORS_DB = {
  version: 1,
  applicationId: 0x56454354, // "VECT"
  kind: "derived",
} as const satisfies OpenKnowledgeDbSpec;
