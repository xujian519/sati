/**
 * 平台可信度判定（移植自 Mady domains/evidence/credibility.go）。
 *
 * 根据证据来源 URI 的域名判定可信度等级（政府/法院/专利局 > 学术 > 行业权威
 * > 新闻媒体 > 内容平台 > 聚合 > 社交/未知），并映射为 0-1 分数。
 * 使用 URL 解析取 hostname 而非子串匹配，避免误匹配。
 */

import type { CredibilityLevel } from "./types.js";
import { cleanEvidenceURI } from "./date.js";

/** 政府/法院/专利局官方域名后缀。 */
const GOV_SUFFIXES: readonly string[] = [
  ".gov.cn",
  ".gov",
  ".court.gov.cn",
  ".cnipa.gov.cn",
  ".sipo.gov.cn",
  ".epo.org",
  ".wipo.int",
  ".uspto.gov",
  ".jpo.go.jp",
  ".kpo.go.kr",
  ".ipo.gov.uk",
];

/** 学术数据库/教育机构域名后缀。 */
const ACADEMIC_SUFFIXES: readonly string[] = [
  ".edu.cn",
  ".edu",
  ".ac.cn",
  ".cnki.net",
  ".wanfangdata.com.cn",
  ".cqvip.com",
  ".ieee.org",
  ".acm.org",
  ".springer.com",
  ".elsevier.com",
  ".nature.com",
  ".sciencemag.org",
];

/** 行业权威平台域名（精确匹配或子域后缀）。 */
const AUTHORITY_DOMAINS: readonly string[] = [
  "patents.google.com",
  "patentscope.wipo.int",
  "globaldossier.net",
  "darts-ip.com",
];

/** 正规新闻媒体域名后缀。 */
const NEWS_SUFFIXES: readonly string[] = [
  ".xinhuanet.com",
  ".people.com.cn",
  ".chinanews.com.cn",
  ".bbc.com",
  ".bbc.co.uk",
  ".reuters.com",
  ".ap.org",
  ".nikkei.com",
  ".ft.com",
  ".wsj.com",
];

/** 内容平台域名（微信公众平台等）。 */
const CONTENT_DOMAINS: readonly string[] = ["mp.weixin.qq.com"];

/** 搜索引擎/聚合平台域名。 */
const AGGREGATOR_DOMAINS: readonly string[] = [
  "baidu.com",
  "google.com",
  "bing.com",
  "toutiao.com",
  "sohu.com",
  "sina.com.cn",
  "163.com",
  "qq.com",
];

function matchesSuffix(hostname: string, suffix: string): boolean {
  return hostname.endsWith(suffix) || hostname === suffix.replace(/^\./, "");
}

function isGovernmentDomain(hostname: string): boolean {
  return GOV_SUFFIXES.some(suffix => matchesSuffix(hostname, suffix));
}

function isAcademicDomain(hostname: string): boolean {
  return ACADEMIC_SUFFIXES.some(suffix => matchesSuffix(hostname, suffix));
}

function isAuthorityDomain(hostname: string): boolean {
  return AUTHORITY_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isNewsMedia(hostname: string): boolean {
  return NEWS_SUFFIXES.some(suffix => matchesSuffix(hostname, suffix));
}

function isContentPlatform(hostname: string): boolean {
  return CONTENT_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isAggregator(hostname: string): boolean {
  return AGGREGATOR_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

/** 根据来源 URI 判定平台可信度等级；URI 空/解析失败回退 low。 */
export function platformCredibility(uri: string | undefined): CredibilityLevel {
  if (uri === undefined || uri === "") return "low";
  let parsed: URL;
  try {
    parsed = new URL(cleanEvidenceURI(uri));
  } catch {
    // 非法 URI（解析失败）→ 回退 low 可信度
    return "low";
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isGovernmentDomain(hostname) || isAcademicDomain(hostname)) return "high";
  if (isAuthorityDomain(hostname) || isContentPlatform(hostname)) return "medium_high";
  if (isNewsMedia(hostname) || isAggregator(hostname)) return "medium";
  return "low";
}

/** 可信度等级 → 0-1 分数（对齐 Mady CredibilityToScore）。 */
export function credibilityToScore(level: CredibilityLevel): number {
  switch (level) {
    case "high":
      return 0.95;
    case "medium_high":
      return 0.75;
    case "medium":
      return 0.55;
    case "low":
      return 0.25;
    default:
      return 0.25;
  }
}

/** 平台分类标签（人读）。 */
export function platformCategory(uri: string | undefined): string {
  if (uri === undefined || uri === "") return "unknown";
  let hostname: string;
  try {
    hostname = new URL(cleanEvidenceURI(uri)).hostname.toLowerCase();
  } catch {
    // 非法 URI（解析失败）→ 回退 unknown 分类
    return "unknown";
  }
  if (isGovernmentDomain(hostname)) return "政府/法院/专利局官方";
  if (isAcademicDomain(hostname)) return "学术数据库";
  if (isAuthorityDomain(hostname)) return "行业权威平台";
  if (isNewsMedia(hostname)) return "正规新闻媒体";
  if (isContentPlatform(hostname)) return "内容平台";
  if (isAggregator(hostname)) return "搜索/聚合平台";
  return "社交/自媒体/未知";
}

/** 互联网公开意图：注册/付费墙平台标记为受限，其余推定对公众开放。 */
export function evaluatePublicIntent(uri: string | undefined): "public" | "restricted" {
  if (uri === undefined || uri === "") return "public";
  let hostname: string;
  try {
    hostname = new URL(cleanEvidenceURI(uri)).hostname.toLowerCase();
  } catch {
    // 非法 URI（解析失败）→ 推定对公众开放
    return "public";
  }
  const restrictedDomains = ["wsj.com", "ft.com", "nikkei.com", "springer.com", "elsevier.com"];
  if (restrictedDomains.some(d => hostname === d || hostname.endsWith(`.${d}`))) return "restricted";
  return "public";
}
