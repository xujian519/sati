import type { SatiToolDefinition } from "../protocol/types.js";

/**
 * draft_claims — 权利要求书草案生成（移植自 Mady domains/claimdrafting）。
 *
 * 五步法：特征分类 → 确定技术领域 → 确定必要技术特征 → 撰写独立权利要求
 * （前序部分 + 特征部分）→ 撰写从属权利要求（多层级布局）。
 * 内置形式校验（编号顺序 / 句号结尾 / 模糊词 / 附图引用），确定性实现。
 */

export type TechDomain = "mechanical" | "electrical" | "chemical" | "software" | "general";
export type PatentType = "invention" | "utility_model";

export type DraftClaimsInput = {
  /** 发明名称 */
  invention_name: string;
  /** 技术领域（为空时自动识别） */
  tech_domain?: TechDomain;
  /** 专利类型：发明或实用新型（默认 invention） */
  patent_type?: PatentType;
  /** 必要技术特征列表（用于独立权利要求） */
  technical_features: string[];
  /** 附加/可选技术特征列表（用于从属权利要求） */
  optional_features?: string[];
  /** 最接近现有技术描述（可选，用于前序部分） */
  prior_art?: string;
};

export type DraftedClaim = {
  number: number;
  type: "independent" | "dependent";
  text: string;
  refersTo?: number;
};

export type ClaimViolation = {
  rule: string;
  severity: "error" | "warning";
  claimNumber?: number;
  message: string;
  suggestion?: string;
};

export type DraftClaimsOutput = {
  invention_name: string;
  tech_domain: TechDomain;
  claims: DraftedClaim[];
  violations: ClaimViolation[];
  warnings: string[];
};

/** 模糊限定词（清楚性规则）。 */
const VAGUE_TERMS = ["约", "大致", "可能", "优选", "例如", "大约", "左右"];

/** 领域 → 前序部分模板。 */
const DOMAIN_PREAMBLE: Record<TechDomain, (name: string) => string> = {
  mechanical: name => `一种${name}，其特征在于，包括：`,
  electrical: name => `一种${name}，其特征在于，包括：`,
  chemical: name => `一种${name}，其特征在于，包含：`,
  software: name => `一种${name}的实现方法，其特征在于，包括以下步骤：`,
  general: name => `一种${name}，其特征在于，包括：`,
};

/** 领域关键词 → 自动识别技术领域（draft_claims 与 draft_specification 共享）。 */
export const DOMAIN_KEYWORDS: Array<{ domain: TechDomain; keywords: string[] }> = [
  { domain: "chemical", keywords: ["组分", "化合物", "合成", "催化剂", "溶液", "材料组合物", "重量份"] },
  { domain: "software", keywords: ["步骤", "算法", "数据", "模块", "接口", "处理器执行", "电子设备"] },
  { domain: "electrical", keywords: ["电路", "电源", "信号", "传感器", "控制器", "芯片", "电压"] },
  { domain: "mechanical", keywords: ["壳体", "齿轮", "轴承", "支架", "轴", "弹簧", "连接件", "传动"] },
];

export function createDraftClaimsTool(): SatiToolDefinition<DraftClaimsInput, DraftClaimsOutput> {
  return {
    name: "draft_claims",
    title: "Draft Patent Claims",
    description:
      "根据技术交底书或技术方案撰写权利要求书草案（机械/电学/化学/软件四领域）。当用户要求撰写权利要求、写权利要求书时使用，避免自行手写权利要求文本。输出独立权利要求 + 从属权利要求 + 形式校验报告。",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        invention_name: { type: "string", description: "发明名称" },
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
        technical_features: {
          type: "array",
          items: { type: "string" },
          description: "必要技术特征列表（用于独立权利要求）",
        },
        optional_features: {
          type: "array",
          items: { type: "string" },
          description: "附加/可选技术特征列表（用于从属权利要求）",
        },
        prior_art: { type: "string", description: "最接近现有技术描述（可选，用于前序部分）" },
      },
      required: ["invention_name", "technical_features"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => {
      const output = draftClaims(input);
      return {
        content: [{ type: "json", value: output }],
        data: output,
      };
    },
  };
}

/** 纯函数入口：生成权利要求书草案 + 形式校验。 */
export function draftClaims(input: DraftClaimsInput): DraftClaimsOutput {
  const name = input.invention_name.trim();
  const domain = resolveDomain(input.tech_domain, name, input.technical_features);
  const essential = input.technical_features.map(f => f.trim()).filter(Boolean);
  const optional = (input.optional_features ?? []).map(f => f.trim()).filter(Boolean);

  const warnings: string[] = [];
  if (essential.length === 0) {
    warnings.push("未提供必要技术特征，独立权利要求无法生成完整技术方案");
  }
  if (name.length > 25) {
    warnings.push(`发明名称 ${name.length} 字，超过 25 字限制`);
  }

  // 1) 独立权利要求（前序 + 特征部分）
  const independentText = buildIndependentClaim(name, domain, essential, input.prior_art?.trim() ?? "");

  // 2) 从属权利要求（由 optional 特征引导，逐层限定形成梯度保护）
  const dependents: DraftedClaim[] = optional.map((feat, idx) => {
    const number = 2 + idx;
    const refersTo = number - 1;
    return {
      number,
      type: "dependent",
      refersTo,
      text: `根据权利要求${refersTo}所述的${name}，其特征在于，还包括：${feat}。`,
    };
  });

  const claims: DraftedClaim[] = [{ number: 1, type: "independent", text: independentText }, ...dependents];

  // 3) 形式校验
  const violations = validateClaims(claims);

  return {
    invention_name: name,
    tech_domain: domain,
    claims,
    violations,
    warnings,
  };
}

function buildIndependentClaim(name: string, domain: TechDomain, features: string[], priorArt: string): string {
  const preamble = DOMAIN_PREAMBLE[domain](name);
  if (features.length === 0) {
    return `${preamble}（缺少必要技术特征）`;
  }
  const featurePart = features.join("；");
  if (domain === "software") {
    // 软件领域：步骤化特征
    const steps = features.map((f, i) => `${f}${i < features.length - 1 ? "；" : ""}`).join("");
    return `一种${name}的实现方法，其特征在于，包括以下步骤：${steps}。`;
  }
  // prior_art（最接近现有技术的共有特征）置于前序部分（"其特征在于"之前），
  // 特征部分承载区别特征 —— 符合专利撰写规范
  if (priorArt && priorArt.length > 0) {
    return `一种${name}，包括：${priorArt}；其特征在于，还包括：${featurePart}。`;
  }
  return `${preamble}${featurePart}。`;
}

function resolveDomain(hint: TechDomain | undefined, name: string, features: string[]): TechDomain {
  if (hint && hint !== "general") return hint;
  const haystack = `${name} ${features.join(" ")}`;
  for (const entry of DOMAIN_KEYWORDS) {
    if (entry.keywords.some(k => haystack.includes(k))) return entry.domain;
  }
  return "general";
}

/** 形式校验：编号顺序 / 句号结尾 / 模糊词 / 附图引用。 */
function validateClaims(claims: DraftedClaim[]): ClaimViolation[] {
  const violations: ClaimViolation[] = [];

  // 编号连续
  claims.forEach((c, i) => {
    if (c.number !== i + 1) {
      violations.push({
        rule: "numbering",
        severity: "error",
        claimNumber: c.number,
        message: `权利要求未按阿拉伯数字顺序编号（应为 ${i + 1} 号）`,
        suggestion: "请按 1, 2, 3, ... 的顺序重新编号权利要求",
      });
    }
  });

  for (const c of claims) {
    // 句号结尾
    if (!c.text.endsWith("。")) {
      violations.push({
        rule: "period",
        severity: "error",
        claimNumber: c.number,
        message: "权利要求未以句号结尾",
        suggestion: "在权利要求末尾添加'。'",
      });
    }
    // 模糊词
    const vagueHits = VAGUE_TERMS.filter(t => c.text.includes(t));
    if (vagueHits.length > 0) {
      violations.push({
        rule: "clarity",
        severity: "warning",
        claimNumber: c.number,
        message: `权利要求包含模糊限定词: ${vagueHits.join("、")}`,
        suggestion: "删除'约/大致/可能/优选/例如'等模糊表述",
      });
    }
    // 附图引用
    if (/如图[一二三四五六七八九十\d]+所示|如附图/.test(c.text)) {
      violations.push({
        rule: "no_illustration",
        severity: "error",
        claimNumber: c.number,
        message: "权利要求中不得包含'如图……所示'等引用附图的表述",
        suggestion: "删除'如图……所示'等表述，或将其替换为技术特征的直接描述",
      });
    }
    // 闭环引用检查（从属引用自身或前向）
    if (c.refersTo !== undefined && c.refersTo >= c.number && c.type === "dependent") {
      violations.push({
        rule: "circular_reference",
        severity: "error",
        claimNumber: c.number,
        message: `从属权利要求 ${c.number} 引用了 ${c.refersTo}，形成非法引用`,
        suggestion: "从属权利要求只能引用编号更小的权利要求",
      });
    }
  }

  return violations;
}
