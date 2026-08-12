/**
 * chunks.content 应用级压缩（--compress-chunks 迁移产物）。
 *
 * 背景：chunks 表 144K 行正文 ~510MB（平均 3.7K 字符中文），是 knowledge.db
 * 第二大文本载体。docs_fts 是 contentless 表（索引独立于 chunks.content），
 * 压缩正文不影响 FTS 检索；读取端（判例/法规回源、embedding 锚点）经
 * sati_uncompress() 解压，透明无感知。
 *
 * 存储格式（双态，SQLite 存储类天然区分）：
 *   - 明文：TEXT 存储类，原样返回（knowledgeNoteSave 等写入者兼容）；
 *   - 压缩：BLOB 存储类，前 2 字节魔数 0x53 0x43（"SC"）+ gzip 数据。
 *
 * 检索场景只解压 top-k 命中（10-50 行），gunzip 开销可忽略。
 */

import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";

/** 魔数 "SC"（Sati Compressed）。 */
const MAGIC = [0x53, 0x43] as const;

/** 压缩阈值：低于该字符数的小 chunk 压缩收益低（gzip 头开销占比高），保持明文。 */
export const MIN_COMPRESS_CHARS = 800;

/** 文本 → 压缩 BLOB（魔数 + gzip）。 */
export function compressChunk(text: string): Buffer {
  const gz = gzipSync(Buffer.from(text, "utf8"), { level: 6 });
  const out = Buffer.alloc(gz.length + MAGIC.length);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  gz.copy(out, MAGIC.length);
  return out;
}

/**
 * 解压：明文 TEXT 原样返回；压缩 BLOB（魔数）gunzip；异常 BLOB 按 utf8 兜底。
 * 幂等（对明文/压缩结果均可再调用）。
 */
export function decompressChunk(data: string | Uint8Array | null): string {
  if (data === null) return "";
  if (typeof data === "string") return data;
  if (data.length >= MAGIC.length && data[0] === MAGIC[0] && data[1] === MAGIC[1]) {
    return gunzipSync(Buffer.from(data.subarray(MAGIC.length))).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

/** 该文本是否值得压缩（长度达标；压缩后应更小才替换）。 */
export function shouldCompress(text: string): boolean {
  if (text.length < MIN_COMPRESS_CHARS) return false;
  const compressed = compressChunk(text);
  // 压缩后（含魔数）必须更小，否则保留明文。
  return compressed.length < Buffer.byteLength(text, "utf8");
}

/**
 * 注册 sati_uncompress() SQL 函数（deterministic：同一输入恒同输出，SQLite
 * 可缓存）。使用方：case-law-search / knowledge-law-search / embedding-consistency。
 */
export function registerChunkUncompress(db: DatabaseSync): void {
  db.function("sati_uncompress", { deterministic: true }, (value: unknown) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return decompressChunk(value);
    return String(value);
  });
}
