import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 知识库数据路径解析。
 *
 * 数据库文件体积大（patent_kg.db 217MB / laws-full.db 159MB），不随
 * 代码仓库分发，运行时按路径引用外部数据：
 *
 * 1. 环境变量 `SATI_KNOWLEDGE_DIR`（优先，指定数据目录）
 * 2. 环境变量 `SATI_PATENT_KG_DB` / `SATI_LAW_DB` / `SATI_CASE_DB`（单文件覆盖）
 * 3. 默认目录 `~/.mady/knowledge/`（Mady 运行数据）
 * 4. 宝宸知识库原始目录（Laws-1.0.0/db.sqlite3）
 */

const DEFAULT_KNOWLEDGE_DIR = join(homedir(), ".mady", "knowledge");
const BAOCHEN_LAW_DB = join(homedir(), "projects", "宝宸知识库_Raw", "Laws-1.0.0", "db.sqlite3");

export type KnowledgeDbPaths = {
  /** 专利知识图谱数据库（nodes/edges 表），缺失时 undefined。 */
  patentKgDb?: string;
  /** 法律全文检索数据库（law/category 表，优先 FTS5 版），缺失时 undefined。 */
  lawDb?: string;
  /** wiki 卡片目录（专利知识卡片，含 card-index.json），缺失时 undefined。 */
  wikiDir?: string;
  /** 离线向量索引（KG/法条 int8 语义检索，scripts/build-knowledge-vectors.ts 生成），缺失时 undefined。 */
  vectorsDb?: string;
  /** 判例全文检索数据库（documents/chunks/docs_fts 表，含无效复审决定与专利判决全文），缺失时 undefined。 */
  caseDb?: string;
  /** knowledge.db 统一主库（XiaoNuo 管道产物：kg_nodes/法规/embeddings/判例），缺失时 undefined。 */
  knowledgeDb?: string;
  /** 数据目录来源（用于诊断）。 */
  dataDir: string;
};

/** 随仓库分发的内置 wiki 卡片目录（不含商标）。 */
// 直接用 fileURLToPath(import.meta.url) 取目录：在 vitest/vite-node 环境下
// new URL(".", import.meta.url) 的相对解析会被劫持成 http:// 服务器 URL，
// 导致 fileURLToPath 抛 "The URL must be of scheme file"。
const BUILTIN_WIKI_DIR = join(dirname(fileURLToPath(import.meta.url)), "patent", "wiki");

/**
 * 语义向量持久化默认目录（memory/wiki 的 JSONL 索引；调用方显式传
 * embeddingDir 时优先，本值为兜底）。
 */
export function defaultEmbeddingDir(): string {
  return join(DEFAULT_KNOWLEDGE_DIR, "embeddings");
}

function firstExisting(candidates: string[]): string | undefined {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

/** 解析知识库数据库路径（不打开数据库，仅定位）。 */
export function resolveKnowledgeDbPaths(env: NodeJS.ProcessEnv = process.env): KnowledgeDbPaths {
  const dataDir = env.SATI_KNOWLEDGE_DIR ?? DEFAULT_KNOWLEDGE_DIR;

  // knowledge.db 统一主库（XiaoNuo 管道产物：kg_nodes/法规/embeddings/判例；存在时优先）。
  const knowledgeDb = env.SATI_KNOWLEDGE_DB ?? firstExisting([join(dataDir, "knowledge.db")]);

  // 图谱：knowledge.db 存在时读其 kg_nodes（KgStore 双 schema 自动识别）；否则旧 patent_kg.db。
  const patentKgDb =
    env.SATI_PATENT_KG_DB ??
    knowledgeDb ??
    firstExisting([join(dataDir, "patent_kg.db"), join(dataDir, "knowledge", "patent_kg.db")]);

  const lawDb =
    env.SATI_LAW_DB ??
    firstExisting([
      // FTS5 版优先（trigram + BM25）
      join(dataDir, "laws-full-local.db"),
      join(dataDir, "laws-full.db"),
      BAOCHEN_LAW_DB,
    ]);

  // wiki 卡片：内置目录优先，环境变量可覆盖到外部数据目录
  const wikiDir = env.SATI_WIKI_DIR ?? (existsSync(BUILTIN_WIKI_DIR) ? BUILTIN_WIKI_DIR : undefined);

  // 离线向量索引（legacy 产物；knowledge.db embeddings 为主路径后不再作为首选）
  const vectorsDb = env.SATI_VECTORS_DB ?? firstExisting([join(dataDir, "vectors.db")]);

  // 判例全文库：knowledge.db 优先（documents/chunks/docs_fts），否则旧 knowledge.db/cases.db 路径
  const caseDb =
    env.SATI_CASE_DB ?? knowledgeDb ?? firstExisting([join(dataDir, "knowledge.db"), join(dataDir, "cases.db")]);

  return { patentKgDb, lawDb, wikiDir, vectorsDb, caseDb, knowledgeDb, dataDir };
}
