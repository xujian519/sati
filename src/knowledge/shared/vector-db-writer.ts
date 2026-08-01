/**
 * vectors.db 写入端（供 scripts/build-knowledge-vectors.ts 与测试使用）。
 *
 * 表结构：
 *   vector_meta(corpus TEXT PRIMARY KEY, dimensions INTEGER, model TEXT,
 *               chunk_chars INTEGER, chunk_overlap INTEGER, built_at TEXT)
 *   vectors(corpus TEXT, doc_id TEXT, chunk_index INTEGER,
 *           vector BLOB（int8 量化）, text_hash TEXT, scale REAL,
 *           PRIMARY KEY (corpus, doc_id, chunk_index))
 *
 * 检索端见 vector-db.ts（VectorDbSearch，只读）。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { quantizeInt8 } from "../../context/vector/cosine.js";

export { quantizeInt8 }; // int8 量化原语统一在 cosine.ts（全仓唯一实现）

export const VECTORS_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS vector_meta (
  corpus TEXT PRIMARY KEY,
  dimensions INTEGER NOT NULL,
  model TEXT NOT NULL,
  chunk_chars INTEGER NOT NULL,
  chunk_overlap INTEGER NOT NULL,
  built_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vectors (
  corpus TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  vector BLOB NOT NULL,
  text_hash TEXT NOT NULL,
  scale REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (corpus, doc_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_vectors_corpus ON vectors(corpus, doc_id);
`;

export type CorpusMeta = {
  corpus: string;
  dimensions: number;
  model: string;
  chunkChars: number;
  chunkOverlap: number;
  builtAt: string;
};

/** 打开（或创建）vectors.db 并建表。 */
export function openVectorsDbWriter(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(VECTORS_DB_SCHEMA);
  return db;
}

export function setCorpusMeta(db: DatabaseSync, meta: CorpusMeta): void {
  db.prepare(
    `INSERT INTO vector_meta (corpus, dimensions, model, chunk_chars, chunk_overlap, built_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(corpus) DO UPDATE SET
       dimensions = excluded.dimensions,
       model = excluded.model,
       chunk_chars = excluded.chunk_chars,
       chunk_overlap = excluded.chunk_overlap,
       built_at = excluded.built_at`,
  ).run(meta.corpus, meta.dimensions, meta.model, meta.chunkChars, meta.chunkOverlap, meta.builtAt);
}

export function getCorpusMeta(db: DatabaseSync, corpus: string): CorpusMeta | undefined {
  const row = db.prepare("SELECT * FROM vector_meta WHERE corpus = ?").get(corpus) as
    | {
        corpus: string;
        dimensions: number;
        model: string;
        chunk_chars: number;
        chunk_overlap: number;
        built_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    corpus: row.corpus,
    dimensions: row.dimensions,
    model: row.model,
    chunkChars: row.chunk_chars,
    chunkOverlap: row.chunk_overlap,
    builtAt: row.built_at,
  };
}

/** 已索引文档的 text_hash 索引（用于增量跳过）。 */
export function listIndexedDocHashes(db: DatabaseSync, corpus: string): Map<string, string> {
  const rows = db.prepare("SELECT doc_id, text_hash FROM vectors WHERE corpus = ?").all(corpus) as Array<{
    doc_id: string;
    text_hash: string;
  }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.doc_id, row.text_hash);
  }
  return map;
}

/** 删除某文档的全部 chunk（重建前先清旧）。 */
export function deleteDocVectors(db: DatabaseSync, corpus: string, docId: string): void {
  db.prepare("DELETE FROM vectors WHERE corpus = ? AND doc_id = ?").run(corpus, docId);
}

export function insertVectorChunk(
  db: DatabaseSync,
  corpus: string,
  docId: string,
  chunkIndex: number,
  vector: Int8Array,
  textHash: string,
  scale: number,
): void {
  const blob = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  db.prepare(
    `INSERT INTO vectors (corpus, doc_id, chunk_index, vector, text_hash, scale)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(corpus, doc_id, chunk_index) DO UPDATE SET
       vector = excluded.vector,
       text_hash = excluded.text_hash,
       scale = excluded.scale`,
  ).run(corpus, docId, chunkIndex, blob, textHash, scale);
}

/** 长文分块：按码点切分，~chunkChars 字/块 + overlap 字重叠。 */
export function chunkText(text: string, chunkChars = 1200, overlap = 200): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chars = Array.from(trimmed);
  if (chars.length <= chunkChars) return [trimmed];
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const end = Math.min(start + chunkChars, chars.length);
    chunks.push(chars.slice(start, end).join(""));
    if (end >= chars.length) break;
    const next = end - overlap;
    start = next > start ? next : start + 1;
  }
  return chunks;
}
