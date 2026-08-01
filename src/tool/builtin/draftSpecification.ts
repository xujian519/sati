import type { SatiToolDefinition } from "../protocol/types.js";
import { DOMAIN_KEYWORDS, type PatentType, type TechDomain } from "./draftClaims.js";

/**
 * draft_specification — 专利说明书草案生成（移植自 Mady domains/specdrafting）。
 *
 * 组装技术领域、背景技术、发明内容（问题-方案-效果三段式）、附图说明、
 * 具体实施方式五部分。确定性模板实现，缺失内容生成撰写指引。
 */

export type DraftSpecificationInput = {
  /** 发明名称（不超过 25 字） */
  title: string;
  /** 技术领域 */
  tech_domain?: TechDomain;
  /** 专利类型：发明或实用新型（默认 invention） */
  patent_type?: PatentType;
  /** 要解决的技术问题（可选） */
  technical_problem?: string;
  /** 技术方案描述（可选） */
  technical_solution?: string;
  /** 有益效果（可选） */
  beneficial_effects?: string;
  /** 背景技术/现有技术描述（可选） */
  background?: string;
  /** 附图说明（可选，如 "图1为本发明实施例的整体结构示意图"） */
  drawing_descriptions?: string[];
  /** 具体实施方式（可选，可多个实施例） */
  embodiments?: string[];
  /** 是否有附图（实用新型必须有附图） */
  has_drawings?: boolean;
};

export type SpecificationSection = {
  name: string;
  content: string;
  /** 是否为模板引导（缺少用户输入时的撰写指引） */
  placeholder: boolean;
};

export type DraftSpecificationOutput = {
  title: string;
  tech_domain: TechDomain;
  patent_type: PatentType;
  sections: SpecificationSection[];
  warnings: string[];
};

export function createDraftSpecificationTool(): SatiToolDefinition<DraftSpecificationInput, DraftSpecificationOutput> {
  return {
    name: "draft_specification",
    title: "Draft Patent Specification",
    description:
      "根据技术交底书或技术方案撰写符合要求的专利说明书草案（技术领域/背景技术/发明内容/附图说明/具体实施方式五部分）。当用户要求撰写说明书、写专利申请文件时使用，避免自行手写说明书文本。",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "发明名称（不超过 25 字）" },
        tech_domain: {
          type: "string",
          enum: ["mechanical", "electrical", "chemical", "software", "general"],
          description: "技术领域（为空时自动识别）",
        },
        patent_type: {
          type: "string",
          enum: ["invention", "utility_model"],
          description: "专利类型：发明或实用新型（默认 invention）",
        },
        technical_problem: { type: "string", description: "要解决的技术问题（可选）" },
        technical_solution: { type: "string", description: "技术方案描述（可选）" },
        beneficial_effects: { type: "string", description: "有益效果（可选）" },
        background: { type: "string", description: "背景技术/现有技术描述（可选）" },
        drawing_descriptions: {
          type: "array",
          items: { type: "string" },
          description: '附图说明（可选，如 "图1为本发明实施例的整体结构示意图"）',
        },
        embodiments: {
          type: "array",
          items: { type: "string" },
          description: "具体实施方式（可选，可多个实施例）",
        },
        has_drawings: { type: "boolean", description: "是否有附图（实用新型必须有附图）" },
      },
      required: ["title"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => {
      const output = draftSpecification(input);
      return {
        content: [{ type: "json", value: output }],
        data: output,
      };
    },
  };
}

/** 纯函数入口：组装五部分说明书草案。 */
export function draftSpecification(input: DraftSpecificationInput): DraftSpecificationOutput {
  const title = input.title.trim();
  const patentType: PatentType = input.patent_type ?? "invention";
  const domain = resolveDomain(input.tech_domain, title, input);

  const warnings: string[] = [];
  if (title.length > 25) warnings.push(`发明名称 ${title.length} 字，超过 25 字限制`);
  if (patentType === "utility_model" && !input.has_drawings) {
    warnings.push("实用新型必须有附图，请确认补充附图");
  }

  const sections: SpecificationSection[] = [
    buildTechField(title, domain),
    buildBackground(input.background),
    buildContent(input),
    buildDrawings(input.drawing_descriptions, input.has_drawings),
    buildEmbodiments(input.embodiments, patentType),
  ];

  return {
    title,
    tech_domain: domain,
    patent_type: patentType,
    sections,
    warnings,
  };
}

function buildTechField(title: string, domain: TechDomain): SpecificationSection {
  const domainLabel =
    domain === "mechanical"
      ? "机械"
      : domain === "electrical"
        ? "电学"
        : domain === "chemical"
          ? "化学"
          : domain === "software"
            ? "软件"
            : "";
  const content = `本发明涉及${domainLabel}技术领域，尤其涉及一种${title}。`;
  return { name: "技术领域", content, placeholder: false };
}

function buildBackground(background?: string): SpecificationSection {
  if (background && background.trim()) {
    return { name: "背景技术", content: background.trim(), placeholder: false };
  }
  return {
    name: "背景技术",
    content:
      "【撰写指引】描述现有技术的不足：① 引证与本申请最接近的现有技术文件并注明出处；② 指出现有技术存在的问题/缺陷，引出本申请要解决的技术问题。",
    placeholder: true,
  };
}

function buildContent(input: DraftSpecificationInput): SpecificationSection {
  const parts: string[] = [];
  const problem = input.technical_problem?.trim();
  const solution = input.technical_solution?.trim();
  const effects = input.beneficial_effects?.trim();

  if (problem) {
    parts.push(`本发明要解决的技术问题是：${problem}`);
  } else {
    parts.push("【撰写指引】记载要解决的技术问题（与背景技术的缺陷对应）。");
  }
  if (solution) {
    parts.push(`为解决上述技术问题，本发明提供如下技术方案：${solution}`);
  } else {
    parts.push("【撰写指引】记载技术方案（与权利要求的技术特征对应，问题→方案→效果逻辑链完整）。");
  }
  if (effects) {
    parts.push(`本发明的有益效果是：${effects}`);
  } else {
    parts.push("【撰写指引】记载有益效果（与区别技术特征对应，有对比实验或理论推导支撑）。");
  }
  return { name: "发明内容", content: parts.join("\n"), placeholder: !(problem && solution && effects) };
}

function buildDrawings(descriptions?: string[], hasDrawings?: boolean): SpecificationSection {
  if (descriptions && descriptions.length > 0) {
    const content = descriptions
      .map((d, i) => {
        const trimmed = d.trim();
        // 用户已显式给图号（"图2为…"/"图一为…"/"附图2为…"）时保留原样，否则按顺序编号
        return /^(?:图|附图)\s*(?:\d+|[一二三四五六七八九十]+)/.test(trimmed) ? trimmed : `图${i + 1}为${trimmed}`;
      })
      .join("\n");
    return { name: "附图说明", content, placeholder: false };
  }
  if (hasDrawings) {
    return {
      name: "附图说明",
      content: "【撰写指引】按图序逐图说明：图1为整体结构示意图，图2为局部放大图（按实际附图调整）。",
      placeholder: true,
    };
  }
  return {
    name: "附图说明",
    content: "【撰写指引】如无附图可省略本节；如有附图，按图序说明每幅附图的图名和内容。",
    placeholder: true,
  };
}

function buildEmbodiments(embodiments?: string[], patentType?: PatentType): SpecificationSection {
  if (embodiments && embodiments.length > 0) {
    const content = embodiments.map((e, i) => `实施例${i + 1}：${e.trim()}`).join("\n");
    return { name: "具体实施方式", content, placeholder: false };
  }
  return {
    name: "具体实施方式",
    content: `【撰写指引】撰写至少一个实施例，使所属领域技术人员能够实现：① 实施例的操作步骤/参数/条件记载完整；② 数值范围给出端点值和至少一个中间值的实施例；③ 有益效果有定量效果数据；④ 有与最接近现有技术的对比实验数据（${patentType === "utility_model" ? "实用新型" : "创造性"}判断的关键支撑）。`,
    placeholder: true,
  };
}

function resolveDomain(hint: TechDomain | undefined, title: string, input: DraftSpecificationInput): TechDomain {
  if (hint && hint !== "general") return hint;
  const haystack = `${title} ${input.technical_solution ?? ""} ${input.background ?? ""}`;
  for (const entry of DOMAIN_KEYWORDS) {
    if (entry.keywords.some(k => haystack.includes(k))) return entry.domain;
  }
  return "general";
}
