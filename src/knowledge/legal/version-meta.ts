/**
 * src/knowledge/legal — 法律版本沿革元数据（A2）。
 *
 * 版本沿革 = 一部法律从首次公布到当前的所有立法事件（通过/修正/修订时间线）。
 * Sati 只读消费外部 knowledge.db，不在库上建 schema；版本时间线由离线脚本
 * scripts/extract-law-version-meta.ts 从 raw md 头部提取，落盘为
 * ~/.sati/knowledge/law-version-meta.json。本模块提供：
 *   - extractVersionEvents：从 raw md 头部文本解析立法事件序列（纯函数）；
 *   - computeEffectiveStatus：判定某版本在已知版本序列中的效力状态（纯函数）；
 *   - loadLawVersionMeta：运行时加载 meta 缓存文件（缺失/损坏优雅降级为空 map）。
 *
 * 检索侧（law-search-tool）同名多版本命中时调用 computeEffectiveStatus 判定
 * 版本位置状态（现行有效/已被修订），并叠加 expired 失效标志与
 * loadLawVersionMeta 的 meta 权威状态（已废止/待核验）完成 status 标注；
 * meta 文件缺失时优雅降级为纯动态标注。版本时间线（events）供模型判断
 * 法律修订历史。
 *
 * 纯函数、零依赖，可独立单测。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LawStatus } from "./types.js";

/** 立法事件类型（raw md 头部"通过/公布/修正/修订/废止"行；法律用"通过"，行政法规用"公布"）。 */
export type LawVersionEventKind = "通过" | "公布" | "修正" | "修订" | "废止";

/** 单条立法事件（如 "1984-03-12 通过" / "2020-10-17 第四次修正"）。 */
export type LawVersionEvent = {
  /** 事件日期 YYYY-MM-DD。 */
  date: string;
  /** 事件类型。 */
  kind: LawVersionEventKind;
  /** 事件原文摘要（如 "第十三届全国人民代表大会常务委员会第二十二次会议…第四次修正"）。 */
  summary: string;
};

/** 一部法律的版本沿革元数据（law-version-meta.json 条目）。 */
export type LawVersionMeta = {
  /** 法律名（如 "中华人民共和国专利法"）。 */
  name: string;
  /** 效力状态：现行有效 / 已被修订 / 已废止 / 待核验。 */
  status: LawStatus;
  /** 最近一版公布日期 YYYY-MM-DD。 */
  promulgatedDate: string;
  /** 立法事件时间线（按日期升序，含首次通过与历次修正/修订）。 */
  events: LawVersionEvent[];
};

/** 版本事件行匹配：`1984年3月12日 …通过/公布/修正/修订/废止`。 */
const VERSION_EVENT_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(.*?)(通过|公布|修正|修订|废止)$/;

/**
 * 从 raw md 头部文本（`# 法律名` 与 `<!-- INFO END -->` 之间）解析立法事件序列。
 * 非事件行（标题、空行）跳过；无任何事件时返回空数组。
 */
export function extractVersionEvents(header: string): LawVersionEvent[] {
  const events: LawVersionEvent[] = [];
  for (const line of header.split(/\r?\n/)) {
    const m = VERSION_EVENT_RE.exec(line.trim());
    if (m === null) continue;
    const [, year, month, day, summary, kind] = m;
    events.push({
      date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
      kind: kind as LawVersionEventKind,
      summary: summary.trim(),
    });
  }
  return events;
}

/**
 * 判定某法律版本在已知版本序列中的效力状态。
 *
 * @param versionDates 该法律全部已知版本的公布日期（YYYY-MM-DD，无序即可）。
 * @param target 待判定版本的公布日期；缺省时判定"最新版本"。
 * @returns "现行有效"（target 为最新版本）/"已被修订"（存在更新版本）/"待核验"（无版本信息）。
 *
 * 无"已废止"输入：废止状态由调用方在 events 尾部出现"废止"事件时单独标注。
 */
export function computeEffectiveStatus(versionDates: string[], target?: string): LawStatus {
  if (versionDates.length === 0) return "待核验";
  const latest = [...versionDates].sort((a, b) => a.localeCompare(b))[versionDates.length - 1]!;
  const targetDate = target ?? latest;
  return targetDate === latest ? "现行有效" : "已被修订";
}

/** 默认 meta 缓存文件路径（SATI_KNOWLEDGE_DIR 覆盖；读取失败时降级为空）。 */
export function defaultLawVersionMetaPath(): string {
  const override = process.env.SATI_KNOWLEDGE_DIR;
  return join(override ?? join(homedir(), ".sati", "knowledge"), "law-version-meta.json");
}

/**
 * 加载版本沿革元数据缓存文件（law-version-meta.json）。
 * 文件缺失/不可解析时返回空 map（优雅降级，不阻塞检索）。
 * key = 法律名（law-version-meta.json 数组按 name 索引）。
 */
export function loadLawVersionMeta(path?: string): Map<string, LawVersionMeta> {
  const metaPath = path ?? defaultLawVersionMetaPath();
  try {
    const raw = readFileSync(metaPath, "utf8");
    const entries = JSON.parse(raw) as unknown;
    if (!Array.isArray(entries)) return new Map();
    const map = new Map<string, LawVersionMeta>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const meta = entry as Partial<LawVersionMeta>;
      if (typeof meta.name === "string" && meta.name.length > 0) {
        map.set(meta.name, {
          name: meta.name,
          status: meta.status ?? "待核验",
          promulgatedDate: meta.promulgatedDate ?? "",
          events: Array.isArray(meta.events) ? meta.events : [],
        });
      }
    }
    return map;
  } catch {
    // 版本元数据 JSON 解析失败 → 返回空映射（降级，调用方按无沿革处理）。
    return new Map();
  }
}
