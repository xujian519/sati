/**
 * patent_fees — 中国专利官费计价（A4）。
 *
 * 为什么需要它：官费是**会被改**的文书（减缴门槛、减缴比例、费种都改过），而「该缴多少钱」
 * 又是一个必须给准的数——少算一笔就是缴费不足、权利终止。模型凭记忆报官费，报出来的是训练
 * 数据里某个年份的价目表，且看不出来是哪一年的。所以把这件事变成**对着带出处与核验日期的
 * 索引做算术**。
 *
 * ## 三条边界（工具描述里对模型明说，避免把降级当结论）
 *
 * 1. **金额只从已转录的索引里来**：每一行带 `status`（已核验 / 未核验 / 金额未转录），只要有
 *    一项不是已核验，就不给合计并指名是哪几项。索引没有的金额是**未知**，不是零，也不许自己补。
 * 2. **`triggers` 是覆盖面，不是提示**：没点到的环节一律不计价。索引里没有条目的环节会给出
 *    为何没有（如办登的登记费、公告印刷费已停征，办登要缴的是授权当年年费）。
 * 3. **减缴比例取决于申请人是一个还是多个**：单独申请减缴 85%，两个以上共同申请减缴 70%
 *    （《专利收费减缴办法》第四条），与主体是个人还是企业无关；且减缴以**已办理费减备案**为前提，
 *    未备案时按全额并写明理由。
 */

import {
  clearFeeTableCache,
  computeFees,
  DEFAULT_FEE_POLICY,
  FeeTableError,
  FEE_BASES,
  FEE_TRIGGERS,
  loadFeeTable,
  renderFeeReport,
  type AmountStatus,
  type FeeQuery,
  type FeeReport,
  type PatentType,
  type ReductionKind,
} from "../../patent/fees/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/** 资产缺失时的降级码说明（构建/部署问题，不是用户配置问题）。 */
const FEE_ASSET_HINT =
  "官费索引资产缺失或畸形（应为 assets/patent/fees/cn-fees.yaml；" +
  "构建产物在 dist/assets/patent/fees/，由 scripts/copy-build-assets.mjs 拷贝）。" +
  "计价依赖该资产：缺失时**不能**以空表继续，那会把每个案子都报成已计价。";

/** 工具输入非法时抛出。 */
export class PatentFeesInputError extends Error {
  /** 稳定的错误码，供模型与日志使用。 */
  readonly code: string;

  /**
   * @param code - 稳定的错误码。
   * @param message - 输入哪里不对。
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "PatentFeesInputError";
    this.code = code;
  }
}

/** 工具输入：就是官费查询带的案件事实。 */
export type PatentFeesInput = {
  /** 专利类型。 */
  patentType: PatentType;
  /** 本案涉及的环节。 */
  triggers: string[];
  /** 权利要求总项数（申请附加费）。 */
  claims?: number;
  /** 说明书总页数（申请附加费）。 */
  specificationPages?: number;
  /** 优先权要求项数。 */
  priorityClaims?: number;
  /** 要计算年费的专利年度，从 1 起；取自 patent_deadlines 的 patentYear。 */
  annuityYears?: number[];
  /** 请求延长的月数。 */
  extensionMonths?: number;
  /** 年费已超期的月数。 */
  lateMonths?: number;
  /** 本案请求的费减。 */
  reduction?: {
    kind: ReductionKind;
    applicants: number;
    filed: boolean;
    grantPatentYear?: number;
  };
};

/** 报告里的一行费用。 */
export type PatentFeesLineValue = {
  id: string;
  name: string;
  basis: string;
  quantity: number;
  quantityBasis: string;
  unitAmount?: string;
  subtotal?: string;
  payable?: string;
  status: AmountStatus;
  reduction?: string;
  legalBasis?: string;
  sourceDoc?: string;
  sourceUrl?: string;
  publishedOn?: string;
  verifiedOn?: string;
  notes: string[];
};

/** 一条还需要补输入的费用项。 */
export type PatentFeesPendingValue = {
  id: string;
  name: string;
  requiredInput: string;
  reason: string;
};

/** 工具输出。 */
export type PatentFeesOutput = {
  patentType: PatentType;
  currency: string;
  triggers: string[];
  lines: PatentFeesLineValue[];
  pending: PatentFeesPendingValue[];
  total: { amount?: string; complete: boolean; unverifiedIds: string[] };
  reduction?: {
    kind: ReductionKind;
    applicants: number;
    filed: boolean;
    reductionPercent: number;
    reductionBasis: string;
    applied: boolean;
    reason: string;
  };
  notes: string[];
  /** 渲染好的缴费清单（Markdown）。 */
  report: string;
};

const DESCRIPTION =
  "Compute CNIPA official fees: fee items, quantities, reduction, annuity tiers, and late surcharges, with " +
  "per-line unit/subtotal/payable/status, total, legal basis, and a fee schedule. Money comes only from the " +
  "rate index; unverified/unrecorded/pending items block the total (unverifiedIds). Reduction is 85% for a " +
  "sole applicant and 70% for two or more, and requires a filed record. annuityYears and grantPatentYear " +
  "come from patent_deadlines. Read-only.";

/**
 * 创建 `patent_fees` 工具。
 * @returns 工具定义。
 */
export function createPatentFeesTool(): SatiToolDefinition<PatentFeesInput, PatentFeesOutput> {
  return {
    name: "patent_fees",
    title: "Patent Fees",
    description: DESCRIPTION,
    kind: "custom",
    domain: "patent",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        patentType: {
          type: "string",
          enum: ["invention", "utility-model", "design"],
          description: "invention / utility-model / design.",
        },
        triggers: {
          type: "array",
          description: "Fee triggers; unlisted steps are not priced.",
          items: { type: "string", enum: [...FEE_TRIGGERS] },
        },
        claims: { type: "number", description: "Total claims (excess-claim fee from item 11)." },
        specificationPages: { type: "number", description: "Specification pages (tiered index)." },
        priorityClaims: { type: "number", description: "Priority claims (80 CNY each)." },
        annuityYears: {
          type: "array",
          description: "Annuity patent years (e.g. [1,4,13]).",
          items: { type: "number" },
        },
        extensionMonths: { type: "number", description: "Extension months." },
        lateMonths: {
          type: "number",
          description: "Late annuity months (0 = on time).",
        },
        reduction: {
          type: "object",
          description: "Fee reduction.",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              enum: ["individual", "enterprise", "institution"],
              description: "individual / enterprise / institution.",
            },
            applicants: {
              type: "number",
              description: "Applicant count (1 = 85%, >=2 = 70%).",
            },
            filed: {
              type: "boolean",
              description: "Reduction record filed.",
            },
            grantPatentYear: {
              type: "number",
              description: "Patent year of grant (from patent_deadlines).",
            },
          },
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        patentType: { type: "string" },
        currency: { type: "string" },
        triggers: { type: "array", items: { type: "string" } },
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              basis: { type: "string", enum: [...FEE_BASES] },
              quantity: { type: "number" },
              quantityBasis: { type: "string" },
              unitAmount: { type: "string" },
              subtotal: { type: "string" },
              payable: { type: "string" },
              status: { type: "string", enum: ["verified", "unverified", "unrecorded"] },
              reduction: { type: "string" },
              legalBasis: { type: "string" },
              sourceDoc: { type: "string" },
              sourceUrl: { type: "string" },
              publishedOn: { type: "string" },
              verifiedOn: { type: "string" },
              notes: { type: "array", items: { type: "string" } },
            },
          },
        },
        pending: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              requiredInput: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        total: {
          type: "object",
          additionalProperties: false,
          properties: {
            amount: { type: "string" },
            complete: { type: "boolean" },
            unverifiedIds: { type: "array", items: { type: "string" } },
          },
        },
        reduction: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["individual", "enterprise", "institution"] },
            applicants: { type: "number" },
            filed: { type: "boolean" },
            reductionPercent: { type: "number" },
            reductionBasis: { type: "string" },
            applied: { type: "boolean" },
            reason: { type: "string" },
          },
        },
        notes: { type: "array", items: { type: "string" } },
        report: { type: "string" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      try {
        loadFeeTable();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: "setup_required",
          reason: `${FEE_ASSET_HINT}（${error instanceof Error ? error.message : String(error)}）`,
        };
      }
    },
    execute: async input => {
      let table;
      try {
        table = loadFeeTable();
      } catch (error) {
        return {
          content: [{ type: "text", text: `错误：${FEE_ASSET_HINT}` }],
          metadata: {
            error: "fee_table_unavailable",
            detail: error instanceof FeeTableError ? error.message : String(error),
          },
        };
      }

      let query: FeeQuery;
      try {
        query = toQuery(input);
      } catch (error) {
        if (error instanceof PatentFeesInputError) {
          return {
            content: [{ type: "text", text: `错误：${error.message}` }],
            metadata: { error: error.code },
          };
        }
        throw error;
      }

      let report: FeeReport;
      try {
        report = computeFees(table, query, { policy: DEFAULT_FEE_POLICY });
      } catch (error) {
        if (error instanceof FeeTableError) {
          return {
            content: [{ type: "text", text: `错误：${error.message}` }],
            metadata: { error: "invalid_fee_table" },
          };
        }
        throw error;
      }

      const output: PatentFeesOutput = {
        patentType: query.patentType,
        currency: report.currency,
        triggers: [...query.triggers],
        lines: report.lines.map(line => ({
          id: line.id,
          name: line.name,
          basis: line.basis,
          quantity: line.quantity,
          quantityBasis: line.quantityBasis,
          ...(line.unitAmount === null ? {} : { unitAmount: line.unitAmount }),
          ...(line.subtotal === null ? {} : { subtotal: line.subtotal }),
          ...(line.payable === null ? {} : { payable: line.payable }),
          status: line.status,
          ...(line.reduction === null ? {} : { reduction: line.reduction }),
          ...(line.legalBasis === null ? {} : { legalBasis: line.legalBasis }),
          ...(line.valueSource.sourceDoc === null ? {} : { sourceDoc: line.valueSource.sourceDoc }),
          ...(line.valueSource.sourceUrl === null ? {} : { sourceUrl: line.valueSource.sourceUrl }),
          ...(line.valueSource.publishedOn === null ? {} : { publishedOn: line.valueSource.publishedOn }),
          ...(line.valueSource.verifiedOn === null ? {} : { verifiedOn: line.valueSource.verifiedOn }),
          notes: line.notes,
        })),
        pending: report.pending.map(item => ({ ...item })),
        total: {
          ...(report.total.amount === null ? {} : { amount: report.total.amount }),
          complete: report.total.complete,
          unverifiedIds: report.total.unverifiedIds,
        },
        ...(report.reduction === null ? {} : { reduction: { ...report.reduction } }),
        notes: report.notes,
        report: renderFeeReport(report, {
          patentType: query.patentType,
          triggers: query.triggers,
          sourceDoc: table.sourceDoc,
          revision: table.revision,
          verifiedOn: table.verifiedOn,
        }),
      };
      return {
        content: [{ type: "text", text: output.report }],
        data: output,
        metadata: {
          domain: "patent",
          lines: report.lines.length,
          pending: report.pending.length,
          totalComplete: report.total.complete,
        },
      };
    },
  };
}

/** 清空索引装载缓存（测试用）。 */
export function resetPatentFeesCache(): void {
  clearFeeTableCache();
}

/** 把工具输入变成官费查询，顺带拒掉不能计价的部分。 */
function toQuery(args: PatentFeesInput): FeeQuery {
  const triggers = args.triggers ?? [];
  if (triggers.length === 0) {
    throw new PatentFeesInputError(
      "no_triggers",
      'triggers 不能为空：未指定环节时本工具不会报告任何费用，而那不是「本案无费用」。请列出本案涉及的环节，如 ["filing"]。',
    );
  }
  const unknown = triggers.filter(trigger => !(FEE_TRIGGERS as readonly string[]).includes(trigger));
  if (unknown.length > 0) {
    throw new PatentFeesInputError(
      "unknown_trigger",
      `triggers 含未知环节：${unknown.join("、")}。可用取值：${FEE_TRIGGERS.join(" / ")}`,
    );
  }
  const reduction = args.reduction;
  if (reduction !== undefined) {
    const applicants = count(reduction.applicants, "reduction.applicants");
    if (applicants < 1) {
      throw new PatentFeesInputError(
        "invalid_applicants",
        "reduction.applicants 至少为 1（1 为单独申请，2 及以上为共同申请）。",
      );
    }
    if (reduction.grantPatentYear !== undefined) {
      const year = count(reduction.grantPatentYear, "reduction.grantPatentYear");
      if (year < 1) {
        throw new PatentFeesInputError("invalid_grant_year", "reduction.grantPatentYear 必须是正整数专利年度。");
      }
    }
  }
  return {
    patentType: args.patentType,
    triggers: [...triggers] as FeeQuery["triggers"],
    ...(args.claims === undefined ? {} : { claims: count(args.claims, "claims") }),
    ...(args.specificationPages === undefined
      ? {}
      : { specificationPages: count(args.specificationPages, "specificationPages") }),
    ...(args.priorityClaims === undefined ? {} : { priorityClaims: count(args.priorityClaims, "priorityClaims") }),
    ...(args.extensionMonths === undefined ? {} : { extensionMonths: count(args.extensionMonths, "extensionMonths") }),
    ...(args.lateMonths === undefined ? {} : { lateMonths: count(args.lateMonths, "lateMonths") }),
    ...(args.annuityYears === undefined ? {} : { annuityYears: annuityYears(args.annuityYears) }),
    ...(reduction === undefined ? {} : { reduction: { ...reduction } }),
  };
}

/** 校验一个计数参数（非负整数）。 */
function count(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new PatentFeesInputError("invalid_count", `${label} 必须是非负整数，得到：${String(value)}`);
  }
  return value;
}

/** 校验年费年度清单。 */
function annuityYears(years: readonly number[]): number[] {
  for (const year of years) {
    if (!Number.isInteger(year) || year < 1) {
      throw new PatentFeesInputError(
        "invalid_annuity_year",
        `annuityYears 只能是正整数专利年度，得到：${String(year)}`,
      );
    }
  }
  return [...years];
}
