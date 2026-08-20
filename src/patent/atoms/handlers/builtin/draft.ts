/**
 * 撰写域原子：draft-claims（基于 PFE 与新颖性结果直出权利要求草稿）+
 * draft-spec（说明书七部分撰写 + 确定性合规校验）。
 */

import { type Atom } from "../../atom.js";
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
  getStateString,
} from "../../handler.js";
import {
  checkEffectQuantification,
  checkNumericRangeCoverage,
  checkSectionCompleteness,
  formatRange,
} from "../../../spec/checks.js";
import { callLlm, degraded, parseLlmJson, requireLlm } from "./llm.js";

export const draftClaimsAtom: Atom = {
  name: "draft-claims",
  description: "基于 PFE 与新颖性结果直出权利要求草稿（独立+从属）",
  category: "extract",
  inputSchema: ["pfe_triples", "merge_result", "novelty_conclusion", "source_text"],
  outputSchema: ["claims_draft", "draft_claims_result"],
};

const DRAFT_CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    claims: { type: "array", items: { type: "string" }, description: "权利要求逐条文本" },
    notes: { type: "string", description: "撰写说明（保护范围/布局建议）" },
  },
  required: ["claims"],
} as const;

export class DraftClaimsHandler implements StageHandler {
  readonly name = "draft-claims";
  readonly category = "extract" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "draft-claims");
    if (missing) return missing;
    const mergeResult = getStateString(state, "merge_result");
    const pfeTriples = getStateArray(state, "pfe_triples");
    const novelty = getStateString(state, "novelty_conclusion");
    const source = getStateString(state, "source_text");
    const input = mergeResult || (pfeTriples.length > 0 ? JSON.stringify(pfeTriples, null, 2) : "") || source;
    if (input.trim().length === 0) {
      return degraded("draft-claims", "输入为空（state.merge_result / pfe_triples / source_text）");
    }
    const prompt = [
      "你是专利权利要求撰写专家。基于以下技术交底书分析结果，撰写权利要求书草稿。",
      "要求：",
      "- 独立权利要求包含解决技术问题的全部必要技术特征",
      "- 从属权利要求对独立权利要求做细化限定（结构/参数/方法步骤）",
      "- 权利要求清楚、简要，避免含义不确定的术语",
      "- 避免过宽的功能性限定；功能性限定以说明书公开的实施方式为限",
      "- 与新颖性分析结论一致：区别特征应体现在独立权利要求中",
      "",
      "【分析结果】",
      "```",
      input.slice(0, 8000),
      "```",
      novelty.trim().length > 0 ? `【新颖性结论】\n${novelty.slice(0, 2000)}` : "",
      "",
      "请严格输出 JSON：claims 为权利要求逐条文本数组（第 1 条为独立权利要求），notes 为撰写说明。",
    ].join("\n");
    const res = await callLlm(provider, "draft-claims", prompt, { schema: DRAFT_CLAIMS_SCHEMA, temperature: 0.2 });
    if (!res.ok) return res.error;
    return parseLlmJson(
      res.raw,
      (parsed, raw) => {
        if (!Array.isArray(parsed.claims)) return null;
        return {
          claims_draft: parsed.claims.map(String).join("\n\n"),
          draft_claims_result: raw,
        };
      },
      raw => ({ claims_draft: raw }),
    );
  }
}

// ---------------------------------------------------------------------------
// draft-spec —— 说明书撰写 + 确定性合规校验
// ---------------------------------------------------------------------------

export const draftSpecAtom: Atom = {
  name: "draft-spec",
  description:
    "基于 PFE 与权利要求草稿撰写专利说明书（技术领域/背景技术/发明内容/附图说明/具体实施方式/摘要），附确定性合规校验报告",
  category: "extract",
  inputSchema: ["claims_draft", "pfe_triples", "merge_result", "novelty_conclusion", "source_text"],
  outputSchema: ["spec_draft", "spec_validation"],
};

const DRAFT_SPEC_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "发明名称（不超过 25 字）" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "章节名：技术领域/背景技术/发明内容/附图说明/具体实施方式/摘要",
          },
          content: { type: "string", description: "章节内容" },
        },
        required: ["name", "content"],
      },
    },
  },
  required: ["title", "sections"],
} as const;

/** 说明书草稿校验违规项。 */
export type SpecViolation = {
  rule: string;
  severity: "error" | "warning";
  message: string;
};

/** 说明书草稿确定性校验（纯函数，供单测与 handler 复用；warning 不判失败）。 */
export function validateDraftSpec(specText: string, title?: string): { passed: boolean; violations: SpecViolation[] } {
  const violations: SpecViolation[] = [];
  // 章节完整性（error）
  for (const missing of checkSectionCompleteness(specText)) {
    violations.push({ rule: "section_missing", severity: "error", message: `缺少章节：${missing}` });
  }
  // 发明名称长度（warning）
  if (title !== undefined && title.trim().length > 25) {
    violations.push({
      rule: "title_length",
      severity: "warning",
      message: `发明名称 ${title.trim().length} 字，超过 25 字限制`,
    });
  }
  // 效果定量性（error：无数字支撑的效果套话）
  for (const hit of checkEffectQuantification(specText)) {
    violations.push({
      rule: "effect_quantification",
      severity: "error",
      message: `效果表述缺少定量数据：${hit}`,
    });
  }
  // 数值范围端点/中间值实施例（warning）
  const { endpointMissing, midpointMissing } = checkNumericRangeCoverage(specText);
  for (const range of endpointMissing) {
    violations.push({
      rule: "numeric_range_endpoint",
      severity: "warning",
      message: `数值范围 ${formatRange(range)} 缺少端点值实施例`,
    });
  }
  for (const range of midpointMissing) {
    violations.push({
      rule: "numeric_range_midpoint",
      severity: "warning",
      message: `数值范围 ${formatRange(range)} 缺少中间值实施例`,
    });
  }
  return { passed: violations.every(v => v.severity !== "error"), violations };
}

/**
 * 追加实施例覆盖缺口 warning（T7）：读 claim-embodiment-mapper 产出的
 * claim_coverage_result（矩阵+check），把无实施例支撑的特征追加为 warning 级
 * 违规——不翻转 passed（validateDraftSpec 只判 error）；矩阵缺失/降级/非 JSON
 * 时跳过（fail-open，撰写流程不受影响）。
 */
function appendCoverageWarnings(
  validation: { passed: boolean; violations: SpecViolation[] },
  state: PipelineState,
): { passed: boolean; violations: SpecViolation[] } {
  const raw = getStateString(state, "claim_coverage_result");
  if (raw.length === 0) return validation;
  let matrix: { check?: { missingEmbodiment?: Array<{ claimId: string; feature: string }> } } | undefined;
  try {
    matrix = JSON.parse(raw) as typeof matrix;
  } catch {
    return validation;
  }
  const missing = matrix?.check?.missingEmbodiment;
  if (missing === undefined || missing.length === 0) return validation;
  return {
    ...validation,
    violations: [
      ...validation.violations,
      ...missing.map(m => ({
        rule: "claim_embodiment_coverage",
        severity: "warning" as const,
        message: `权利要求特征 "${m.feature}"（${m.claimId}）在交底书实施例中无支撑，请在具体实施方式中补充对应实施例`,
      })),
    ],
  };
}

const SPEC_SECTION_ORDER = ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式", "摘要"];

/** 组装说明书 Markdown：固定章节顺序 + 标题，未知章节追加末尾。 */
function renderSpecMarkdown(title: string, sections: Array<{ name: string; content: string }>): string {
  const lines: string[] = [];
  const normalized = sections
    .map(s => ({ name: s.name.trim(), content: s.content.trim() }))
    .filter(s => s.name.length > 0 && s.content.length > 0);
  const byName = new Map(normalized.map(s => [s.name, s.content]));
  const known = new Set(SPEC_SECTION_ORDER);
  if (title.trim().length > 0) lines.push(`# ${title.trim()}`);
  for (const name of SPEC_SECTION_ORDER) {
    const content = byName.get(name);
    if (content === undefined) continue;
    lines.push(`## ${name}\n${content}`);
  }
  for (const s of normalized) {
    if (!known.has(s.name)) lines.push(`## ${s.name}\n${s.content}`);
  }
  return lines.join("\n\n");
}

export class DraftSpecHandler implements StageHandler {
  readonly name = "draft-spec";
  readonly category = "extract" as const;

  async execute({ state, provider }: StageExecuteInput): Promise<PipelineState> {
    const missing = requireLlm(provider, "draft-spec");
    if (missing) return missing;
    const claims = getStateString(state, "claims_draft");
    const mergeResult = getStateString(state, "merge_result");
    const pfeTriples = getStateArray(state, "pfe_triples");
    const novelty = getStateString(state, "novelty_conclusion");
    const source = getStateString(state, "source_text");
    const input = claims || mergeResult || (pfeTriples.length > 0 ? JSON.stringify(pfeTriples, null, 2) : "") || source;
    if (input.trim().length === 0) {
      return degraded("draft-spec", "输入为空（state.claims_draft / merge_result / pfe_triples / source_text）");
    }
    const prompt = [
      "你是中国专利说明书撰写专家（20 年资深代理师）。基于以下技术交底书分析结果与权利要求草稿，撰写专利说明书。",
      "要求：",
      "1. 按七部分组织：技术领域 / 背景技术 / 发明内容（技术问题+技术方案+有益效果，有益效果 3-5 项且量化）/ 附图说明（无附图可省略本节；有附图时按图序说明，附图标记与图面一致）/ 具体实施方式（至少 1 个可实施实施例，覆盖权利要求全部技术特征；数值范围给出端点值与至少一个中间值实施例；效果附定量数据）/ 摘要（不超过 300 字）",
      '2. 背景技术客观描述最接近现有技术及其不足，引证文件注明出处（首次全称"下称D1"）',
      "3. 发明内容的技术方案与权利要求一致",
      '4. 禁止：商业宣传用语（最佳/最优/革命性）、"如权利要求…所述"引用语、模糊用语（约/大约/优选/例如/可能/较好）',
      "5. 发明名称不超过 25 字",
      "",
      "【权利要求草稿】",
      "```",
      claims.trim().length > 0 ? claims.slice(0, 4000) : "（无，将按技术方案撰写）",
      "```",
      novelty.trim().length > 0 ? `【新颖性结论/区别特征】\n${novelty.slice(0, 2000)}` : "",
      "【技术交底书分析】",
      "```",
      input.slice(0, 6000),
      "```",
      "",
      '请严格输出 JSON：title 为发明名称，sections 为章节数组（name 取"技术领域/背景技术/发明内容/附图说明/具体实施方式/摘要"之一，content 为章节正文）。',
    ].join("\n");
    const res = await callLlm(provider, "draft-spec", prompt, { schema: DRAFT_SPEC_SCHEMA, temperature: 0.2 });
    if (!res.ok) return res.error;
    return parseLlmJson(
      res.raw,
      parsed => {
        if (!Array.isArray(parsed.sections)) return null;
        const title = String(parsed.title ?? "").trim();
        const sections = parsed.sections
          .filter(s => s !== null && typeof s === "object" && !Array.isArray(s))
          .map(s => ({
            name: String((s as Record<string, unknown>).name ?? ""),
            content: String((s as Record<string, unknown>).content ?? ""),
          }));
        const specText = renderSpecMarkdown(title, sections);
        const validation = appendCoverageWarnings(validateDraftSpec(specText, title), state);
        return { spec_draft: specText, spec_validation: JSON.stringify(validation, null, 2) };
      },
      raw => {
        // 非 JSON 输出：原文作为说明书草稿，仍跑确定性校验（章节可能缺失，如实报告）。
        const validation = appendCoverageWarnings(validateDraftSpec(raw), state);
        return { spec_draft: raw, spec_validation: JSON.stringify(validation, null, 2) };
      },
    );
  }
}
