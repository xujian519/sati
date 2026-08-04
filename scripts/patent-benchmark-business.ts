/**
 * 将 Mady 导出的原始评测 fixtures 转换为"专利业务"口径的业务化 fixtures。
 *
 * 原始数据集（tests/patent/benchmark/fixtures/）以专利代理人考试的
 * "题目-参考答案"形态组织；本脚本按专利代理机构的真实业务（可专利性分析 /
 * 申请文件撰写 / 申请文件审查 / 审查意见答复 / 侵权判定 / 无效宣告）重新组织：
 *
 *   - 每个用例标注 businessTask / clientRole / deliverable / sourceSuite（溯源）；
 *   - 考试味题目（"请判断……并说明理由"）改写为客户委托场景（保留案件实体内容）；
 *   - 参考答案剥离"官方参考答案要点"等考试痕迹，冠以业务文书抬头。
 *
 * 转换保持与原数据集 1:1（196 用例、ID 不变），用例数变化只反映业务归类。
 *
 * 用法：pnpm build 后 node dist/scripts/patent-benchmark-business.js
 * 输出：tests/patent/benchmark/fixtures/business/business-<task>.json + index.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BenchmarkIndex,
  BusinessPatentExamCase,
  BusinessPatentExamFixture,
  BusinessTask,
  ClientRole,
  PatentExamFixture,
} from "../tests/patent/benchmark/types.js";

/* ------------------------------------------------------------------ */
/* 常量：业务口径定义                                                   */
/* ------------------------------------------------------------------ */

/** 原始 suite 读取顺序（与 Mady exporter 输出一致）。 */
const RAW_SUITE_ORDER = [
  "patent-exam-mock",
  "patent-exam-real-a2",
  "patent-exam-real-a22",
  "patent-exam-real-a26",
  "patent-exam-real-a26-3",
  "patent-exam-real-a31",
  "patent-exam-real-a33",
  "patent-exam-real-r42",
  "patent-invalidation-decisions",
  "patent-design-invalidation",
];

/** 业务 suite 定义（顺序即 fixtures 输出顺序）。 */
const BUSINESS_SUITES: { task: BusinessTask; name: string; description: string }[] = [
  {
    task: "patentability_analysis",
    name: "business-patentability",
    description: "可专利性分析：新颖性/创造性/客体等授权要件评估（授权前景意见）",
  },
  {
    task: "drafting",
    name: "business-drafting",
    description: "申请文件撰写：基于技术交底材料撰写权利要求书/说明书（含合案/分案理由）",
  },
  {
    task: "file_review",
    name: "business-file-review",
    description: "申请文件审查：充分公开/支持/清楚/单一性/修改超范围等授权要件缺陷审查与修改建议",
  },
  {
    task: "oa_response",
    name: "business-oa-response",
    description: "审查意见答复：分析审查意见成立性、拟定修改方案、起草答复意见",
  },
  {
    task: "infringement_analysis",
    name: "business-infringement",
    description: "侵权判定分析：全面覆盖/等同侵权/抗辩事由评估",
  },
  {
    task: "invalidation",
    name: "business-invalidation",
    description: "无效宣告：请求方案评估、专利权人答辩、无效决定分析（含外观设计）",
  },
];

/** 每个业务要求的交付成果。 */
const DELIVERABLE: Record<BusinessTask, string> = {
  patentability_analysis: "可专利性分析意见（新颖性/创造性/授权要件比对 + 结论）",
  drafting: "专利申请文件撰写（权利要求书 + 合案/分案说明）",
  file_review: "申请文件审查意见（授权要件缺陷 + 修改建议）",
  oa_response: "审查意见答复意见（意见陈述 + 修改方案 + 策略）",
  infringement_analysis: "侵权判定分析意见（全面覆盖/等同/抗辩）",
  invalidation: "无效宣告意见（请求方案 / 答辩 / 决定分析）",
  prior_art_search: "现有技术检索报告",
  disclosure_analysis: "技术交底书分析/专利挖掘意见",
};

/** 交付文书抬头。 */
const EXPECTED_HEADER: Record<BusinessTask, string> = {
  patentability_analysis: "【可专利性分析意见】",
  drafting: "【权利要求书撰写方案】",
  file_review: "【申请文件审查意见】",
  oa_response: "【审查意见答复意见】",
  infringement_analysis: "【侵权判定分析意见】",
  invalidation: "【无效宣告意见】",
  prior_art_search: "【现有技术检索报告】",
  disclosure_analysis: "【技术交底书分析意见】",
};

/** 客户委托场景前缀（用于非业务口吻的原始用例）。 */
const SCENARIO: Record<BusinessTask, string> = {
  patentability_analysis:
    "委托方就其发明/实用新型专利申请委托贵所评估授权前景，并出具可专利性分析意见。申请文件与已掌握的现有技术如下：\n\n",
  drafting:
    "发明人客户提交技术交底材料，委托贵所撰写专利申请文件（重点为权利要求书），要求在法律与审查指南允许范围内最大化保护发明。交底材料及现有技术如下：\n\n",
  file_review:
    "客户提交其专利申请文件（权利要求书/说明书）草稿，委托贵所进行授权要件审查并出具修改意见。文件内容如下：\n\n",
  oa_response:
    "客户收到国家知识产权局发出的审查意见通知书，委托贵所代理答复：分析审查意见是否成立、制定答复策略并起草答复意见。通知书相关内容如下：\n\n",
  infringement_analysis:
    "企业客户委托贵所进行专利侵权判定分析：将被控产品/技术方案与涉案专利权利要求逐特征比对，评估是否构成侵权（含等同侵权与现有技术抗辩）。材料如下：\n\n",
  invalidation: "",
  prior_art_search: "",
  disclosure_analysis: "",
};

/** 无效宣告业务按委托方立场的场景前缀。 */
const INVALIDATION_SCENARIO: Record<ClientRole, string> = {
  无效请求人客户:
    "客户拟对他人专利权提出无效宣告请求，委托贵所评估无效理由与证据组合的有效性，并出具无效宣告请求方案。涉案专利及证据材料如下：\n\n",
  专利权人客户:
    "客户的专利权被他人提出无效宣告请求，委托贵所代理答辩：分析请求理由与证据、制定答复策略，必要时拟定权利要求修改方案。案卷材料如下：\n\n",
  "企业客户（决定分析）":
    "客户提供一份已作出的无效宣告请求审查决定书，委托贵所分析其结论与理由、对客户业务的影响及后续应对建议。决定书内容如下：\n\n",
  专利申请客户: "",
  发明人客户: "",
  企业客户: "",
};

/** 业务口吻的收尾请求（替换考试式"请判断……并说明理由"）。 */
const REQUEST: Record<BusinessTask, string> = {
  patentability_analysis:
    "请完成可专利性分析：逐特征比对申请方案与现有技术，评估其是否满足授权条件（新颖性、创造性及相关要件），结论附依据与置信度。",
  drafting: "请撰写权利要求书（必要时含说明书要点），并在存在多项独立权利要求时说明合案/分案理由。",
  file_review:
    "请审查该申请文件是否满足授权要件（充分公开、支持、清楚、单一性、修改不超范围等），指出缺陷并给出具体修改建议。",
  oa_response: "请起草答复意见：分析审查意见是否成立，必要时拟定权利要求修改方案，给出完整答复策略。",
  infringement_analysis: "请出具侵权判定分析意见：按全面覆盖原则逐特征比对，必要时适用等同原则，并评估可能的抗辩事由。",
  invalidation: "请分析无效理由与证据是否成立（含程序与实体），并出具相应的无效宣告意见。",
  prior_art_search: "",
  disclosure_analysis: "",
};

/** 已具备业务口吻的用例（含委托/客户等表述）不再套场景前缀，仅保留原状。 */
const BUSINESS_MARKED = /(委托|客户|代理机构|代理人|来函|承办|受.*(委派|指派))/;

/** 按 ID 定向替换原始 input 中的考试痕迹（先于业务判定执行）。 */
const INPUT_OVERRIDES: Record<string, Array<[string, string]>> = {
  patent_exam_2008_a26_03: [
    [
      "在2008年专利代理实务考试的审查意见通知书中，审查员提出了以下反对意见：",
      "客户A公司委托贵所答复一件发明专利申请的审查意见通知书，审查员提出了以下反对意见：",
    ],
  ],
  patent_exam_2007_a33_03: [["在2007年专利代理实务考试的无效宣告请求案件中，", ""]],
  patent_exam_2009_a2_02: [["接续2009年无效宣告案件的背景。", "案件背景（2009年无效宣告案件）："]],
  patent_exam_2008_r42_01: [
    ["假设你是某专利代理机构的专利代理人，受该机构委派", "你是某专利代理机构的专利代理人，受该机构委派"],
  ],
  patent_exam_2008_a31_02: [
    [
      "基于2008年专利代理实务考试中涉及的同一件专利申请（油炸食品制作方法和设备），专利审查员已经发出第一次审查意见通知书。你在答复该通知书时已对权利要求进行了修改。",
      "客户委托贵所处理其一件专利申请（油炸食品制作方法和设备，审查员已发出第一次审查意见通知书）的分案申请事务，贵所在答复通知书的修改基础上需要进一步分析分案方案。",
    ],
  ],
  patent_exam_2011_a26_3_chemical: [
    ["请以专利审查员的身份，根据专利法第 26 条第 3 款和审查指南第二部分第二章第 2.1 节，\n\t", ""],
  ],
};

/** 无需改写收尾请求的用例（请求内嵌于原文，套场景前缀即可）。 */
const SKIP_REQUEST_STRIP = new Set(["patent_exam_053", "patent_exam_054", "patent_exam_055"]);

/** 考试痕迹（Expected 开头需剥离）。 */
const EXAM_LINE = /(年全国专利代理人资格考试|年专利代理师资格考试|年专利代理实务考试|官方参考答案要点|卷三|真题)/;

/* ------------------------------------------------------------------ */
/* 用例归类（91 个非自动归类的用例；无效决定 100 件与外观 5 件走默认值）    */
/* ------------------------------------------------------------------ */

type TaskAndRole = { task: BusinessTask; role: ClientRole };

const MOCK_ROLE = "专利申请客户" as ClientRole;

const TASK_MAP: Record<string, TaskAndRole> = {
  // —— mock：可专利性分析（18）
  patent_exam_001: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_002: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_007: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_008: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_011: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_012: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_013: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_014: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_015: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_016: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_017: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_018: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_019: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_020: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_021: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_022: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_023: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_024: { task: "patentability_analysis", role: MOCK_ROLE },
  // —— mock：申请文件审查（16）
  patent_exam_003: { task: "file_review", role: MOCK_ROLE },
  patent_exam_025: { task: "file_review", role: MOCK_ROLE },
  patent_exam_026: { task: "file_review", role: MOCK_ROLE },
  patent_exam_027: { task: "file_review", role: MOCK_ROLE },
  patent_exam_028: { task: "file_review", role: MOCK_ROLE },
  patent_exam_029: { task: "file_review", role: MOCK_ROLE },
  patent_exam_030: { task: "file_review", role: MOCK_ROLE },
  patent_exam_031: { task: "file_review", role: MOCK_ROLE },
  patent_exam_032: { task: "file_review", role: MOCK_ROLE },
  patent_exam_033: { task: "file_review", role: MOCK_ROLE },
  patent_exam_034: { task: "file_review", role: MOCK_ROLE },
  patent_exam_035: { task: "file_review", role: MOCK_ROLE },
  patent_exam_036: { task: "file_review", role: MOCK_ROLE },
  patent_exam_053: { task: "file_review", role: MOCK_ROLE },
  patent_exam_054: { task: "file_review", role: MOCK_ROLE },
  patent_exam_055: { task: "file_review", role: MOCK_ROLE },
  // —— mock：审查意见答复（9）
  patent_exam_004: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_009: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_037: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_038: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_043: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_044: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_045: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_046: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_047: { task: "oa_response", role: MOCK_ROLE },
  // —— mock：侵权判定（6）
  patent_exam_005: { task: "infringement_analysis", role: "企业客户" },
  patent_exam_010: { task: "infringement_analysis", role: "企业客户" },
  patent_exam_039: { task: "infringement_analysis", role: "企业客户" },
  patent_exam_040: { task: "infringement_analysis", role: "企业客户" },
  patent_exam_041: { task: "infringement_analysis", role: "企业客户" },
  patent_exam_042: { task: "infringement_analysis", role: "企业客户" },
  // —— mock：无效宣告（6）
  patent_exam_006: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_048: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_049: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_050: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_051: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_052: { task: "invalidation", role: "无效请求人客户" },
  // —— real-a2（3）
  patent_exam_2009_a2_02: { task: "invalidation", role: "专利权人客户" },
  patent_exam_2012_a2_01: { task: "invalidation", role: "专利权人客户" },
  patent_exam_2018_a2_01: { task: "invalidation", role: "无效请求人客户" },
  // —— real-a22（15）
  patent_exam_2007_a22_01: { task: "invalidation", role: "专利权人客户" },
  patent_exam_2009_a22_01: { task: "invalidation", role: "专利权人客户" },
  patent_exam_2010_a22_02: { task: "patentability_analysis", role: MOCK_ROLE },
  patent_exam_2011_a22_01: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_2011_a22_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2014_a22_01: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_2015_a22_01: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_2015_a22_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2016_a22_01: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_2016_a22_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2017_a22_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2017_a22_03: { task: "drafting", role: "发明人客户" },
  patent_exam_2018_a22_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2019_a22_01: { task: "invalidation", role: "无效请求人客户" },
  patent_exam_2019_a22_02: { task: "drafting", role: "发明人客户" },
  // —— real-a26（3）
  patent_exam_2008_a26_03: { task: "oa_response", role: MOCK_ROLE },
  patent_exam_2013_a26_01: { task: "file_review", role: MOCK_ROLE },
  patent_exam_2017_a26_01: { task: "file_review", role: MOCK_ROLE },
  // —— real-a26-3（5）
  patent_exam_2011_a26_3_chemical: { task: "file_review", role: MOCK_ROLE },
  patent_exam_2012_a26_3_mechanical: { task: "file_review", role: MOCK_ROLE },
  invalidation_a26_3_disclosure: { task: "invalidation", role: "无效请求人客户" },
  invalidation_a26_3_means_cannot_solve: { task: "invalidation", role: "无效请求人客户" },
  invalidation_a26_3_partial_means: { task: "invalidation", role: "无效请求人客户" },
  // —— real-a31（8）
  patent_exam_2007_a31_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2008_a31_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2009_a31_03: { task: "drafting", role: "发明人客户" },
  patent_exam_2010_a31_01: { task: "drafting", role: "发明人客户" },
  patent_exam_2012_a31_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2013_a31_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2014_a31_02: { task: "drafting", role: "发明人客户" },
  patent_exam_2019_a31_03: { task: "drafting", role: "发明人客户" },
  // —— real-a33（1）
  patent_exam_2007_a33_03: { task: "invalidation", role: "专利权人客户" },
  // —— real-r42（1）
  patent_exam_2008_r42_01: { task: "oa_response", role: MOCK_ROLE },
};

/** 默认归类：无效决定书 → 决定分析；外观设计 → 无效请求评估。 */
function defaultMeta(id: string): TaskAndRole {
  if (id.startsWith("invalidation_decision_")) {
    return { task: "invalidation", role: "企业客户（决定分析）" };
  }
  if (id.startsWith("DESIGN-INV-")) {
    return { task: "invalidation", role: "无效请求人客户" };
  }
  return { task: "invalidation", role: "无效请求人客户" };
}

/* ------------------------------------------------------------------ */
/* 转换辅助                                                             */
/* ------------------------------------------------------------------ */

function repoRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("未找到仓库根目录（向上查找 tsconfig.json 失败）");
    dir = parent;
  }
}

const FIXTURES_DIR = resolve(repoRoot(import.meta.url), "tests/patent/benchmark/fixtures");
const OUT_DIR = join(FIXTURES_DIR, "business");

/** 剥离 Expected 开头的考试痕迹句（如"2010年真题第三题。""2007 年全国专利代理人资格考试卷三第一题（无效实务题）。官方参考答案要点："）。 */
function stripExamHeader(expected: string): string {
  let text = expected.replace(/^\s+/, "");
  for (let i = 0; i < 4; i += 1) {
    const nl = text.indexOf("\n");
    const firstLine = nl === -1 ? text : text.slice(0, nl);
    const m = EXAM_LINE.exec(firstLine);
    if (!m) break;
    const seg = firstLine.slice(m.index);
    // 截掉自痕迹起的第一个句子（句号终止；无句号时截到冒号或行尾），保留句后内容
    const end = seg.indexOf("。");
    const keep = end === -1 ? seg.replace(/^[^:：]*[:：]?/, "") : seg.slice(end + 1);
    if (nl === -1 && !keep.trim()) break;
    text = (keep + (nl === -1 ? "" : text.slice(nl))).trimStart();
    if (!text) break;
  }
  return text || expected.trim();
}

/** 剥离 input 末尾的考试式请求句（"请判断……并说明理由。"），保留案件实体内容。 */
function stripExamRequest(input: string): string {
  const trimmed = input.trimEnd();
  const m = trimmed.match(/[^。]*。$/);
  if (m && m[0].includes("请")) {
    return trimmed.slice(0, trimmed.length - m[0].length).trimEnd();
  }
  return trimmed;
}

/** 生成业务化 input。 */
function frameInput(id: string, raw: string, meta: TaskAndRole): string {
  let input = raw;
  for (const [from, to] of INPUT_OVERRIDES[id] ?? []) {
    input = input.split(from).join(to);
  }
  if (id.startsWith("invalidation_decision_")) {
    input = input.replace(/^无效宣告请求审查决定案例（\d+）。\s*\n+/, "");
  }
  // 定向改写后已具备业务口吻（含委托/客户等）的用例不再套通用场景前缀
  if (BUSINESS_MARKED.test(input)) return input;

  const scenario = meta.task === "invalidation" ? INVALIDATION_SCENARIO[meta.role] : SCENARIO[meta.task];
  const body = SKIP_REQUEST_STRIP.has(id) ? input.trim() : stripExamRequest(input);
  return `${scenario}${body}\n\n${REQUEST[meta.task]}`;
}

/** 生成业务化 expected。 */
function frameExpected(raw: string, task: BusinessTask): string {
  const body = stripExamHeader(raw);
  return `${EXPECTED_HEADER[task]}\n\n${body}`;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function readRawSuite(name: string): PatentExamFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8")) as PatentExamFixture;
}

function main(): void {
  const groups = new Map<BusinessTask, BusinessPatentExamCase[]>();
  for (const s of BUSINESS_SUITES) groups.set(s.task, []);

  for (const suiteName of RAW_SUITE_ORDER) {
    const fixture = readRawSuite(suiteName);
    for (const c of fixture.cases) {
      const meta = TASK_MAP[c.id] ?? defaultMeta(c.id);
      const bc: BusinessPatentExamCase = {
        ...c,
        businessTask: meta.task,
        clientRole: meta.role,
        deliverable: DELIVERABLE[meta.task],
        sourceSuite: suiteName,
        input: frameInput(c.id, c.input, meta),
        expected: frameExpected(c.expected, meta.task),
      };
      groups.get(meta.task)?.push(bc);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const now = new Date().toISOString();
  const index: BenchmarkIndex = {
    generatedAt: now,
    source: "Sati 业务化转换：基于 Mady evaluate/benchmark 导出（github.com/xujian519/mady）",
    totalCases: 0,
    suites: [],
  };

  let total = 0;
  for (const s of BUSINESS_SUITES) {
    const cases = groups.get(s.task) ?? [];
    const ff: BusinessPatentExamFixture = {
      suite: s.name,
      description: s.description,
      source: index.source,
      generatedAt: now,
      caseCount: cases.length,
      cases,
    };
    writeFileSync(join(OUT_DIR, `${s.name}.json`), `${JSON.stringify(ff, null, 2)}\n`, "utf8");
    index.suites.push({ suite: s.name, caseCount: cases.length });
    total += cases.length;
  }
  index.totalCases = total;
  writeFileSync(join(OUT_DIR, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const ids = new Set<string>();
  for (const s of BUSINESS_SUITES) {
    for (const c of groups.get(s.task) ?? []) ids.add(c.id);
  }
  const rawIds = new Set<string>();
  for (const suiteName of RAW_SUITE_ORDER) {
    for (const c of readRawSuite(suiteName).cases) rawIds.add(c.id);
  }
  const missing = [...rawIds].filter(id => !ids.has(id));
  const extra = [...ids].filter(id => !rawIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`用例 ID 不一致：缺失 ${missing.length} 个（${missing.slice(0, 5)}），多余 ${extra.length} 个`);
  }

  console.log(`业务化转换完成：${total} 个用例 / ${BUSINESS_SUITES.length} 个业务 suite → ${OUT_DIR}`);
  for (const s of BUSINESS_SUITES) {
    console.log(`  ${s.name}: ${(groups.get(s.task) ?? []).length}`);
  }
}

main();
