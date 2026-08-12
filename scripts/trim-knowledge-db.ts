#!/usr/bin/env tsx
/**
 * knowledge.db 裁剪版生成器（应对传输 7G 不便的分发场景）。
 *
 * 体积实测（7.0G 源库）：VACUUM 去碎片（自由页约 1.7G）→ 4.8G；
 * 再删 embeddings（633MB 向量 + 索引）→ 4.2G。判例/法规正文
 * （chunks 1.4G + docs_fts trigram 索引 2.4G）是检索核心，默认保留。
 *
 * 两档裁剪：
 *   默认      —— 保留全部全文/图谱能力，仅去 embeddings（语义召回关闭，
 *                 FTS/关键词检索不受影响）：7.0G → ~4.2G（-40%）
 *   --no-fts  —— 额外删除 FTS5 索引（docs_fts/kg_nodes_fts），检索降级
 *                 LIKE（无 BM25/trigram 模糊匹配）：7.0G → ~1.6G（-77%）
 *   --keep-embeddings —— 仅 VACUUM 去碎片，保留完整能力：7.0G → ~4.8G
 *   --migrate-int8 —— 将 embeddings float32 向量量化为 int8 存储（加 scale
 *                 列），语义检索质量不变（检索链路本就 int8 量化），
 *                 向量存储 4096B/条 → 1024B/条（-75%）：7.0G → ~4.5G（-36%）
 *   --compress-chunks —— 将 chunks.content 长正文（≥800 字符且压缩有收益）
 *                 转 gzip BLOB（魔数 SC 前缀），读取端 sati_uncompress() 透明
 *                 解压，FTS contentless 索引与检索质量不受影响；小 chunk 与
 *                 知识笔记写入的明文保持原样：7.0G → ~4.1G（-41%）
 *
 * 用法：
 *   pnpm tsx scripts/trim-knowledge-db.ts \
 *     [--input ~/.sati/knowledge/knowledge.db] \
 *     [--output ~/.sati/knowledge/knowledge-lite.db] \
 *     [--keep-embeddings] \
 *     [--migrate-int8] \
 *     [--compress-chunks] \
 *     [--rebuild-kg-fts] \
 *     [--no-fts] \
 *     [--skip-verify]
 *
 * 输出默认与输入同目录的 knowledge-lite.db，并打印体积对比、保留表
 * 行数与 Sati 组件验证结果（KgStore 双 schema / 法规 / 判例 / 语义开关）。
 * 运行耗时约 0.5-5 分钟（取决于磁盘速度），全程只读源库。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { quantizeInt8 } from "../src/context/vector/cosine.js";
import { compressChunk, shouldCompress } from "../src/knowledge/shared/chunk-compression.js";
import { KgStore } from "../src/knowledge/shared/kg-store.js";
import { KnowledgeLawSearch } from "../src/knowledge/legal/knowledge-law-search.js";
import { CaseLawSearchEngine } from "../src/knowledge/case-law/case-law-search.js";
import { KnowledgeEmbeddingSearch } from "../src/knowledge/shared/knowledge-embeddings.js";

type Args = {
  input: string;
  output: string;
  keepEmbeddings: boolean;
  migrateInt8: boolean;
  rebuildKgFts: boolean;
  compressChunks: boolean;
  noFts: boolean;
  skipVerify: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const i = argv.indexOf(key);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const input = get("--input") ?? join(homedir(), ".sati", "knowledge", "knowledge.db");
  const output = get("--output") ?? join(dirname(input), "knowledge-lite.db");
  const migrateInt8 = argv.includes("--migrate-int8");
  return {
    input,
    output,
    // --migrate-int8 隐含保留 embeddings（迁移语义即保留语义能力），
    // 单独使用 --migrate-int8 不应静默变成"删 embeddings + 忽略迁移"。
    keepEmbeddings: argv.includes("--keep-embeddings") || migrateInt8,
    migrateInt8,
    rebuildKgFts: argv.includes("--rebuild-kg-fts"),
    compressChunks: argv.includes("--compress-chunks"),
    noFts: argv.includes("--no-fts"),
    skipVerify: argv.includes("--skip-verify"),
  };
}

/**
 * chunks.content 应用级压缩：逐行读取，长度达标且压缩后更小的改为
 * gzip+魔数 BLOB（明文 TEXT 保留原样）。读取端经 sati_uncompress() 解压，
 * FTS contentless 索引不受影响。返回压缩的条数。
 */
function compressChunksTable(db: DatabaseSync): number {
  const select = db.prepare("SELECT id, content FROM chunks");
  const update = db.prepare("UPDATE chunks SET content = ? WHERE id = ?");
  let compressed = 0;
  // iterate() 流式逐行（select.all() 会物化整表，7G 级库内存不可控）。
  for (const row of select.iterate() as Iterable<{ id: number; content: string | Uint8Array }>) {
    // 已是压缩 BLOB（重复运行）跳过；TEXT 明文才评估压缩。
    if (typeof row.content !== "string") {
      continue;
    }
    if (shouldCompress(row.content)) {
      update.run(compressChunk(row.content), row.id);
      compressed += 1;
    }
    if (compressed > 0 && compressed % 5000 === 0) {
      console.log(`    已压缩 ${compressed.toLocaleString()} 条…`);
    }
  }
  return compressed;
}

/** 单条 float32 向量 BLOB → int8 BLOB + scale。 */
function quantizeVectorBlob(raw: Uint8Array, dimensions: number): { blob: Uint8Array; scale: number } {
  const view = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const floats = new Float32Array(dimensions);
  floats.set(view.subarray(0, dimensions));
  const { values, scale } = quantizeInt8(floats);
  return { blob: new Uint8Array(values.buffer, values.byteOffset, values.byteLength), scale };
}

/**
 * embeddings 表 float32 → int8 迁移：新增 scale 列，逐批（5000 条/批）量化写回。
 * 返回迁移的条数。源向量必须恰好 dim*4 字节（float32）；异常行跳过并计数。
 */
function migrateEmbeddingsInt8(db: DatabaseSync, dimensions: number): { migrated: number; skipped: number } {
  // scale 列幂等：已存在（重复运行）则跳过 ALTER。
  const cols = db.prepare("SELECT name FROM pragma_table_info('embeddings')").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === "scale")) {
    db.exec("ALTER TABLE embeddings ADD COLUMN scale REAL NOT NULL DEFAULT 1.0");
  }

  const select = db.prepare("SELECT id, vector FROM embeddings");
  const update = db.prepare("UPDATE embeddings SET vector = ?, scale = ? WHERE id = ?");
  const expected = dimensions * 4;
  let migrated = 0;
  let skipped = 0;
  // iterate() 流式逐行（select.all() 会物化整表，7G 级库内存不可控）。
  for (const row of select.iterate() as Iterable<{ id: number; vector: Uint8Array }>) {
    if (row.vector.byteLength === expected) {
      const { blob, scale } = quantizeVectorBlob(row.vector, dimensions);
      update.run(blob, scale, row.id);
      migrated += 1;
    } else {
      // 已是 int8（1024B）或异常长度：不动，计数跳过。
      skipped += 1;
    }
    if (migrated > 0 && migrated % 5000 === 0) {
      console.log(`    已迁移 ${migrated.toLocaleString()} 条…`);
    }
  }
  return { migrated, skipped };
}

/**
 * kg_nodes_fts 重建为 contentless_delete=1（与 docs_fts 一致），减少删除后的
 * 索引碎片；回填 name/title/content。用于知识库被增量更新过的场景。
 */
function rebuildKgFtsIndex(db: DatabaseSync): void {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kg_nodes_fts'").get();
  if (!has) {
    console.log("    kg_nodes_fts 不存在，跳过重建。");
    return;
  }
  // contentless_delete 是表级选项，无法 ALTER——需 DROP 重建回填。
  // 回填在单个事务内：中断时 DROP 与回填原子回滚，不会留下空索引。
  db.exec("BEGIN");
  try {
    db.exec(`DROP TABLE IF EXISTS kg_nodes_fts;
CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(
  name, title, content,
  tokenize='trigram',
  content='',
  contentless_delete=1
);`);
    // rowid 与 kg_nodes 的 rowid 对齐（contentless 表 rowid 必须显式对应）。
    const rows = db
      .prepare("SELECT rowid, name, COALESCE(title, '') AS title, COALESCE(content, '') AS content FROM kg_nodes")
      .all() as Array<{ rowid: number; name: string; title: string; content: string }>;
    const insert = db.prepare("INSERT INTO kg_nodes_fts(rowid, name, title, content) VALUES (?, ?, ?, ?)");
    for (const r of rows) {
      insert.run(r.rowid, r.name, r.title, r.content);
    }
    db.exec("COMMIT");
    console.log(`    已重建 kg_nodes_fts 并回填 ${rows.length.toLocaleString()} 节点`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** 逐表行数统计（保留的核心表）。 */
function countRows(db: DatabaseSync, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
    return row.c;
  } catch {
    return -1;
  }
}

function sqlQuote(path: string): string {
  return path.replace(/'/g, "''");
}

function main(): void {
  const { input, output, keepEmbeddings, migrateInt8, rebuildKgFts, compressChunks, noFts, skipVerify } = parseArgs(
    process.argv.slice(2),
  );
  console.log(`输入: ${input}`);
  console.log(`输出: ${output}`);
  const removed: string[] = [];
  if (!keepEmbeddings) removed.push("embeddings（语义召回关闭，FTS/关键词不受影响）");
  if (noFts) removed.push("FTS5 索引（docs_fts/kg_nodes_fts，全文检索降级 LIKE）");
  console.log(`去除: ${removed.length > 0 ? removed.join("；") : "无（仅 VACUUM 去碎片）"}`);
  if (migrateInt8) console.log("迁移: embeddings float32 → int8（+scale 列，语义质量不变）");
  if (compressChunks) console.log("压缩: chunks.content 应用级 gzip（读取端透明解压，FTS 不受影响）");
  if (rebuildKgFts) console.log("重建: kg_nodes_fts（contentless_delete=1）");

  if (!existsSync(input)) {
    console.error(`错误: 输入库不存在（${input}）。请用 --input 指定 knowledge.db 路径。`);
    process.exit(1);
  }
  const sourceBytes = statSync(input).size;
  if (input === output) {
    console.error("错误: --output 与 --input 相同路径会破坏源库，请指定不同输出路径。");
    process.exit(1);
  }

  // 1. VACUUM INTO：SQLite 原子生成紧凑副本（自动合并 WAL、回收自由页碎片）。
  //    目标文件必须不存在。
  if (existsSync(output)) {
    console.log(`输出已存在，覆盖: ${output}`);
    rmSync(output);
  }
  console.log("\n[1/3] VACUUM INTO 生成紧凑副本（7G 级库约 1-4 分钟）…");
  {
    const db = new DatabaseSync(input, { readOnly: true });
    try {
      db.exec(`VACUUM INTO '${sqlQuote(output)}'`);
    } finally {
      db.close();
    }
  }

  // 2. 可选迁移：embeddings float32 → int8（--migrate-int8 在 parseArgs 中已
  //    隐含 keepEmbeddings；必须在删除 embeddings 之前执行）。
  {
    const db = new DatabaseSync(output);
    try {
      if (migrateInt8 && keepEmbeddings) {
        // 表不存在时 prepare 即抛错，须先探测（与 rebuildKgFtsIndex 的
        // sqlite_master 检查一致），避免对已删 embeddings 的 lite 库崩溃。
        const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embeddings'").get();
        if (!hasTable) {
          console.log("[2/4] embeddings 表不存在，跳过迁移。");
        } else {
          const meta = db
            .prepare("SELECT dim, COUNT(*) AS c FROM embeddings GROUP BY dim ORDER BY c DESC LIMIT 1")
            .get() as { dim: number; c: number } | undefined;
          if (meta && meta.c > 0) {
            console.log(`[2/4] 迁移 embeddings 至 int8（dim=${meta.dim}，共 ${meta.c.toLocaleString()} 条）…`);
            const { migrated, skipped } = migrateEmbeddingsInt8(db, meta.dim);
            console.log(`    完成：迁移 ${migrated.toLocaleString()} 条，跳过 ${skipped} 条（已 int8 或异常）`);
          } else {
            console.log("[2/4] embeddings 表为空，跳过迁移。");
          }
        }
      }

      // chunks 压缩：在删表之前执行。--no-fts 组合同样有效（LIKE 降级路径
      // 读取端 sati_uncompress() 已解压，压缩不损害降级检索）。
      if (compressChunks) {
        console.log("[3/4] 压缩 chunks.content（长 chunk 转 gzip BLOB）…");
        const n = compressChunksTable(db);
        console.log(`    完成：压缩 ${n.toLocaleString()} 条（其余明文保留）`);
      }

      const drops: string[] = [];
      if (!keepEmbeddings) {
        drops.push("embeddings", "ivf_index", "index_meta");
      }
      if (noFts) {
        // DROP 虚拟表会连带删除全部 shadow 表（docs_fts_data 等 ~2.5G）。
        drops.push("docs_fts", "kg_nodes_fts");
      }
      if (drops.length > 0) {
        console.log(`[3/4] 删除: ${drops.join(", ")}…`);
        db.exec(drops.map(t => `DROP TABLE IF EXISTS "${t}"`).join(";\n"));
      } else {
        console.log("[3/4] 无删除项（--keep-embeddings 且未 --no-fts）");
      }
      if (rebuildKgFts && !noFts && !drops.includes("kg_nodes_fts")) {
        console.log("[3/4] 重建 kg_nodes_fts（contentless_delete=1）…");
        rebuildKgFtsIndex(db);
      }
      // 4. 释放删表空间，输出库保持紧凑。
      console.log("[4/4] 二次 VACUUM 释放空间…");
      db.exec("VACUUM");
    } finally {
      db.close();
    }
  }

  // 统计与验证
  const outBytes = statSync(output).size;
  console.log("\n=== 结果 ===");
  console.log(`源库:   ${gb(sourceBytes)}（${sourceBytes > 0 ? sourceBytes.toLocaleString() : "?"} 字节）`);
  console.log(`裁剪版: ${gb(outBytes)}（-${Math.round((1 - outBytes / sourceBytes) * 100)}%）`);
  {
    const db = new DatabaseSync(output, { readOnly: true });
    try {
      console.log("\n保留表行数:");
      for (const t of ["kg_nodes", "kg_edges", "documents", "chunks"]) {
        const n = countRows(db, t);
        console.log(`  ${t.padEnd(12)} ${n >= 0 ? n.toLocaleString() : "（缺失）"}`);
      }
    } finally {
      db.close();
    }
  }

  if (skipVerify) {
    console.log("\n--skip-verify：跳过 Sati 组件验证。");
    return;
  }

  console.log("\n=== Sati 组件验证 ===");
  let failed = false;
  // 图谱：双 schema 应为 unified；FTS 模式随 --no-fts 变化（trigram / none→LIKE）
  try {
    const kg = new KgStore(output);
    console.log(`  KgStore schema=${kg.schemaKind()} fts=${kg.ftsMode()}${noFts ? "（预期 none，LIKE 降级）" : ""}`);
    const hit = kg.searchByKeyword("创造性", 1);
    console.log(`  KgStore 关键词检索: ${hit.length > 0 ? `命中 ${hit.length}（如 ${hit[0]?.name}）` : "无命中"}`);
    kg.close();
  } catch (error) {
    console.error(`  KgStore 验证失败: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
  // 法规：law_article 计数 > 0；FTS 可用性随 --no-fts 变化
  try {
    const law = new KnowledgeLawSearch(output);
    const n = law.count();
    const hits = law.search("新颖性", { limit: 1 });
    console.log(
      `  KnowledgeLawSearch count=${n} fts=${law.ftsAvailable} 检索: ${hits.length > 0 ? `命中 ${hits[0]?.name}` : "无命中"}`,
    );
    law.close();
  } catch (error) {
    console.error(`  KnowledgeLawSearch 验证失败: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
  // 判例：documents 计数 + 检索（FTS 用整句验证 trigram 分词；LIKE 用短词验证子串）
  try {
    const cs = new CaseLawSearchEngine(output);
    const n = cs.count();
    const query = noFts ? "创造性" : "创造性 三步法";
    const hits = cs.search(query, { limit: 1 });
    console.log(
      `  CaseLawSearchEngine count=${n} fts=${cs.ftsAvailable} 检索"${query}": ${hits.length > 0 ? `命中 ${hits[0]?.title}` : "无命中"}`,
    );
    cs.close();
  } catch (error) {
    console.error(`  CaseLawSearchEngine 验证失败: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
  // 语义：裁剪后 embeddings 表已删 → 构造失败（调用方兜底），语义路应关闭
  try {
    const emb = new KnowledgeEmbeddingSearch({ dbPath: output });
    console.log(`  KnowledgeEmbeddingSearch available=${emb.available}（${keepEmbeddings ? "保留" : "预期 false"}）`);
    emb.close();
  } catch {
    console.log(
      `  KnowledgeEmbeddingSearch available=false（embeddings 表${keepEmbeddings ? "不可用" : "已裁剪"}，语义路关闭，符合预期）`,
    );
  }

  if (failed) {
    console.error("\n验证存在失败项，请检查裁剪版完整性。");
    process.exit(1);
  }
  console.log("\n=== 传输清单 ===");
  console.log(`仅需传输 1 个文件: ${output}`);
  console.log("接收方接线: 放入 ~/.sati/knowledge/knowledge.db（自动探测），或设置 SATI_KNOWLEDGE_DB=<路径>。");
  console.log("无需再传 patent_kg.db / laws-full.db / vectors.db（legacy，已被 knowledge.db 取代）。");
  console.log(
    noFts
      ? "本裁剪档去除了 FTS5 索引：全文检索降级 LIKE（无 BM25 排序/trigram 模糊），关键词检索仍可用。"
      : "全文检索（FTS5 trigram + BM25）完整保留。",
  );
  console.log(
    keepEmbeddings
      ? "embeddings 已保留：接收方配置同源 bge-m3 后语义召回直接可用。"
      : "语义召回（embeddings）未包含：接收方配置 Ollama bge-m3 后自动启用；未配置则 FTS/关键词检索正常。",
  );
}

main();
