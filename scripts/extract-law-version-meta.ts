#!/usr/bin/env tsx
/**
 * 法律版本沿革元数据提取（A2 离线治理工具）。
 *
 * 从 raw md 目录（宝宸知识库_Raw/法律法规司法解释_md/）批量读取法规文档头部
 * （`# 法律名` 与 `<!-- INFO END -->` 之间），提取立法事件时间线
 * （通过/公布/修正/修订/废止），判定每部法律的效力状态，输出
 * law-version-meta.json（供 src/knowledge/legal/version-meta.ts 运行时加载）。
 *
 * Sati 只读消费外部 knowledge.db，本脚本产出的 meta 是 Sati 侧独立缓存资产；
 * 文件缺失时检索优雅降级（status/supersededBy 留空），不阻塞。
 *
 * Usage:
 *   pnpm tsx scripts/extract-law-version-meta.ts [raw-md-dir] [output-path]
 *   默认 raw-md-dir  = 宝宸知识库_Raw/法律法规司法解释_md/
 *   默认 output-path = ~/.sati/knowledge/law-version-meta.json
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeEffectiveStatus,
  defaultLawVersionMetaPath,
  extractVersionEvents,
  type LawVersionMeta,
} from "../src/knowledge/legal/version-meta.js";

/** 默认 raw md 目录（宝宸知识库_Raw 项目侧，法规/司法解释最新版）。 */
const DEFAULT_RAW_DIR = "/Users/xujian/projects/宝宸知识库_Raw/法律法规司法解释_md";

/** 解析文件名尾部日期（`专利代理条例_20181106.md` → "2018-11-06"）；无则 null。 */
function dateFromFilename(filename: string): string | null {
  const m = /_(\d{4})(\d{2})(\d{2})\.md$/.exec(filename);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 从单个 md 文件提取版本元数据（头部解析失败时以文件名日期兜底，status 待核验）。 */
function extractFromFile(filePath: string): LawVersionMeta | null {
  const content = readFileSync(filePath, "utf8");
  const titleMatch = /^#\s+(.+)$/m.exec(content);
  const name = titleMatch?.[1]?.trim();
  if (!name) return null;

  const infoEnd = content.indexOf("<!-- INFO END -->");
  const header = infoEnd >= 0 ? content.slice(0, infoEnd) : content;
  const events = extractVersionEvents(header);

  const fallbackDate = dateFromFilename(filePath);
  if (events.length === 0) {
    return {
      name,
      status: fallbackDate ? "待核验" : "待核验",
      promulgatedDate: fallbackDate ?? "",
      events: [],
    };
  }

  const latestEvent = events[events.length - 1]!;
  const status = latestEvent.kind === "废止" ? "已废止" : computeEffectiveStatus(events.map(e => e.date));
  return { name, status, promulgatedDate: latestEvent.date, events };
}

function main(): void {
  const rawDir = process.argv[2] ?? DEFAULT_RAW_DIR;
  const outputPath = process.argv[3];
  const out = outputPath ?? defaultLawVersionMetaPath();

  let files: string[];
  try {
    files = readdirSync(rawDir)
      .filter(f => f.endsWith(".md"))
      .sort();
  } catch (error) {
    console.error(`无法读取 raw md 目录: ${rawDir}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const metas: LawVersionMeta[] = [];
  for (const file of files) {
    const meta = extractFromFile(join(rawDir, file));
    if (meta) metas.push(meta);
  }
  writeFileSync(out, `${JSON.stringify(metas, null, 2)}\n`, "utf8");
  console.log(`提取 ${metas.length} 部法律版本元数据 → ${out}`);
  const withEvents = metas.filter(m => m.events.length > 0).length;
  console.log(`其中 ${withEvents} 部解析到立法事件时间线，${metas.length - withEvents} 部头部无事件（待核验）`);
}

main();
