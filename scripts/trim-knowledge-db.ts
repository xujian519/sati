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
 *
 * 用法：
 *   pnpm tsx scripts/trim-knowledge-db.ts \
 *     [--input ~/.sati/knowledge/knowledge.db] \
 *     [--output ~/.sati/knowledge/knowledge-lite.db] \
 *     [--keep-embeddings] \
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
import { KgStore } from "../src/knowledge/shared/kg-store.js";
import { KnowledgeLawSearch } from "../src/knowledge/legal/knowledge-law-search.js";
import { CaseLawSearchEngine } from "../src/knowledge/case-law/case-law-search.js";
import { KnowledgeEmbeddingSearch } from "../src/knowledge/shared/knowledge-embeddings.js";

type Args = {
  input: string;
  output: string;
  keepEmbeddings: boolean;
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
  return {
    input,
    output,
    keepEmbeddings: argv.includes("--keep-embeddings"),
    noFts: argv.includes("--no-fts"),
    skipVerify: argv.includes("--skip-verify"),
  };
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
  const { input, output, keepEmbeddings, noFts, skipVerify } = parseArgs(process.argv.slice(2));
  console.log(`输入: ${input}`);
  console.log(`输出: ${output}`);
  const removed: string[] = [];
  if (!keepEmbeddings) removed.push("embeddings（语义召回关闭，FTS/关键词不受影响）");
  if (noFts) removed.push("FTS5 索引（docs_fts/kg_nodes_fts，全文检索降级 LIKE）");
  console.log(`去除: ${removed.length > 0 ? removed.join("；") : "无（仅 VACUUM 去碎片）"}`);

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

  // 2. 删除可选表：embeddings 相关（默认）与 FTS5 索引（--no-fts）。
  {
    const db = new DatabaseSync(output);
    try {
      const drops: string[] = [];
      if (!keepEmbeddings) {
        drops.push("embeddings", "ivf_index", "index_meta");
      }
      if (noFts) {
        // DROP 虚拟表会连带删除全部 shadow 表（docs_fts_data 等 ~2.5G）。
        drops.push("docs_fts", "kg_nodes_fts");
      }
      if (drops.length > 0) {
        console.log(`[2/3] 删除: ${drops.join(", ")}…`);
        db.exec(drops.map(t => `DROP TABLE IF EXISTS "${t}"`).join(";\n"));
      } else {
        console.log("[2/3] 无删除项（--keep-embeddings 且未 --no-fts）");
      }
      // 3. 释放删表空间，输出库保持紧凑。
      console.log("[3/3] 二次 VACUUM 释放空间…");
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
