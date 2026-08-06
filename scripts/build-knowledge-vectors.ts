#!/usr/bin/env tsx
/**
 * ⚠️ DEPRECATED（2026-08）——不再作为主路径。
 *
 * 已被 knowledge.db embeddings 复用取代（见 docs/design/import-xiaonuo-knowledge.md）：
 * 语义召回直接读取 XiaoNuo 管道产物的 `knowledge.db`（embeddings 表 144K 向量），
 * 无需重新 embedding；KG 节点不建向量（FTS + 图谱检索），法条走 knowledge.db
 * law_article 文档。本脚本保留仅供 legacy 场景/显式 SATI_VECTORS_DB 使用。
 *
 * KG / 法条离线向量索引生成器（阶段 B）。
 *
 * 读取 patent_kg.db（nodes 表）与 laws 库（law 表），长文分块后逐块 embed，
 * int8 量化写入 vectors.db（schema 见 src/knowledge/shared/vector-db-writer.ts）。
 * 运行时由 VectorDbSearch 消费，为 PatentMemoryProvider / LegalMemoryProvider
 * 提供 KG/法条语义召回路。
 *
 * 用法：
 *   pnpm tsx scripts/build-knowledge-vectors.ts \
 *     --embedding-url http://localhost:11434/v1 \
 *     --embedding-model bge-m3 \
 *     --corpus kg,law \
 *     [--out ~/.sati/knowledge/vectors.db] \
 *     [--chunk-chars 1200] [--overlap 200] [--batch-size 32] \
 *     [--limit 500] [--force]
 *
 * 数据路径沿用 SATI_KNOWLEDGE_DIR / SATI_PATENT_KG_DB / SATI_LAW_DB / SATI_VECTORS_DB。
 * 增量：文档 text_hash 未变化则跳过；--force 强制重建该语料全部文档。
 *
 * 预估：KG 116K 文档 × 平均 1-2 chunk，bge-m3 本地约 50-100ms/条，
 * 首次全量约 30-90 分钟（可后台运行，按 --limit 分段验证）。
 */

import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../src/context/vector/jsonl-store.js";
import { resolveEmbeddingClient, type EmbeddingClient } from "../src/model/embedding/index.js";
import type { PilotMemoryEmbeddingConfig } from "../src/pilot/config/types.js";
import { resolveKnowledgeDbPaths } from "../src/knowledge/index.js";
import {
  chunkText,
  deleteDocVectors,
  insertVectorChunk,
  listIndexedDocHashes,
  openVectorsDbWriter,
  quantizeInt8,
  setCorpusMeta,
  type CorpusMeta,
} from "../src/knowledge/shared/vector-db-writer.js";

type CliArgs = {
  url: string;
  model: string;
  apiKey: string;
  corpora: string[];
  out: string;
  chunkChars: number;
  overlap: number;
  batchSize: number;
  limit: number;
  force: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: "http://localhost:11434/v1",
    model: "bge-m3",
    apiKey: "ollama",
    corpora: ["kg", "law"],
    out: "",
    chunkChars: 1200,
    overlap: 200,
    batchSize: 32,
    limit: 0,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    const value = argv[i + 1];
    const take = (): string => {
      if (!value) throw new Error(`--${key} 需要参数值`);
      i += 1;
      return value;
    };
    if (key === "--embedding-url") args.url = take();
    else if (key === "--embedding-model") args.model = take();
    else if (key === "--api-key") args.apiKey = take();
    else if (key === "--corpus")
      args.corpora = take()
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    else if (key === "--out") args.out = take();
    else if (key === "--chunk-chars") args.chunkChars = Number.parseInt(take(), 10) || 1200;
    else if (key === "--overlap") args.overlap = Number.parseInt(take(), 10) || 200;
    else if (key === "--batch-size") args.batchSize = Number.parseInt(take(), 10) || 32;
    else if (key === "--limit") args.limit = Number.parseInt(take(), 10) || 0;
    else if (key === "--force") args.force = true;
    else if (key === "--help" || key === "-h") {
      console.log(
        [
          "用法: pnpm tsx scripts/build-knowledge-vectors.ts [--embedding-url URL] [--embedding-model MODEL]",
          "      [--corpus kg,law] [--out PATH] [--chunk-chars N] [--overlap N]",
          "      [--batch-size N] [--limit N] [--force]",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

type SourceDoc = { id: string; text: string };

/** 遍历 KG 节点（nodes 表）作为文档源。 */
async function* kgDocs(dbPath: string, limit: number): AsyncGenerator<SourceDoc> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const pageSize = 5000;
    const stmt = db.prepare("SELECT id, name, title, content FROM nodes LIMIT ? OFFSET ?");
    let offset = 0;
    let count = 0;
    while (limit === 0 || count < limit) {
      const remaining = limit === 0 ? pageSize : Math.min(pageSize, limit - count);
      const rows = stmt.all(remaining, offset) as Array<{
        id: string;
        name: string | null;
        title: string | null;
        content: string | null;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const text = [row.name, row.title, row.content]
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
          .join("\n");
        yield { id: row.id, text };
        count += 1;
        if (limit > 0 && count >= limit) break;
      }
      offset += rows.length;
    }
  } finally {
    db.close();
  }
}

/** 遍历法律条文（非失效，按 name 去重保留最新发布版）作为文档源。 */
async function* lawDocs(dbPath: string, limit: number): AsyncGenerator<SourceDoc> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const pageSize = 5000;
    const stmt = db.prepare(
      "SELECT id, name, content FROM law WHERE (expired = 0 OR expired IS NULL) ORDER BY name, publish DESC LIMIT ? OFFSET ?",
    );
    const seen = new Set<string>();
    let offset = 0;
    let count = 0;
    while (limit === 0 || count < limit) {
      const remaining = limit === 0 ? pageSize : Math.min(pageSize, limit - count);
      const rows = stmt.all(remaining, offset) as Array<{ id: string; name: string; content: string | null }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (seen.has(row.name)) continue; // 同名多版本仅取最新（publish DESC 首个）
        seen.add(row.name);
        const text = `${row.name}\n${row.content ?? ""}`;
        yield { id: row.id, text };
        count += 1;
        if (limit > 0 && count >= limit) break;
      }
      offset += rows.length;
    }
  } finally {
    db.close();
  }
}

async function buildCorpus(
  args: CliArgs,
  out: string,
  corpus: string,
  docs: AsyncGenerator<SourceDoc>,
  client: EmbeddingClient,
): Promise<void> {
  const outDb = openVectorsDbWriter(out);
  try {
    const meta = {
      corpus,
      dimensions: client.dimensions || 0,
      model: args.model,
      chunkChars: args.chunkChars,
      chunkOverlap: args.overlap,
      builtAt: new Date().toISOString(),
    } satisfies CorpusMeta;
    if (meta.dimensions <= 0) {
      throw new Error(`无法确定 embedding 维度（${args.model} 首次响应为空），请检查端点。`);
    }
    setCorpusMeta(outDb, meta);

    const indexedHashes = args.force ? new Map<string, string>() : listIndexedDocHashes(outDb, corpus);
    let indexed = 0;
    let skipped = 0;
    let batchTexts: string[] = [];
    let batchDocIds: string[] = [];
    let batchChunkIdx: number[] = [];
    let batchDocHashes: string[] = [];

    const flushBatchAsync = async (): Promise<void> => {
      if (batchTexts.length === 0) return;
      const vectors = await client.embed(batchTexts);
      outDb.exec("BEGIN");
      for (let i = 0; i < batchTexts.length; i += 1) {
        const floatVec = Float32Array.from(vectors[i] ?? []);
        if (floatVec.length !== meta.dimensions) {
          throw new Error(`embedding 维度不匹配：期望 ${meta.dimensions}，实际 ${floatVec.length}`);
        }
        const { values, scale } = quantizeInt8(floatVec);
        insertVectorChunk(outDb, corpus, batchDocIds[i]!, batchChunkIdx[i]!, values, batchDocHashes[i]!, scale);
      }
      outDb.exec("COMMIT");
      indexed += batchTexts.length;
      batchTexts = [];
      batchDocIds = [];
      batchChunkIdx = [];
      batchDocHashes = [];
    };

    let docCount = 0;
    for await (const doc of docs) {
      docCount += 1;
      const chunks = chunkText(doc.text, args.chunkChars, args.overlap);
      if (chunks.length === 0) continue;
      const textHash = sha256Text(doc.text);
      if (indexedHashes.get(doc.id) === textHash) {
        skipped += 1;
        continue;
      }
      deleteDocVectors(outDb, corpus, doc.id);
      chunks.forEach((chunk, chunkIndex) => {
        batchTexts.push(chunk);
        batchDocIds.push(doc.id);
        batchChunkIdx.push(chunkIndex);
        batchDocHashes.push(textHash);
      });
      if (batchTexts.length >= args.batchSize) await flushBatchAsync();

      if (docCount % 1000 === 0) {
        console.log(`[${corpus}] 已处理 ${docCount} 文档（新增 ${indexed} chunk / 跳过 ${skipped}）`);
      }
    }
    await flushBatchAsync();
    console.log(`[${corpus}] 完成：${docCount} 文档，新增 ${indexed} chunk，跳过 ${skipped}。`);
  } finally {
    outDb.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveKnowledgeDbPaths();
  const out = args.out || paths.vectorsDb || `${paths.dataDir}/vectors.db`;

  const embeddingConfig: PilotMemoryEmbeddingConfig = {
    enabled: true,
    model: args.model,
    baseUrl: args.url,
    apiKey: args.apiKey,
  };
  const client = resolveEmbeddingClient(embeddingConfig);
  if (!client) {
    console.error("无法构造 embedding client，退出。");
    process.exit(1);
  }
  console.log(`> embedding 端点: ${args.url} (${args.model})`);
  const healthy = await client.healthCheck();
  if (!healthy) {
    console.error(`> 端点不可用：${args.url}。请先启动服务（如 ollama serve && ollama pull bge-m3）。`);
    process.exit(1);
  }
  console.log(`> 端点健康检查通过，维度=${client.dimensions}。`);
  console.log(
    `> 输出: ${out}；语料: ${args.corpora.join(", ")}${args.force ? "（强制重建）" : "（增量）"}${args.limit ? `；limit=${args.limit}` : ""}`,
  );

  for (const corpus of args.corpora) {
    if (corpus === "kg") {
      if (!paths.patentKgDb) {
        console.warn(`[kg] patent_kg.db 不存在（${paths.patentKgDb}），跳过。`);
        continue;
      }
      await buildCorpus(args, out, "kg", kgDocs(paths.patentKgDb, args.limit), client);
    } else if (corpus === "law") {
      if (!paths.lawDb) {
        console.warn(`[law] laws 数据库不存在（${paths.lawDb}），跳过。`);
        continue;
      }
      await buildCorpus(args, out, "law", lawDocs(paths.lawDb, args.limit), client);
    } else {
      console.warn(`未知语料 ${corpus}（支持 kg/law），跳过。`);
    }
  }
  console.log("> 完成。重启 sati 后 KG/法条语义召回自动生效（探测 vectors.db）。");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
