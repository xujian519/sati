/**
 * src/patent/clarity — 交底书清晰度准入（机械信号层，确定性正则零依赖）。
 *
 * 设计对齐 Ouroboros 的"问题前移"思想：解构/提取之前先量化交底书质量——
 * 模糊交底书进入 PFE 提取与撰写管线是返工的主要原因。本层是**机械层**
 * （免费、确定性、可审计），语义层（LLM 四维打分）见 atoms/handlers/builtin/clarity.ts；
 * 两信号融合与门判定见 ./score.ts。
 *
 * 四维结构信号（与 score.ts 的维度权重一致）：
 * - problem：技术问题表述（"要解决…问题/现有…不足/缺陷"等锚点）
 * - solution：技术手段表述（设置/利用/包括…结构名词；技术方案标记）
 * - effect：可测效果（定量数据 / 效果动词 + 数值 / 对比句式）
 * - enablement：实施充分（实施例/参数/附图/步骤编号）
 *
 * 信号只回答"文档里有没有"，不评判"好不好"（那是语义层职责）——
 * 因此信号永不误伤：漏检只降一档融合分，不会直接判死。
 */

// ---------------------------------------------------------------------------
// 信号锚点（纯数据；修改词表需同步更新 tests/patent/clarity.spec.ts 样本）
// ---------------------------------------------------------------------------

/** 问题信号：问题/缺陷/不足锚点句。 */
const PROBLEM_MARKERS: readonly RegExp[] = [
  /(?:要解决|解决|针对)[^。；；]{0,24}(?:问题|缺陷|不足|难点|痛点)/,
  /(?:现有|传统|目前)[^。；]{0,24}(?:问题|缺陷|不足|缺点)/,
  /(?:存在的问题|技术问题)/,
  /(?:尚|仍|未)[^。；]{0,16}(?:缺乏|不足|存在)/,
];

/** 方案信号：手段性表述（动词 + 结构名词 / 方法步骤 / 技术方案标记）。 */
const SOLUTION_MARKERS: readonly RegExp[] = [
  /(?:采用|利用|通过|包括|包含|设置|增设|引入|配置|使用|借助)[^。；]{1,18}(?:结构|装置|组件|模块|系统|单元|机构|阀|泵|圈|垫|层|板|管|杆|盖|壳|罩|支架|电路|算法|方法)/,
  /(?:技术方案|发明内容|本(?:发明|实用新型|申请|方案))[^。；]{0,30}/,
  /(?:步骤|流程|工艺|配方)[1-9一二三四五六七八九十]?[^。；]{0,24}(?:包括|为|：|:)/,
];

/** 效果信号：定量数据或效果动词搭配数值/对比。 */
const EFFECT_MARKERS: readonly RegExp[] = [
  /\d+(?:\.\d+)?\s*(?:%|％|℃|°C|度|dB|mm|cm|m|kg|h|小时|天|次|倍|ppm|MPa|kPa|V|A|W|ml|L)/,
  /(?:提升|降低|减少|增加|升高|下降|缩短|延长|达到|提高)[^。；]{0,12}\d/,
  /(?:有益效果|技术效果)/,
  /(?:相比|相对于|对比|从\s*\d)[^。；]{0,30}(?:提升|降低|减少|增加|提高|缩短|延长)/,
];

/** 实施信号：实施例/参数/附图/编号细节。 */
const ENABLEMENT_MARKERS: readonly RegExp[] = [
  /(?:实施例|具体实施|实施方式)/,
  /(?:参数|尺寸|厚度|长度|宽度|高度|温度|压力|浓度|比例|转速|重量)/,
  /(?:附图|图\s*[0-9一二三四五六七八九十]+)/,
  /(?:步骤\s*[0-9一二三四五六七八九十]+|第\s*[0-9一二三四五六七八九十]+\s*步)/,
  /(?:示例|例如[^。；]{0,20}(?:℃|%|毫米|MPa|[0-9]))/,
];

// ---------------------------------------------------------------------------
// 类型与实现
// ---------------------------------------------------------------------------

export type ClaritySignalKey = "problem" | "solution" | "effect" | "enablement";

export type ClaritySignal = {
  /** 维度键（与 score.ts 的维度一致）。 */
  key: ClaritySignalKey;
  /** 文档是否存在该维度结构信号（0/1 融合输入）。 */
  present: boolean;
  /** 命中证据片段（原文字句，供报告与语义层 prompt 引用；≤ 2 条）。 */
  evidence: string[];
  /** 缺失时的人类可读说明（报告展示）。 */
  missingHint?: string;
};

const SIGNAL_META: ReadonlyArray<{
  key: ClaritySignalKey;
  markers: readonly RegExp[];
  missingHint: string;
  evidenceLimit: number;
}> = [
  {
    key: "problem",
    markers: PROBLEM_MARKERS,
    missingHint: "未识别到明确的技术问题锚点（“要解决…问题/现有…不足”）",
    evidenceLimit: 2,
  },
  {
    key: "solution",
    markers: SOLUTION_MARKERS,
    missingHint: "未识别到手段性描述（结构/方法/工艺步骤）",
    evidenceLimit: 2,
  },
  {
    key: "effect",
    markers: EFFECT_MARKERS,
    missingHint: "未识别到可测效果表述（定量数据或对比句式）",
    evidenceLimit: 2,
  },
  {
    key: "enablement",
    markers: ENABLEMENT_MARKERS,
    missingHint: "未识别到实施细节（实施例/参数/附图/步骤编号）",
    evidenceLimit: 2,
  },
];

/** 提取命中句（按句界截断，防长文证据膨胀）。 */
function extractSentence(text: string, index: number): string {
  const start =
    Math.max(
      0,
      text.lastIndexOf(".", index),
      text.lastIndexOf("。", index),
      text.lastIndexOf("；", index),
      text.lastIndexOf(";", index),
    ) + 1;
  const end = Math.min(text.length, index + 40);
  const sentence = text.slice(start, end).trim();
  return sentence.slice(0, 60);
}

/**
 * 检测交底书的结构信号（确定性）。
 * 每维：存在任一锚点即 present=true，evidence 取命中的句子（去重、限条数）。
 */
export function detectClaritySignals(text: string): ClaritySignal[] {
  const signals: ClaritySignal[] = [];
  for (const meta of SIGNAL_META) {
    const evidence: string[] = [];
    for (const marker of meta.markers) {
      let match: RegExpExecArray | null;
      const re = new RegExp(marker.source, marker.flags.includes("g") ? marker.flags : `${marker.flags}g`);
      while ((match = re.exec(text)) !== null && evidence.length < meta.evidenceLimit) {
        const sentence = extractSentence(text, match.index);
        if (sentence.length > 0 && !evidence.includes(sentence)) evidence.push(sentence);
        if (match[0].length === 0) re.lastIndex += 1;
      }
      if (evidence.length >= meta.evidenceLimit) break;
    }
    signals.push({
      key: meta.key,
      present: evidence.length > 0,
      evidence,
      ...(evidence.length === 0 ? { missingHint: meta.missingHint } : {}),
    });
  }
  return signals;
}

/** 便捷：按 key 取信号（score 层/报告渲染用）。 */
export function signalFor(signals: readonly ClaritySignal[], key: ClaritySignalKey): ClaritySignal | undefined {
  return signals.find(s => s.key === key);
}
