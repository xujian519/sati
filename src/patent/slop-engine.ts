/**
 * 反套话引擎（移植自 Mady domains/rules/slop_engine.go）。
 *
 * 三层分析：短语删除/替换（8 组 42 条校准正则）→ 结构缺陷检测（6 种：
 * 假三步法/假对比表/假转折/理由堆砌/被动语态/OA 公式）→ 50 分五维评分
 * （争点直陈/证据密度/论证节奏/实务可信/可删减性，通过线 35 分）+ 交付前快检清单。
 *
 * 用途：AI 生成专利文本（OA 答复/无效宣告/分析报告）在交付前经本引擎
 * 去冗余、标缺陷、计分，阻断"看起来专业但无实质内容"的套话输出。
 * 全部为确定性正则/计数逻辑（无 LLM 调用）。
 */

export type SlopGroup =
  | "filler"
  | "qualifier"
  | "passive"
  | "meta"
  | "advisory"
  | "search"
  | "intimacy"
  | "subjectless";

export type SlopRule = {
  pattern: RegExp;
  replacement: string;
  label: string;
  group: SlopGroup;
};

export type SlopChange = {
  original: string;
  replacement: string;
  group: string;
};

export type StructureIssueType =
  | "empty_three_step"
  | "fake_comparison"
  | "binary_turn"
  | "reason_pile"
  | "passive_voice"
  | "oa_formula";

export type StructureIssue = {
  type: StructureIssueType;
  line: number;
  text: string;
  suggestion: string;
};

export type SlopScore = {
  directness: number;
  evidence: number;
  rhythm: number;
  practicality: number;
  concision: number;
  total: number;
  passed: boolean;
};

export type ChecklistItem = {
  question: string;
  passed: boolean;
  detail: string;
};

export type SlopAnalysis = {
  cleaned: string;
  changes: SlopChange[];
  issues: StructureIssue[];
  score: SlopScore;
  checklist: ChecklistItem[];
};

const GROUP_LABELS: Record<SlopGroup, string> = {
  filler: "填充废词",
  qualifier: "空泛修饰",
  passive: "被动语态",
  meta: "元叙述",
  advisory: "免责堆叠",
  search: "检索空话",
  intimacy: "虚假亲密",
  subjectless: "虚假主体",
};

const TYPE_LABELS: Record<StructureIssueType, string> = {
  empty_three_step: "假三步法",
  fake_comparison: "假对比表",
  binary_turn: "假转折",
  reason_pile: "理由堆砌",
  passive_voice: "被动语态",
  oa_formula: "意见陈述公式",
};

/** 短语级规则（8 组 42 条，直接移植 Mady phraseRules，经真实答案回放校准）。 */
const PHRASE_RULES: SlopRule[] = [
  // 填充废词
  mk("进一步地[，,]?", "", "填充词「进一步地」", "filler"),
  mk("此外[，,]?", "", "填充词「此外」", "filler"),
  mk("值得一提的是[，,]?", "", "填充词「值得一提的是」", "filler"),
  mk("不难发现[，,]?", "", "填充词「不难发现」", "filler"),
  mk("毋庸置疑[，,]?", "", "填充词「毋庸置疑」", "filler"),
  mk("需要指出的是[，,]?", "", "填充词「需要指出的是」", "filler"),
  mk("综上所述[，,]?", "", "填充词「综上所述」", "filler"),
  mk("诚如前述[，,]?", "", "填充词「诚如前述」", "filler"),
  // 空泛修饰
  mk("显而易见地[，,]?", "", "空泛「显而易见地」", "qualifier"),
  mk("本领域技术人员能够理解[，,]?", "", "空泛「本领域技术人员能够理解」", "qualifier"),
  mk("创造性得以确立[。.]?", "", "空泛「创造性得以确立」", "qualifier"),
  mk("保护范围合理[。.]?", "", "空泛「保护范围合理」", "qualifier"),
  mk("具有显著进步[。.]?", "", "空泛「具有显著进步」", "qualifier"),
  mk("质的飞跃[。.]?", "", "空泛「质的飞跃」", "qualifier"),
  mk("革命性", "", "夸张修饰「革命性」", "qualifier"),
  mk("颠覆性", "", "夸张修饰「颠覆性」", "qualifier"),
  mk("深入[地]?分析", "分析", "空洞修饰「深入分析」", "qualifier"),
  mk("全面[地]?论述", "论述", "空洞修饰「全面论述」", "qualifier"),
  mk("系统[地]?(分析|论述|阐述)", "$1", "空洞修饰「系统化」", "qualifier"),
  mk("一体化", "", "空洞修饰「一体化」", "qualifier"),
  mk("新颖性是指[^，。]*[，。]?", "", "科普腔「新颖性定义」", "qualifier"),
  mk("创造性判断(通常)?采用三步法[，。]?", "", "科普腔「三步法介绍」", "qualifier"),
  mk("正如大家所知[，,]?", "", "顾问腔「正如大家所知」", "qualifier"),
  // 元叙述（"综上所述"已在 filler 组覆盖，此处不重复注册——重复规则永不触发）
  mk("下文将分[一二三四五六七八九十]+部分[^，。]*[，。]?", "", "元叙述「下文将分部分」", "meta"),
  mk("首先分析[^，。]*，再分析[^，。]*[。]?", "", "元叙述「首先…再…」", "meta"),
  // 虚假亲密
  mk("恕我直言[，,]?", "", "虚假亲密「恕我直言」", "intimacy"),
  mk("请允许我指出[，,]?", "", "虚假亲密「请允许我指出」", "intimacy"),
  mk("这是一个值得深思的问题[。.]?", "", "表演强调「值得深思的问题」", "intimacy"),
  // 虚假主体（无主句）
  mk("创造性障碍得以克服[。.]?", "", "无主句「创造性障碍得以克服」", "subjectless"),
  mk("审查意见所指缺陷得以消除[。.]?", "", "无主句「缺陷得以消除」", "subjectless"),
  mk("现有技术给出了启示[。.]?", "", "无主句「现有技术给出了启示」", "subjectless"),
  mk("创造性得以认可[。.]?", "", "无主句「创造性得以认可」", "subjectless"),
  mk("保护范围得以[^，。]*界定[。.]?", "", "无主句「保护范围得以…界定」", "subjectless"),
  mk("审查实践认为[^，。]*[。.]?", "", "无主句「审查实践认为」", "subjectless"),
  // 检索空话
  mk("检索范围广泛[，,]?结果丰富[。.]?", "", "检索空话「范围广泛结果丰富」", "search"),
  mk("高相关文献若干[。.]?", "", "检索空话「高相关文献若干」", "search"),
  mk("建议继续检索[。.]?", "", "检索空话「建议继续检索」", "search"),
  // 免责堆叠
  mk("以上分析仅供参考[，,]不构成法律意见", "以上分析仅供参考。", "免责堆叠「仅供参考不构成法律意见」", "advisory"),
  mk("存在不确定性[，,]结果可能因审查实践而异", "", "免责堆叠「存在不确定性」", "advisory"),
  // 注：不做全局空白清理（"[ \\t]{2,}" 会破坏缩进代码块/两空格硬换行，"\n{3,}"
  // 会破坏围栏代码块内空行——专利文本常含缩进引用，markdown 安全优先）。
];

function mk(pattern: string, replacement: string, label: string, group: SlopGroup): SlopRule {
  return { pattern: new RegExp(pattern, "g"), replacement, label, group };
}

/** 结构缺陷检测正则（对齐 Mady detectStructureIssues 用到的全部正则）。 */
const RE_EMPTY_THREE_STEP = /区别特征/;
const RE_COLON_NO_EVIDENCE = /[：:][^D\d]/;
const RE_FAKE_COMPARISON = /\|.*特征.*\|/;
const RE_HAS_PARAGRAPH = /¶\d{3,4}/;
const RE_HAS_YEAR_REF = /\[\d{4}\]/;
const RE_BINARY_TURN = /不是[^，]{2,20}问题[，,]\s*而是/;
const RE_PASSIVE_VOICE = /被(驳回|认定为|视为|公开).*[。.]/;
const RE_PASSIVE_PREFIX = /^(申请人|审查员|法院|D\d)/;
const RE_OA_FORMULA = /(审查员认定有误|审查员之意见|请审查员重新考虑)/;
const RE_REASON_PILE = /第[\d一二三四五六七八九十]+条|专利法第[\d]+条/g;
const RE_MAIN_POINT = /(争点|问题|争议|焦点|核心)/;
const RE_EVIDENCE = /(D\d|权[\d]|第[\d]条|段落)/;
const RE_PARAGRAPH_REF = /¶\d{3,4}/;
const RE_EXAGGERATION = /(显著|突出|质的飞跃|革命性|颠覆性)/;
const RE_SEARCH_TERMS = /(去重|命中|数据库)/;

/** 按 Unicode 码点计长度（对齐 Go rune 语义）。 */
function runeLen(s: string): number {
  return [...s].length;
}

/**
 * 按 Unicode 码点截断（对齐 Go runeSlice）；ellipsis 为 true 时超长追加省略号。
 * 单一实现，quality-gate 的 truncateRunes 复用本函数（勿重复实现）。
 */
export function runeSlice(s: string, n: number, ellipsis = false): string {
  const runes = [...s];
  if (runes.length <= n) return s;
  return `${runes.slice(0, n).join("")}${ellipsis ? "…" : ""}`;
}

/** 结构缺陷检测（逐行扫描 + 全文理由计数，对齐 Mady detectStructureIssues）。 */
export function detectStructureIssues(text: string): StructureIssue[] {
  const lines = text.split("\n");
  const issues: StructureIssue[] = [];

  lines.forEach((line, i) => {
    const trimmed = line.trim();

    if (RE_EMPTY_THREE_STEP.test(line) && (runeLen(line) < 30 || RE_COLON_NO_EVIDENCE.test(line))) {
      issues.push({
        type: "empty_three_step",
        line: i + 1,
        text: runeSlice(trimmed, 80),
        suggestion: "区别特征应指向对比文件具体段落：D1¶[段落号]：特征详情",
      });
    }

    if (RE_FAKE_COMPARISON.test(line) && !RE_HAS_PARAGRAPH.test(line) && !RE_HAS_YEAR_REF.test(line)) {
      issues.push({
        type: "fake_comparison",
        line: i + 1,
        text: runeSlice(trimmed, 80),
        suggestion: "对比表每格应含对比文件段落号：D1¶0123",
      });
    }

    if (RE_BINARY_TURN.test(line)) {
      issues.push({
        type: "binary_turn",
        line: i + 1,
        text: runeSlice(trimmed, 80),
        suggestion: "直接写结论及证据，不用「不是X而是Y」转折",
      });
    }

    if (RE_PASSIVE_VOICE.test(line) && !RE_PASSIVE_PREFIX.test(trimmed)) {
      issues.push({
        type: "passive_voice",
        line: i + 1,
        text: runeSlice(trimmed, 80),
        suggestion: "写明主体：审查员驳回… / 对比文件D1公开…",
      });
    }

    if (RE_OA_FORMULA.test(line)) {
      issues.push({
        type: "oa_formula",
        line: i + 1,
        text: runeSlice(trimmed, 80),
        suggestion: "直接写争点+法条+对比文件段落+修改对照",
      });
    }
  });

  const reasons = text.match(RE_REASON_PILE) ?? [];
  if (reasons.length >= 4) {
    issues.push({
      type: "reason_pile",
      line: 1,
      text: `全文含 ${reasons.length} 条理由`,
      suggestion: "主理由至多2条，其余删除或并入脚注",
    });
  }

  return issues;
}

function scoreRhythm(issueCount: number): number {
  if (issueCount > 3) return 4;
  if (issueCount > 1) return 6;
  return 8;
}

function scorePracticality(changeCount: number): number {
  if (changeCount > 5) return 5;
  if (changeCount > 2) return 7;
  return 9;
}

function scoreConcision(paragraphCount: number): number {
  if (paragraphCount > 15) return 5;
  return 8;
}

/** 50 分五维评分（通过线 35，对齐 Mady scoreDocument）。 */
export function scoreDocument(text: string, changes: SlopChange[], issues: StructureIssue[]): SlopScore {
  const lines = text.split("\n");
  const firstPara = runeSlice(lines.slice(0, Math.min(10, lines.length)).join(""), 200);

  const directness = RE_MAIN_POINT.test(firstPara) ? 8 : 4;

  let evidenceScore = 5;
  if (RE_EVIDENCE.test(text)) evidenceScore += 2;
  if (RE_PARAGRAPH_REF.test(text)) evidenceScore += 2;
  if (text.split("\n\n").length < 3) evidenceScore += 1;

  const rhythm = scoreRhythm(issues.length);
  const practicality = scorePracticality(changes.length);
  const concision = scoreConcision(text.split("\n\n").length);
  const total = directness + evidenceScore + rhythm + practicality + concision;

  return {
    directness,
    evidence: evidenceScore,
    rhythm,
    practicality,
    concision,
    total,
    passed: total >= 35,
  };
}

function hasIssueType(issues: StructureIssue[], type: StructureIssueType): boolean {
  return issues.some(issue => issue.type === type);
}

function buildIssueDetail(issues: StructureIssue[], type: StructureIssueType, label: string): string {
  const count = issues.filter(issue => issue.type === type).length;
  return count > 0 ? `${count} 处${label}` : "无";
}

/** 交付前快检清单（8 项，对齐 Mady runChecklist）。 */
export function runChecklist(text: string, issues: StructureIssue[]): ChecklistItem[] {
  const snippet = runeSlice(text, 500);

  const hasFeature = snippet.includes("特征");
  const hasEvidenceMarker = snippet.includes("权") || /D\d/.test(snippet) || snippet.includes("¶");
  const featurePassed = !hasFeature || hasEvidenceMarker;

  return [
    {
      question: "有无未指向权项号或对比文件段落的特征论述？",
      passed: featurePassed,
      detail: "检查前500字中孤立出现的「特征」",
    },
    {
      question: "有无被动句隐藏主体（「被认为」「得以」「得以克服」）？",
      passed: !hasIssueType(issues, "passive_voice"),
      detail: buildIssueDetail(issues, "passive_voice", "被动句"),
    },
    {
      question: "创造性段落是否仅有「区别特征+技术问题+显而易见」标题而无D1映射？",
      passed: !hasIssueType(issues, "empty_three_step"),
      detail: buildIssueDetail(issues, "empty_three_step", "假三步法"),
    },
    {
      question: "是否出现「不是X问题，而是Y问题」式假转折？",
      passed: !hasIssueType(issues, "binary_turn"),
      detail: buildIssueDetail(issues, "binary_turn", "假转折"),
    },
    {
      question: "无效理由是否超过3条且彼此无优先级？",
      passed: !hasIssueType(issues, "reason_pile"),
      detail: buildIssueDetail(issues, "reason_pile", "理由超量"),
    },
    {
      question: "是否用「显著」「突出」「质的飞跃」而无实验数据或对比效果？",
      passed: !RE_EXAGGERATION.test(text),
      detail: "含无数据夸张修饰",
    },
    {
      question: "说明书「技术效果」是否与权利要求特征逐项对应？",
      passed: true,
      detail: "需人工确认",
    },
    {
      question: "检索报告是否有命中逻辑与去重说明？",
      passed: RE_SEARCH_TERMS.test(text) || runeLen(text) < 500,
      detail: RE_SEARCH_TERMS.test(text) ? "有" : "N/A（非检索报告）",
    },
  ];
}

/** 三层全量分析：短语清理 → 结构缺陷 → 评分 + 快检。 */
export function analyzeSlop(text: string): SlopAnalysis {
  const changes: SlopChange[] = [];
  let cleaned = text;

  for (const rule of PHRASE_RULES) {
    const before = cleaned;
    cleaned = cleaned.replace(rule.pattern, rule.replacement);
    if (cleaned !== before) {
      changes.push({
        original: rule.label,
        replacement: rule.replacement === "" ? "（删除）" : rule.replacement,
        group: rule.group,
      });
    }
  }

  cleaned = cleaned.replace(/[ \t\n]+$/, "") + "\n";

  const issues = detectStructureIssues(cleaned);
  const score = scoreDocument(text, changes, issues);
  const checklist = runChecklist(text, issues);

  return { cleaned, changes, issues, score, checklist };
}

/** 按组归类短语改动（组顺序对齐 Mady groupOrder）。 */
function groupChanges(changes: SlopChange[]): Array<{ label: string; items: SlopChange[] }> {
  const order: SlopGroup[] = [
    "filler",
    "qualifier",
    "passive",
    "meta",
    "advisory",
    "search",
    "intimacy",
    "subjectless",
  ];
  const byGroup = new Map<SlopGroup, SlopChange[]>();
  for (const change of changes) {
    const group = change.group as SlopGroup;
    byGroup.set(group, [...(byGroup.get(group) ?? []), change]);
  }
  const result: Array<{ label: string; items: SlopChange[] }> = [];
  for (const group of order) {
    const items = byGroup.get(group);
    if (items !== undefined && items.length > 0) {
      result.push({ label: GROUP_LABELS[group], items });
    }
  }
  return result;
}

/** 渲染完整分析报告（Markdown，对齐 Mady FormatSlopAnalysis）。 */
export function formatSlopAnalysis(analysis: SlopAnalysis): string {
  const passText = analysis.score.passed ? "✅ 通过" : "❌ 需修订";
  const lines: string[] = [
    "## 反套话润色报告",
    "",
    `**评分：${analysis.score.total}/50 (${passText})**`,
    "",
    "| 维度 | 得分 | 满分 |",
    "|------|------|------|",
    `| 争点直陈 | ${analysis.score.directness} | 10 |`,
    `| 证据密度 | ${analysis.score.evidence} | 10 |`,
    `| 论证节奏 | ${analysis.score.rhythm} | 10 |`,
    `| 实务可信 | ${analysis.score.practicality} | 10 |`,
    `| 可删减性 | ${analysis.score.concision} | 10 |`,
  ];

  if (analysis.changes.length > 0) {
    lines.push("", "### 短语删除/替换", "");
    for (const group of groupChanges(analysis.changes)) {
      lines.push(`**${group.label}（${group.items.length}处）**`);
      for (const change of group.items) {
        lines.push(`- ${change.original} → ${change.replacement}`);
      }
      lines.push("");
    }
  }

  if (analysis.issues.length > 0) {
    lines.push("### 结构缺陷", "");
    for (const issue of analysis.issues) {
      lines.push(`- **L${issue.line}** [${TYPE_LABELS[issue.type]}] ${issue.text}`, `  ↳ ${issue.suggestion}`);
    }
    lines.push("");
  }

  const failedItems = analysis.checklist.filter(item => !item.passed);
  if (failedItems.length > 0) {
    lines.push("### 未通过快检项", "");
    for (const item of failedItems) {
      lines.push(`- ❌ ${item.question}`);
      if (item.detail !== "") lines.push(`  ${item.detail}`);
    }
  }

  return lines.join("\n");
}
