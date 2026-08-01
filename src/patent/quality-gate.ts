/**
 * 输出级质量门禁（移植自 Mady guardrails/：disclaimer.go + deferred_persist.go + citation_gate.go）。
 *
 * 在 Agent 输出写入会话存储前调用：
 *   - 风险词命中 → 追加免责声明
 *   - 审批词命中 → 标记挂起（SuppressPersist 语义），消息暂存于 DeferredPersistQueue，
 *     人工审批通过后 Commit 入库、拒绝后 Discard
 *   - 法条引用核验（CitationGate）：R1 存在性（条号范围）+ R2 语境相关性（主题匹配），
 *     误报防线：Unknown / Unverifiable 一律放行
 *
 * 接入状态：已通过 PatentOutputGate + TurnRunner.persistDurableMessage 接入 Agent 输出流
 * （createAgentSession options.outputGate 注入；审批入口 AgentSession.approvePendingOutput/
 * rejectPendingOutput）。本文件的 processPatentOutput 亦被 PatentOutputGate 复用。
 *
 * 关键词表镜像：rules/patent/compliance.yaml 与本文件的 PATENT_RISK_KEYWORDS /
 * PATENT_APPROVAL_KEYWORDS / ABSOLUTE_PHRASES 互为声明式镜像（该资产按"对齐
 * quality-gate.ts"注释同步）。改任一处的关键词列表必须同步另一处；专利域
 * 规则引擎（src/rule）与 patent_eval 工具分别消费这两份。
 */

export const PATENT_DISCLAIMER =
  "本分析由 AI 辅助生成，不构成正式法律意见。专利申请和专利性判断应由具备资质的专利代理人或专利律师确认。";

/** 专利域风险词：命中即追加免责声明。 */
export const PATENT_RISK_KEYWORDS = [
  "侵权",
  "无效",
  "驳回",
  "不授权",
  "专利性",
  "自由实施",
  "新颖性结论",
  "创造性结论",
];

/** 专利域审批词：命中即挂起，需人工审批后才入库。 */
export const PATENT_APPROVAL_KEYWORDS = ["专利结论", "侵权判断", "有效性结论", "最终建议"];

/** 绝对化表述（P-A07 条款：回避绝对化表述）。 */
export const ABSOLUTE_PHRASES = ["绝对", "一定", "百分百", "毫无疑问", "必然"];

/**
 * 否定语境词与窗口（与 src/rule/runtime/RuleEngine.ts 的 NEGATION_WORDS 保持同步）：
 * 命中位置前窗口内出现这些词且无句号/分号分隔时视为否定性描述，不报告。
 */
const NEGATION_WORDS = ["防止", "避免", "不用于", "排除", "禁止", "不为", "非用于", "不构成", "区别于", "不属于"];
const NEGATION_WINDOW = 24;

/** 在命中位置前查找否定语境：窗口内出现否定词且无句号/分号分隔。 */
function hasNegationContext(text: string, matchStart: number): boolean {
  const start = Math.max(0, matchStart - NEGATION_WINDOW);
  const window = text.slice(start, matchStart);
  if (window.includes("。") || window.includes("；") || window.includes(";")) return false;
  return NEGATION_WORDS.some(word => window.includes(word));
}

/** 过滤否定语境中的命中：关键词至少一处非否定命中才报告（"不构成侵权"不误报，"不构成侵权但仍存在侵权风险"照报）。 */
function filterNegatedHits(keywords: string[], text: string): string[] {
  return keywords.filter(k => {
    let searchFrom = 0;
    while (true) {
      const index = text.indexOf(k, searchFrom);
      if (index < 0) return false;
      if (!hasNegationContext(text, index)) return true;
      searchFrom = index + k.length;
    }
  });
}

export type QualityGateResult = {
  /** 处理后的文本（可能已追加免责声明 / 存疑提示） */
  text: string;
  /** 命中风险词（已注入免责声明） */
  riskKeywordsHit: string[];
  /** 命中审批词（需人工审批） */
  approvalKeywordsHit: string[];
  /** 命中绝对化表述 */
  absolutePhrasesHit: string[];
  /** 是否应挂起持久化（审批通过前不入库） */
  needsApproval: boolean;
  /** 免责声明是否已注入 */
  disclaimerInjected: boolean;
  /** 法条引用核验报告 */
  citationReport: CitationReport;
};

/** 暂存队列：审批通过 Commit / 拒绝 Discard（未人工复核不入库）。 */
export class DeferredPersistQueue<T> {
  private readonly messages = new Map<number, T>();
  private nextIndex = 0;

  store(message: T): number {
    const index = this.nextIndex;
    this.nextIndex += 1;
    this.messages.set(index, message);
    return index;
  }

  commit(index: number): T | undefined {
    const msg = this.messages.get(index);
    if (msg !== undefined) this.messages.delete(index);
    return msg;
  }

  discard(index: number): void {
    this.messages.delete(index);
  }

  pending(): number[] {
    return [...this.messages.keys()];
  }

  has(index: number): boolean {
    return this.messages.has(index);
  }

  get size(): number {
    return this.messages.size;
  }
}

// ---------------------------------------------------------------------------
// CitationGate（法条引用核验）
// ---------------------------------------------------------------------------

export type CitationVerdict = "valid" | "unknown" | "unverifiable" | "suspect" | "invalid";

export type FlaggedCitation = {
  raw: string;
  statute: string;
  article: number;
  verdict: Exclude<CitationVerdict, "valid" | "unknown" | "unverifiable">;
  reason: string;
};

export type CitationReport = {
  total: number;
  valid: number;
  unknown: number;
  unverifiable: number;
  suspect: number;
  invalid: number;
  flagged: FlaggedCitation[];
};

/** 静态法条主题表（精校条目；S1 静态表，移植 Mady citation_table 的专利法关键条目）。 */
const PATENT_LAW_TOPICS: Record<string, { max: number; topics: Record<number, string[]> }> = {
  专利法: {
    max: 78,
    topics: {
      2: ["发明", "实用新型", "外观设计", "定义"],
      9: ["重复授权", "同样的发明创造"],
      22: ["新颖性", "创造性", "实用性"],
      25: ["不授予专利权", "智力活动规则", "疾病的诊断和治疗方法"],
      26: ["说明书", "权利要求书", "清楚", "支持"],
      27: ["外观设计", "图片", "照片"],
      33: ["修改", "超范围", "原始记载"],
      45: ["无效宣告"],
      47: ["无效宣告", "自始不存在", "宣告无效"],
      59: ["保护范围", "权利要求", "解释"],
      64: ["强制许可"],
      71: ["侵权", "专利侵权", "损害赔偿"],
    },
  },
  专利法实施细则: {
    max: 126,
    topics: {
      20: ["权利要求书", "编号", "句号"],
      21: ["独立权利要求", "前序部分", "特征部分"],
      22: ["从属权利要求", "引用"],
      23: ["说明书", "技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"],
      26: ["附图", "实用新型"],
    },
  },
};

const CITATION_PATTERN =
  /(?:专利法|实施细则)?第([零一二三四五六七八九十百\d]+)条(?:第([零一二三四五六七八九十百\d]+)款)?/g;

const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
  十三: 13,
  十四: 14,
  十五: 15,
  十六: 16,
  十七: 17,
  十八: 18,
  十九: 19,
  二十: 20,
  二十一: 21,
  二十二: 22,
  二十三: 23,
  二十四: 24,
  二十五: 25,
  二十六: 26,
  二十七: 27,
  二十八: 28,
  二十九: 29,
  三十: 30,
  三十一: 31,
  三十二: 32,
  三十三: 33,
  三十四: 34,
  三十五: 35,
  三十六: 36,
  三十七: 37,
  三十八: 38,
  三十九: 39,
  四十: 40,
  四十五: 45,
  四十七: 47,
  五十九: 59,
  六十四: 64,
  七十一: 71,
  七十八: 78,
  一百二十: 120,
  一百二十六: 126,
};

const ENUM_STARTERS = ["、", "或", "及", "和"];

const PURPOSE_CONNECTORS = [
  "专利法实施细则",
  "实施细则",
  "专利法",
  "审查指南",
  "根据",
  "依据",
  "按照",
  "依照",
  "参照",
  "符合",
  "违反",
  "详见",
  "参见",
  "的相关规定",
  "的规定",
  "规定",
  "所述",
  "要求",
];

/** 交叉匹配噪声词：过度泛化词不参与张冠李戴判定（误报防线）。 */
const CROSS_MATCH_NOISE = new Set([
  "实施",
  "使用",
  "许可",
  "公告",
  "决定",
  "审查",
  "放弃",
  "请求",
  "转让",
  "撤回",
  "检索",
  "制造",
  "销售",
  "进口",
  "支持",
  "定义",
  "补偿",
  "年费",
  "公布",
  "副本",
]);

/**
 * 核验文本中的法条引用（R1 存在性 + R2 语境相关性）。
 * Unknown（表未覆盖）与 Unverifiable（无用途声明）一律放行。
 */
export function verifyCitations(text: string): CitationReport {
  const citations = extractCitations(text);
  const report: CitationReport = {
    total: citations.length,
    valid: 0,
    unknown: 0,
    unverifiable: 0,
    suspect: 0,
    invalid: 0,
    flagged: [],
  };

  for (const c of citations) {
    const { verdict, reason } = verifyOne(c, text);
    report[verdict] += 1;
    if (verdict === "suspect" || verdict === "invalid") {
      report.flagged.push({ raw: c.raw, statute: c.statute, article: c.article, verdict, reason });
    }
  }
  return report;
}

type ExtractedCitation = { statute: string; article: number; raw: string };

function extractCitations(text: string): ExtractedCitation[] {
  const result: ExtractedCitation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_PATTERN)) {
    const raw = m[0];
    let statute: string;
    if (raw.includes("实施细则")) {
      statute = "专利法实施细则";
    } else if (raw.includes("专利法")) {
      statute = "专利法";
    } else {
      // 无法律前缀：回溯到最近句界（。；\n），句内出现专利法语境才归属。
      // 误报防线：其他法律（如"民法典第500条"）所在句无专利法语境即跳过；
      // 窗口上限 100 字符防超长句性能问题，覆盖《中华人民共和国专利法》等长全称。
      const start = Math.max(0, (m.index ?? 0) - 100);
      const beforeWindow = text.slice(start, m.index ?? 0);
      const lastBoundary = Math.max(
        beforeWindow.lastIndexOf("。"),
        beforeWindow.lastIndexOf("；"),
        beforeWindow.lastIndexOf("\n"),
      );
      const before = beforeWindow.slice(lastBoundary + 1);
      if (before.includes("实施细则")) statute = "专利法实施细则";
      else if (before.includes("专利法")) statute = "专利法";
      else continue;
    }
    const article = parseCnNumber(m[1]);
    if (article === undefined) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    result.push({ statute, article, raw });
  }
  return result;
}

function verifyOne(c: ExtractedCitation, fullText: string): { verdict: CitationVerdict; reason: string } {
  const statuteTable = PATENT_LAW_TOPICS[c.statute];
  if (!statuteTable) return { verdict: "unknown", reason: "静态表未覆盖该法律，放行" };

  // R1 存在性：条号超范围 → 幻觉编号疑点
  if (c.article > statuteTable.max) {
    return { verdict: "invalid", reason: `编号超出《${c.statute}》有效范围（共 ${statuteTable.max} 条）` };
  }

  const topics = statuteTable.topics[c.article];
  if (!topics) return { verdict: "unknown", reason: "静态表未覆盖该条主题，放行" };

  // R2 语境相关性：提取用途子句
  const purpose = extractPurpose(c.raw, fullText);
  if (purposeEmpty(purpose)) return { verdict: "unverifiable", reason: "无用途声明可核对，放行" };
  if (purpose.startsWith("、") || ENUM_STARTERS.some(s => purpose.startsWith(s))) {
    return { verdict: "unverifiable", reason: "引用属于枚举列表，R2 无法判定，放行" };
  }

  for (const kw of topics) {
    if (purpose.includes(kw)) return { verdict: "valid", reason: "" };
  }

  // 本条主题未命中：交叉匹配另一条注册主题 → suspect；否则放行
  const cross = crossMatch(c.statute, c.article, purpose);
  if (cross) {
    return {
      verdict: "suspect",
      reason: `用途描述与《${c.statute}》第${c.article}条主题不一致，更接近《${cross.statute}》第${cross.article}条（${cross.keyword}）`,
    };
  }
  return { verdict: "unverifiable", reason: "宽松转述，R2 无法判定，放行" };
}

function crossMatch(
  selfStatute: string,
  selfArticle: number,
  purpose: string,
): { statute: string; article: number; keyword: string } | null {
  for (const [statute, table] of Object.entries(PATENT_LAW_TOPICS)) {
    for (const [article, keywords] of Object.entries(table.topics)) {
      const a = Number(article);
      if (statute === selfStatute && a === selfArticle) continue;
      for (const kw of keywords) {
        if (CROSS_MATCH_NOISE.has(kw)) continue;
        if (purpose.includes(kw)) {
          return { statute, article: a, keyword: kw };
        }
      }
    }
  }
  return null;
}

/** 提取引用点后的用途子句（句界内截取，防上一句话题串扰）。 */
function extractPurpose(raw: string, fullText: string): string {
  const idx = fullText.indexOf(raw);
  if (idx < 0) return "";
  let trailing = fullText.slice(idx + raw.length);
  if (trailing.startsWith("、") || trailing.startsWith("或")) return trailing.slice(0, 1);
  const cut = trailing.search(/[。\n；;]/);
  if (cut >= 0) trailing = trailing.slice(0, cut);
  return trailing.trim();
}

function purposeEmpty(purpose: string): boolean {
  let s = purpose;
  for (const conn of PURPOSE_CONNECTORS) s = s.split(conn).join("");
  // 剔除数字与标点后无汉字 → 视为空
  return !/[\u4e00-\u9fff]/.test(s);
}

function parseCnNumber(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw in CN_NUM) return CN_NUM[raw];
  // 简单组合：X十Y
  const m = raw.match(/^([一二三四五六七八九])十([一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] === "十" ? 10 : m[1] === "一" ? 10 : CN_NUM[m[1]] * 10;
    return tens + (m[2] ? CN_NUM[m[2]] : 0);
  }
  return undefined;
}

export function formatCitationWarnings(report: CitationReport): string {
  if (report.flagged.length === 0) return "";
  const lines = report.flagged.map(f => `- 「${f.raw}」：${f.reason}`);
  return `\n\n---\n⚠️ 引用核验提示（以下法条引用请人工核对）：\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// PatentQualityGate（输出门禁主入口）
// ---------------------------------------------------------------------------

export type PatentQualityGateOptions = {
  riskKeywords?: string[];
  approvalKeywords?: string[];
  absolutePhrases?: string[];
  disclaimer?: string;
  /** 是否启用法条引用核验（默认 true） */
  enableCitationGate?: boolean;
};

/**
 * 处理 Agent 输出：注入免责声明 / 标记审批挂起 / 法条核验。
 * 纯函数，不触碰存储——挂起消息由调用方存入 DeferredPersistQueue。
 */
export function processPatentOutput(text: string, options?: PatentQualityGateOptions): QualityGateResult {
  const riskKeywords = options?.riskKeywords ?? PATENT_RISK_KEYWORDS;
  const approvalKeywords = options?.approvalKeywords ?? PATENT_APPROVAL_KEYWORDS;
  const absolutePhrases = options?.absolutePhrases ?? ABSOLUTE_PHRASES;
  const disclaimer = options?.disclaimer ?? PATENT_DISCLAIMER;

  const riskHit = filterNegatedHits(riskKeywords, text);
  // 审批词不适用否定豁免：合规敏感结论（如"专利结论"）即使出现否定语境也必须人工审批，
  // 避免"不，专利结论…"式构造绕过 HITL 门禁。
  const approvalHit = approvalKeywords.filter(k => text.includes(k));
  const absoluteHit = filterNegatedHits(absolutePhrases, text);

  let output = text;
  let disclaimerInjected = false;
  if (riskHit.length > 0 && !text.includes("不构成正式法律意见")) {
    output = `${text}\n\n---\n${disclaimer}`;
    disclaimerInjected = true;
  }
  if (absoluteHit.length > 0) {
    output = `${output}\n\n---\n⚠️ 提示：输出包含绝对化表述（${absoluteHit.join("、")}），请改为限定性表述。`;
  }

  const citationReport = options?.enableCitationGate === false ? emptyReport() : verifyCitations(text);
  if (citationReport.flagged.length > 0) {
    output += formatCitationWarnings(citationReport);
  }

  return {
    text: output,
    riskKeywordsHit: riskHit,
    approvalKeywordsHit: approvalHit,
    absolutePhrasesHit: absoluteHit,
    needsApproval: approvalHit.length > 0,
    disclaimerInjected,
    citationReport,
  };
}

function emptyReport(): CitationReport {
  return { total: 0, valid: 0, unknown: 0, unverifiable: 0, suspect: 0, invalid: 0, flagged: [] };
}
