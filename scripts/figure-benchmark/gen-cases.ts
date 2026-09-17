/**
 * scripts/figure-benchmark/gen-cases.ts — 生成侧合规基准的固定输入集合。
 *
 * 与分析侧基准（`run.ts`：真实客户附图 + 真实模型调用 + 人工 ground truth）不同，本集合是
 * **入库的确定性输入**——不调用模型、不读私有数据、结果可重算，故可直接作 CI 回归护栏
 * （指标计算见 `gen-compliance.ts`，基线断言见 `tests/scripts/figure-benchmark/gen-compliance.spec.ts`）。
 *
 * 用例按"已修缺陷的回退面"选取：
 * - 介质锚定（P0-4）：8 / 12 / 16 步 TB 流程图——12 步曾以 355mm 画幅静默"通过"却被分页切断
 * - 字宽度量（P1-2）：同拓扑的 CJK 长标注与 Latin 长标注——Latin 曾按每字符 0.75em 高估盒宽
 * - 名称归一化（P0-1）：同一组件跨图写作「处理模块(20)」/「处理模块20」不得判 V4
 * - 括号按面判定（P1-1）：权利要求漏括号（V10）/ 说明书正文用括号（V11）
 * - 统一缩放与字高（P0-4）：混排画幅（一图超高）走同文档统一系数
 */

import type { DocumentKind, FigureSpec, Jurisdiction } from "../../src/patent/figuregen/index.js";

/** 基准用例：一份自足的文字部分 + 一组附图（同文档统一缩放按用例内附图计算）。 */
export type GenBenchmarkCase = {
  id: string;
  title: string;
  /** 说明书文字部分（V2/V3/V5/V10/V11 的输入面）。 */
  specText: string;
  jurisdiction?: Jurisdiction;
  documentKind?: DocumentKind;
  figures: FigureSpec[];
};

/** 名称 + 附图标记（构造文字部分用）。 */
type RefLabel = { label: string; ref: number };

const FLOW_STEPS = [
  "接收交底书",
  "解析技术方案",
  "提取必要技术特征",
  "检索现有技术",
  "对比区别特征",
  "判断新颖性",
  "评估创造性",
  "生成检索报告",
  "复核结论",
  "归档案件材料",
  "同步客户系统",
  "更新案件台账",
  "触发年费监控",
  "生成缴费提醒",
  "发送客户确认",
  "关闭案件流程",
];

const FLOW_FIRST_REF = 10;

function flowItems(count: number): RefLabel[] {
  return FLOW_STEPS.slice(0, count).map((label, index) => ({ label, ref: FLOW_FIRST_REF + index }));
}

/** TB 流程图：首尾 round（起止），其余 rect；ref 从 firstRef 起连续编号。 */
function tbFlow(figureNo: number, items: readonly RefLabel[], options: { abstract?: boolean } = {}): FigureSpec {
  const nodes = items.map((item, index) => ({
    id: `f${figureNo}-n${index + 1}`,
    label: item.label,
    ref: item.ref,
    shape: index === 0 || index === items.length - 1 ? ("round" as const) : ("rect" as const),
  }));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }));
  return {
    figure_no: figureNo,
    kind: "flowchart",
    direction: "TB",
    nodes,
    edges,
    ...(options.abstract === true ? { abstract: true } : {}),
  };
}

/** LR 方框图：直线串联，ref 从 firstRef 起连续编号。 */
function lrChain(figureNo: number, items: readonly RefLabel[], options: { abstract?: boolean } = {}): FigureSpec {
  const nodes = items.map((item, index) => ({
    id: `f${figureNo}-b${index + 1}`,
    label: item.label,
    ref: item.ref,
    shape: "rect" as const,
  }));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }));
  return {
    figure_no: figureNo,
    kind: "block",
    direction: "LR",
    nodes,
    edges,
    ...(options.abstract === true ? { abstract: true } : {}),
  };
}

function claimsParagraph(items: readonly RefLabel[], subject = "一种数据处理方法"): string {
  return `1. ${subject}，其特征在于，包括以下步骤：${items.map(item => `${item.label}（${item.ref}）`).join("；")}。`;
}

function descriptionParagraph(items: readonly RefLabel[], verb = "依次执行"): string {
  return `本申请实施例中，${items.map(item => `${item.label}${item.ref}`).join("、")}${verb}。`;
}

/** 组装分面可用的说明书文字部分（权利要求书 → 说明书五小节）。 */
function specTextOf(options: {
  claims: string;
  description: string;
  brief: string;
  inventionSummary?: string;
  techField?: string;
}): string {
  return [
    "权利要求书",
    options.claims,
    "",
    "说明书",
    "",
    "技术领域",
    options.techField ?? "本申请涉及一种数据处理方法，尤其涉及流程与结构的自动化处理。",
    "",
    "发明内容",
    options.inventionSummary ?? "本申请实施例提供一种数据处理方法，用于提高处理效率。",
    "",
    "附图说明",
    options.brief,
    "",
    "具体实施方式",
    options.description,
  ].join("\n");
}

function flowCase(id: string, title: string, count: number, documentKind: DocumentKind): GenBenchmarkCase {
  const items = flowItems(count);
  return {
    id,
    title,
    documentKind,
    figures: [tbFlow(1, items)],
    specText: specTextOf({
      claims: claimsParagraph(items),
      description: descriptionParagraph(items),
      brief: "图1为本申请实施例提供的流程示意图。",
    }),
  };
}

/** US 辖区分支（英文文字面）：V1 措辞改引 37 CFR 1.84、V9 不适用。 */
function usFlowCase(id: string, title: string, count: number): GenBenchmarkCase {
  const items = flowItems(count);
  const refs = items.map(item => `${item.label} (${item.ref})`).join("; ");
  const cited = items.map(item => `${item.label} ${item.ref}`).join(", ");
  return {
    id,
    title,
    jurisdiction: "us",
    documentKind: "invention",
    figures: [tbFlow(1, items, { abstract: true })],
    specText: [
      "CLAIMS",
      `1. A data processing method, comprising: ${refs}.`,
      "",
      "DESCRIPTION",
      "",
      "TECHNICAL FIELD",
      "The present disclosure relates to data processing.",
      "",
      "SUMMARY",
      "A data processing method is provided.",
      "",
      "BRIEF DESCRIPTION OF DRAWINGS",
      "FIG. 1 is a schematic flowchart of the method.",
      "",
      "DETAILED DESCRIPTION",
      `In an embodiment, the steps include ${cited}, which are executed in sequence.`,
    ].join("\n"),
  };
}

/** 长标注 CJK / Latin 同拓扑对照（字宽度量回归面：同节点数、不同字符类别）。 */
function longLabelCase(
  id: string,
  title: string,
  items: readonly RefLabel[],
  jurisdiction: Jurisdiction,
): GenBenchmarkCase {
  return {
    id,
    title,
    jurisdiction,
    documentKind: "invention",
    figures: [lrChain(1, items, { abstract: true })],
    specText: specTextOf({
      claims: claimsParagraph(items, "一种检测装置"),
      description: descriptionParagraph(items, "相互连接"),
      brief: "图1为本申请实施例提供的装置结构框图。",
    }),
  };
}

export const GENERATION_BENCHMARK_CASES: readonly GenBenchmarkCase[] = [
  flowCase("flow-tb-8", "8 步 TB 流程图（单图可印区内）", 8, "utility"),
  flowCase("flow-tb-12", "12 步 TB 流程图（曾静默通过、实被分页切断）", 12, "utility"),
  flowCase("flow-tb-16", "16 步 TB 流程图（画幅明显超框）", 16, "invention"),
  usFlowCase("flow-tb-8-us", "8 步 TB 流程图（US 辖区，英文文字面）", 8),
  longLabelCase(
    "block-cjk-long",
    "CJK 长标注方框图（字宽按全角 1em 度量）",
    [
      { label: "温度传感器信号采集与模数转换模块", ref: 10 },
      { label: "微控制器单元与实时任务调度中心", ref: 20 },
      { label: "无线通信模块与数据加密单元", ref: 30 },
      { label: "云端数据存储与可视化分析平台", ref: 40 },
    ],
    "cn",
  ),
  longLabelCase(
    "block-latin-long",
    "Latin 长标注方框图（字宽按半角 0.5em 度量）",
    [
      { label: "Temperature sensor acquisition module", ref: 10 },
      { label: "Microcontroller real-time scheduler", ref: 20 },
      { label: "Wireless communication module", ref: 30 },
      { label: "Cloud storage and analytics platform", ref: 40 },
    ],
    "us",
  ),
  {
    id: "block-lr-3node",
    title: "3 节点 LR 方框图（可印区内的正向对照）",
    documentKind: "invention",
    figures: [
      lrChain(
        1,
        [
          { label: "输入接口单元", ref: 10 },
          { label: "信号调理单元", ref: 20 },
          { label: "处理器单元", ref: 30 },
        ],
        { abstract: true },
      ),
    ],
    specText: specTextOf({
      claims: claimsParagraph(
        [
          { label: "输入接口单元", ref: 10 },
          { label: "信号调理单元", ref: 20 },
          { label: "处理器单元", ref: 30 },
        ],
        "一种信号处理装置",
      ),
      description: descriptionParagraph(
        [
          { label: "输入接口单元", ref: 10 },
          { label: "信号调理单元", ref: 20 },
          { label: "处理器单元", ref: 30 },
        ],
        "依次连接",
      ),
      brief: "图1为本申请实施例提供的装置结构框图。",
    }),
  },
  {
    id: "block-lr-wide",
    title: "6 级 LR 串联方框图（横向超框面）",
    documentKind: "invention",
    figures: [
      lrChain(
        1,
        [
          { label: "输入接口单元", ref: 10 },
          { label: "信号调理单元", ref: 20 },
          { label: "处理器单元", ref: 30 },
          { label: "存储单元", ref: 40 },
          { label: "输出驱动单元", ref: 50 },
          { label: "电源管理单元", ref: 60 },
        ],
        { abstract: true },
      ),
    ],
    specText: specTextOf({
      claims: claimsParagraph(
        [
          { label: "输入接口单元", ref: 10 },
          { label: "信号调理单元", ref: 20 },
          { label: "处理器单元", ref: 30 },
          { label: "存储单元", ref: 40 },
          { label: "输出驱动单元", ref: 50 },
          { label: "电源管理单元", ref: 60 },
        ],
        "一种信号处理装置",
      ),
      description: descriptionParagraph(
        [
          { label: "输入接口单元", ref: 10 },
          { label: "信号调理单元", ref: 20 },
          { label: "处理器单元", ref: 30 },
          { label: "存储单元", ref: 40 },
          { label: "输出驱动单元", ref: 50 },
          { label: "电源管理单元", ref: 60 },
        ],
        "依次连接",
      ),
      brief: "图1为本申请实施例提供的装置结构框图。",
    }),
  },
  {
    id: "bracket-faces",
    title: "括号按面判定（权利要求漏括号 + 正文用括号）",
    documentKind: "invention",
    figures: [
      tbFlow(1, [
        { label: "壳体", ref: 10 },
        { label: "设于壳体内部的检测单元", ref: 20 },
        { label: "与检测单元连接的控制器", ref: 30 },
      ]),
    ],
    specText: specTextOf({
      // 权利要求面用"名称+裸数字"：V10 fail
      claims: "1. 一种检测装置，其特征在于，包括壳体10、设于壳体10内部的检测单元20以及与检测单元20连接的控制器30。",
      // 正文面用括号形式：V11 warn
      description: "本申请实施例中，壳体(10)内部设有检测单元(20)，检测单元(20)与控制器(30)电连接。",
      brief: "图1为本申请实施例提供的检测装置结构示意图。",
    }),
  },
  {
    id: "label-normalization",
    title: "同组件跨图两种标注形态（名称归一化，V4 不得误报）",
    documentKind: "utility",
    figures: [
      {
        figure_no: 1,
        kind: "block",
        direction: "LR",
        abstract: true,
        nodes: [
          { id: "m20", label: "处理模块(20)", ref: 20, shape: "rect" },
          { id: "f1-u10", label: "输入单元(10)", ref: 10, shape: "rect" },
        ],
        edges: [{ from: "f1-u10", to: "m20" }],
      },
      {
        figure_no: 2,
        kind: "block",
        direction: "LR",
        nodes: [
          { id: "m20", label: "处理模块20", ref: 20, shape: "rect" },
          { id: "f2-o30", label: "输出单元30", ref: 30, shape: "rect" },
        ],
        edges: [{ from: "m20", to: "f2-o30" }],
      },
    ],
    specText: specTextOf({
      claims: "1. 一种处理装置，其特征在于，包括输入单元（10）、处理模块（20）与输出单元（30）。",
      description: "本申请实施例中，输入单元10与处理模块20连接，处理模块20将结果送至输出单元30。",
      brief: "图1为本申请实施例提供的处理装置输入侧框图；图2为处理装置输出侧框图。",
    }),
  },
  {
    id: "uniform-zoom-mixed",
    title: "混排画幅（一图超高 → 统一缩放 < 1 且打印字高不足）",
    documentKind: "invention",
    figures: [tbFlow(1, flowItems(12), { abstract: true }), tbFlow(2, flowItems(4))],
    specText: specTextOf({
      claims: `${claimsParagraph(flowItems(12))}\n2. 一种数据处理装置，其特征在于，用于执行权利要求1所述的方法。`,
      description: `${descriptionParagraph(flowItems(12))}图2所示的简化流程同样由上述单元配合完成。`,
      brief: "图1为本申请实施例提供的完整流程示意图；图2为简化流程示意图。",
    }),
  },
];
