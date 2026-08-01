#!/usr/bin/env tsx
/**
 * embedding 语义检索增益验证脚本（阶段 A 验收工具）。
 *
 * 对每组问句输出对比表：wiki 关键词 vs wiki 语义 vs 法律 FTS vs KG 关键词，
 * 供人工评估 hit@5（语义是否补上关键词漏召回）。
 *
 * 用法：
 *   pnpm tsx scripts/embedding-baseline.ts \
 *     --embedding-url http://localhost:11434/v1 \
 *     --embedding-model bge-m3 \
 *     --top 5 \
 *     --queries ./queries.txt
 *   （queries 文件每行一个问句；缺省从 stdin 读取，Ctrl-D 结束）
 *
 * 数据路径沿用 SATI_KNOWLEDGE_DIR / SATI_PATENT_KG_DB / SATI_LAW_DB / SATI_WIKI_DIR
 * （与 src/knowledge/config.ts 一致）。
 *
 * 注意：wiki 语义索引首次运行会对全部 ~1548 张卡做全量 embed，
 * 本地 bge-m3 约需 1-3 分钟（结果持久化到 ~/.mady/knowledge/embeddings/wiki.jsonl，
 * 之后秒级）。
 */

import { createInterface } from "node:readline";
import { resolveEmbeddingClient, type EmbeddingClient } from "../src/model/embedding/index.js";
import type { PilotMemoryEmbeddingConfig } from "../src/pilot/config/types.js";
import { resolveKnowledgeDbPaths } from "../src/knowledge/index.js";
import { WikiCardLoader } from "../src/knowledge/patent/wiki-card-loader.js";
import { WikiCardVectorIndex } from "../src/knowledge/patent/wiki-card-vector-index.js";
import { LegalSearchEngine } from "../src/knowledge/legal/legal-search.js";
import { KgStore } from "../src/knowledge/shared/kg-store.js";

type CliArgs = {
  url: string;
  model: string;
  apiKey: string;
  top: number;
  queriesFile?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { url: "http://localhost:11434/v1", model: "bge-m3", apiKey: "ollama", top: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (key === "--embedding-url" && value) {
      args.url = value;
      i += 1;
    } else if (key === "--embedding-model" && value) {
      args.model = value;
      i += 1;
    } else if (key === "--api-key" && value) {
      args.apiKey = value;
      i += 1;
    } else if (key === "--top" && value) {
      args.top = Number.parseInt(value, 10) || 5;
      i += 1;
    } else if (key === "--queries" && value) {
      args.queriesFile = value;
      i += 1;
    } else if (key === "--help" || key === "-h") {
      console.log(
        [
          "用法: pnpm tsx scripts/embedding-baseline.ts [--embedding-url URL] [--embedding-model MODEL]",
          "      [--api-key KEY] [--top N] [--queries FILE]",
          "问句从 --queries 文件（每行一条）或 stdin 读取。",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

function printBlock(label: string, rows: string[]): void {
  console.log(`  [${label}]`);
  if (rows.length === 0) {
    console.log("    (无命中)");
    return;
  }
  for (const row of rows) {
    console.log(`    - ${row}`);
  }
}

async function readQueries(file?: string): Promise<string[]> {
  if (file) {
    const { readFileSync } = await import("node:fs");
    return readFileSync(file, "utf8")
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
  }
  const rl = createInterface({ input: process.stdin });
  const lines: string[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const embeddingConfig: PilotMemoryEmbeddingConfig = {
    enabled: true,
    model: args.model,
    baseUrl: args.url,
    apiKey: args.apiKey,
  };
  const client: EmbeddingClient | undefined = resolveEmbeddingClient(embeddingConfig);
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
  console.log("> 端点健康检查通过。");

  const paths = resolveKnowledgeDbPaths();
  console.log(`> 知识库路径: KG=${paths.patentKgDb ?? "无"} law=${paths.lawDb ?? "无"} wiki=${paths.wikiDir ?? "无"}`);

  const wikiLoader = paths.wikiDir ? new WikiCardLoader(paths.wikiDir) : undefined;
  const wikiSemantic = wikiLoader
    ? new WikiCardVectorIndex({
        loader: wikiLoader,
        client,
        storePath: `${paths.dataDir}/embeddings/wiki.jsonl`,
      })
    : undefined;
  if (wikiSemantic) {
    console.log(`> 预热 wiki 语义索引（${wikiLoader!.count()} 张卡）...`);
    await wikiSemantic.warmup();
    console.log(`> 预热完成，索引 ${wikiSemantic.size} 条。`);
  }

  const legalEngine = paths.lawDb ? new LegalSearchEngine(paths.lawDb) : undefined;
  const kgStore = paths.patentKgDb ? new KgStore(paths.patentKgDb) : undefined;

  const queries = await readQueries(args.queriesFile);
  if (queries.length === 0) {
    console.error("没有问句输入。");
    process.exit(1);
  }

  for (const query of queries) {
    console.log(`\n=== 问句: ${query} ===`);

    if (wikiLoader) {
      const keywordHits = wikiLoader.search(query, args.top).map(card => card.title);
      printBlock("wiki 关键词", keywordHits);

      if (wikiSemantic) {
        const semanticHits = await wikiSemantic.search(query, args.top);
        const rows = semanticHits.map(hit => {
          const meta = wikiLoader.getById(hit.id);
          return `${meta?.title ?? hit.id} (score=${hit.score.toFixed(4)})`;
        });
        printBlock("wiki 语义", rows);
      }
    }

    if (legalEngine) {
      const hits = legalEngine.search(query, { limit: args.top });
      printBlock(
        "法律 FTS",
        hits.map(hit => `${hit.name} (bm25=${hit.score.toFixed(2)})`),
      );
    }

    if (kgStore) {
      const nodes = kgStore.searchByKeyword(query, args.top);
      printBlock(
        "KG 关键词",
        nodes.map(node => node.name ?? node.title ?? node.id),
      );
    }
  }

  console.log("\n> 完成。请人工对比各路径 hit@5，评估语义召回是否补上关键词漏召回。");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
