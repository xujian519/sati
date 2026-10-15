/**
 * src/patent/fees/compute — 把一个案子对官费索引计价。
 *
 * 「该不该缴、缴几份」是结构问题，永远可答，所以报告一定会给出条目、份数与法条依据。
 * 「多少钱」不是：金额是抄录来的，所以每一行带一个支持程度（已核验 / 未核验 / 未转录），
 * 而**合计只在每一行都有已核验金额时才给出**——一份读起来像价格的局部和，正是这里要防的事。
 *
 * 三处与上游 dsh 不同（每一处都对应一个会让人算错的坑，详见 docs/notes）：
 *
 * 1. **减缴比例取决于申请人是一个还是多个，不是个人还是企业**（《专利收费减缴办法》第四条）。
 * 2. **`pending` 也必须挡住合计**：条目连份数都算不出来时，把它漏在合计之外、还报
 *    `complete: true`，等于给出一个少算了一笔的价格。
 * 3. **滞纳金超出官方参考表已列月份时不给金额**：细则第 115 条的补缴窗口是 6 个月，而官方
 *    年费计算参考表只列到 25%（5 个月）。这一个月决定「多缴」还是「缴费不足」，不猜。
 */

import { applyPercent, formatFen, parseYuan, reducedFen, sumFen } from "./money.js";
import { emptyTriggerNote, PATENT_TYPE_LABELS } from "./fees.js";
import type {
  AmountStatus,
  FeeBasis,
  FeeItem,
  FeeLine,
  FeeQuery,
  FeeReport,
  FeeTable,
  FeeTotal,
  FeeTrigger,
  PendingFee,
  ReductionKindRule,
  ReductionOutcome,
  ReductionRequest,
} from "./types.js";

/** 部署口径。 */
export type FeePolicy = {
  /**
   * 只要有适用条目没有已核验的应缴金额，就不给合计。
   *
   * 一份「部分合计」读起来就是案子的价格，而这正是它要防的事；已经把所依赖的金额全部
   * 转录并核验过的部署可以关掉它（此时给出的是仅含已核验项的局部和，并在报告里标明）。
   */
  failOnUnverified: boolean;
};

/** 随包口径：只要有适用金额未核验就不给合计。 */
export const DEFAULT_FEE_POLICY: FeePolicy = { failOnUnverified: true };

/** 一次计价的可选项。 */
export type ComputeOptions = {
  policy: FeePolicy;
};

/** 案件请求的减缴，已对索引解算。 */
type ReductionContext = {
  request: ReductionRequest;
  /** 索引登记的该类资格；未登记时为 undefined。 */
  kindRule: ReductionKindRule | undefined;
  /** 本次适用的减缴百分数。 */
  percent: number;
  /** 比例是怎么定下来的（写进报告）。 */
  basis: string;
  /**
   * 减缴覆盖的专利年度区间（自授予专利权当年起十年内）。
   *
   * 未给授权年度时为 null，表示无法判断——此时退化为条目的 `reductionMaxYears` 保守近似，
   * 该近似只会**少给**减缴，不会多给。
   */
  window: { from: number; to: number } | null;
};

/** 一行已计价，应缴金额以分留存供合计使用。 */
type ComputedLine = {
  line: FeeLine;
  payableFen: number | null;
};

/** 一个条目的份数，或者它还在等哪个输入。 */
type Counted = { quantity: number; quantityBasis: string } | { missing: PendingFee };

/**
 * 对一个案子计价。
 * @param table - 已装载的官费索引。
 * @param query - 案件事实。
 * @param options - 合计口径。
 * @returns 报告：已计价的行、还缺输入的条目、与合计。
 */
export function computeFees(table: FeeTable, query: FeeQuery, options: ComputeOptions): FeeReport {
  const notes: string[] = [];
  const reduction = resolveReduction(table, query.reduction, notes);
  const lines: ComputedLine[] = [];
  const pending: PendingFee[] = [];
  const excludedByType: string[] = [];
  const pricedTriggers = new Map<FeeTrigger, number>(query.triggers.map(trigger => [trigger, 0]));

  for (const item of table.items) {
    if (!query.triggers.includes(item.trigger)) continue;
    if (item.patentTypes !== null && !item.patentTypes.includes(query.patentType)) {
      excludedByType.push(describeItem(item));
      pricedTriggers.set(item.trigger, pricedTriggers.get(item.trigger) ?? 0);
      continue;
    }
    if (item.basis === "per-annuity-year") {
      const produced = annuityLines(item, query, reduction);
      lines.push(...produced);
      if (query.annuityYears === undefined || query.annuityYears.length === 0) {
        pending.push({
          id: item.id,
          name: item.name,
          requiredInput: "annuityYears",
          reason:
            "未给出要计算年费的专利年度：年度序号由 patent_deadlines 的年费条目给出（字段同名 patentYear），" +
            "本工具不自行推算。",
        });
      }
      pricedTriggers.set(item.trigger, (pricedTriggers.get(item.trigger) ?? 0) + produced.length);
      continue;
    }
    const counted = countUnits(item, item.basis, query);
    if ("missing" in counted) {
      pending.push(counted.missing);
      continue;
    }
    lines.push(pricedLine(item, item.id, item.name, counted.quantity, counted.quantityBasis, item.amount, reduction));
    pricedTriggers.set(item.trigger, (pricedTriggers.get(item.trigger) ?? 0) + 1);
  }

  if (excludedByType.length > 0) {
    notes.push(
      `已按专利类型过滤（本次为${PATENT_TYPE_LABELS[query.patentType]}）：${excludedByType.join("；")} 不适用本次类型，未列入本报告。`,
    );
  }
  for (const [trigger, produced] of pricedTriggers) {
    if (produced === 0) notes.push(emptyTriggerNote(trigger));
  }

  return {
    currency: table.currency,
    lines: lines.map(computed => computed.line),
    pending,
    reduction: reduction === null ? null : reductionOutcome(reduction, lines, pending, table),
    total: totalOf(lines, pending, options.policy),
    notes,
  };
}

/**
 * 数一个条目的份数，或报出它需要的案件输入。
 *
 * 年费类条目已由 {@link annuityLines} 计价，其基准不会走到这里。
 */
function countUnits(item: FeeItem, basis: Exclude<FeeBasis, "per-annuity-year">, query: FeeQuery): Counted {
  const freeUnits = item.freeUnits ?? 0;
  switch (basis) {
    case "per-case":
      return { quantity: 1, quantityBasis: "每件" };
    case "per-claim-beyond":
      if (query.claims === undefined) return { missing: missingInput(item, "claims", "未给出权利要求总项数。") };
      return {
        quantity: Math.max(0, query.claims - freeUnits),
        quantityBasis: `权利要求 ${String(query.claims)} 项 − 免费基数 ${String(freeUnits)} 项`,
      };
    case "per-page-beyond":
      if (query.specificationPages === undefined) {
        return { missing: missingInput(item, "specificationPages", "未给出说明书总页数。") };
      }
      return {
        quantity: Math.max(0, query.specificationPages - freeUnits),
        quantityBasis: `说明书 ${String(query.specificationPages)} 页 − 免费基数 ${String(freeUnits)} 页`,
      };
    case "per-priority":
      if (query.priorityClaims === undefined) {
        return { missing: missingInput(item, "priorityClaims", "未给出优先权要求项数。") };
      }
      return { quantity: query.priorityClaims, quantityBasis: `${String(query.priorityClaims)} 项优先权要求` };
    case "per-month":
      if (query.extensionMonths === undefined) {
        return { missing: missingInput(item, "extensionMonths", "未给出请求延长的月数。") };
      }
      return { quantity: query.extensionMonths, quantityBasis: `${String(query.extensionMonths)} 个月` };
  }
}

/** 一条指名缺哪个输入的 `pending`。 */
function missingInput(item: FeeItem, requiredInput: string, reason: string): PendingFee {
  return { id: item.id, name: item.name, requiredInput, reason };
}

/** 按已数好的份数给一个条目计价。 */
function pricedLine(
  item: FeeItem,
  id: string,
  name: string,
  quantity: number,
  quantityBasis: string,
  amount: string | null,
  reduction: ReductionContext | null,
  year?: number,
): ComputedLine {
  const notes: string[] = [];
  if (item.note !== undefined) notes.push(item.note);
  const unitFen = amountFen(amount);
  // 份数为 0 的行**一定**是 0 元，哪怕单价未转录：0 × 未知 = 0。否则一个「没超免费基数」的
  // 附加费会因为单价缺失被记成「金额未转录」，凭空挡住整份报告的合计。
  const owesNothing = quantity === 0;
  const subtotalFen = owesNothing ? 0 : unitFen === null ? null : unitFen * quantity;
  if (subtotalFen === null && item.unpriceableReason !== undefined) notes.push(item.unpriceableReason);
  const reduced = applyReduction({
    item,
    subtotalFen,
    notes,
    reduction,
    ...(year === undefined ? {} : { year }),
  });
  return {
    line: {
      id,
      name,
      basis: item.basis,
      quantity,
      quantityBasis,
      unitAmount: amount,
      subtotal: subtotalFen === null ? null : formatFen(subtotalFen),
      payable: reduced.payableFen === null ? null : formatFen(reduced.payableFen),
      status: owesNothing ? "verified" : statusOf(amount !== null, item.verifiedOn !== null),
      reduction: reduced.label,
      legalBasis: item.legalBasis,
      valueSource: valueSourceOf(item),
      notes,
    },
    payableFen: reduced.payableFen,
  };
}

/** 给年费条目计税的每一年（含滞纳金）。 */
function annuityLines(item: FeeItem, query: FeeQuery, reduction: ReductionContext | null): ComputedLine[] {
  const years = [...new Set(query.annuityYears ?? [])].sort((left, right) => left - right);
  return years.flatMap(year => [annuityLine(item, year, reduction), ...latePaymentLine(item, year, query.lateMonths)]);
}

/** 按覆盖该年度的档给一年的年费计价。 */
function annuityLine(item: FeeItem, year: number, reduction: ReductionContext | null): ComputedLine {
  const tier = item.tiers.find(entry => year >= entry.fromYear && year <= entry.toYear);
  const line = pricedLine(
    item,
    `${item.id}-${String(year)}`,
    `${item.name}（第 ${String(year)} 年度）`,
    1,
    `第 ${String(year)} 年度`,
    tier?.amount ?? (item.tiers.length === 0 ? item.amount : null),
    reduction,
    year,
  );
  if (item.tiers.length > 0 && tier === undefined) {
    line.line.notes.push(`第 ${String(year)} 年度未落在已转录的分档内（已转录 ${String(item.tiers.length)} 档）。`);
  }
  return line;
}

/**
 * 给一年的年费计滞纳金（调用方报了超期月数时）。
 *
 * 三种情形不给金额，且都会落进 `unverifiedIds` 挡住合计：金额本身未转录、超出补缴窗口、
 * 以及**超出官方参考表已列的月份**——后者是本地与上游都容易糊过去的一处，见模块头注 3。
 */
function latePaymentLine(item: FeeItem, year: number, lateMonths: number | undefined): ComputedLine[] {
  const rule = item.latePayment;
  if (rule === undefined || lateMonths === undefined || lateMonths <= 0) return [];
  const notes: string[] = [];
  const amount = amountFen(annualFeeAmount(item, year));
  const withinWindow = lateMonths <= rule.maxMonths;
  const withinTable = lateMonths <= rule.tabulatedMonths;
  if (!withinWindow) {
    notes.push(
      `超期 ${String(lateMonths)} 个月已超出专利法实施细则第115条的 ${String(rule.maxMonths)} 个月补缴窗口：` +
        `本项不再可缴，专利权自应当缴纳年费期满之日起终止。`,
    );
  } else if (!withinTable) {
    notes.push(
      `滞纳金按每超过 1 个月加收当年全额年费的 ${String(rule.monthlyPercent)}% 计算，` +
        `但官方年费计算参考表只列到 ${String(rule.tabulatedMonths)} 个月（${String(rule.tabulatedMonths * rule.monthlyPercent)}%），` +
        `第 ${String(lateMonths)} 个月的金额无官方表可依（按比例推算为 ${String(lateMonths * rule.monthlyPercent)}%）：` +
        `这一个月决定「多缴」还是「缴费不足、权利终止」，故本工具不给金额，请以缴费通知上的应缴数额为准。`,
    );
  }
  const monthly = amount === null ? null : applyPercent(amount, rule.monthlyPercent);
  const surchargeFen = monthly === null || !withinWindow || !withinTable ? null : monthly * lateMonths;
  return [
    {
      line: {
        id: `${item.id}-${String(year)}-late-payment`,
        name: `年费滞纳金（第 ${String(year)} 年度）`,
        basis: "per-month",
        quantity: lateMonths,
        quantityBasis: `超期 ${String(lateMonths)} 个月，每月加收当年全额年费的 ${String(rule.monthlyPercent)}%`,
        unitAmount: monthly === null ? null : formatFen(monthly),
        subtotal: surchargeFen === null ? null : formatFen(surchargeFen),
        payable: surchargeFen === null ? null : formatFen(surchargeFen),
        status:
          surchargeFen === null ? "unrecorded" : statusOf(true, item.verifiedOn !== null && rule.verifiedOn !== null),
        reduction: null,
        legalBasis: rule.legalBasis,
        valueSource: {
          sourceDoc: rule.sourceDoc ?? item.sourceDoc,
          sourceUrl: rule.sourceUrl ?? item.sourceUrl,
          publishedOn: rule.publishedOn ?? item.publishedOn,
          verifiedOn: rule.verifiedOn ?? item.verifiedOn,
          effectiveFrom: rule.effectiveFrom ?? item.effectiveFrom,
        },
        notes,
      },
      payableFen: surchargeFen,
    },
  ];
}

/** 一个年费条目对某一年收多少。 */
function annualFeeAmount(item: FeeItem, year: number): string | null {
  const tier = item.tiers.find(entry => year >= entry.fromYear && year <= entry.toYear);
  if (tier !== undefined) return tier.amount;
  return item.tiers.length === 0 ? item.amount : null;
}

/** 把请求的减缴作用到一行的应缴金额上。 */
function applyReduction(args: {
  item: FeeItem;
  subtotalFen: number | null;
  notes: string[];
  reduction: ReductionContext | null;
  year?: number;
}): { payableFen: number | null; label: string | null } {
  const { item, subtotalFen, notes, reduction, year } = args;
  if (reduction === null) return { payableFen: subtotalFen, label: null };
  if (item.reducible === false) {
    notes.push("本项不属于费用减缴范围：按全额计。");
    return { payableFen: subtotalFen, label: "未减缴（不适用）" };
  }
  if (item.reducible !== true) {
    notes.push("减缴适用范围未登记：本项按全额计。");
    return { payableFen: subtotalFen, label: "未减缴（适用范围未登记）" };
  }
  if (year !== undefined) {
    const outside = outsideReductionWindow(item, reduction, year);
    if (outside !== null) {
      notes.push(outside.message);
      return { payableFen: subtotalFen, label: outside.label };
    }
  }
  if (!reduction.request.filed) {
    notes.push(
      "未办理费减备案：不得按减缴计算，本项按全额计。" +
        "减缴请求须经国家知识产权局审核批准备案后，才能按批准后的应缴数额缴纳（《专利收费减缴办法》第八条、第十条）。",
    );
    return { payableFen: subtotalFen, label: "未减缴（未备案）" };
  }
  if (subtotalFen === null) return { payableFen: null, label: `减缴 ${String(reduction.percent)}%` };
  return {
    payableFen: reducedFen(subtotalFen, reduction.percent),
    label: `减缴 ${String(reduction.percent)}%`,
  };
}

/**
 * 该年度是否落在减缴覆盖的年度区间之外。
 *
 * 有授权年度时按「自授予专利权当年起十年内」精确判断；没有时退化为条目的
 * `reductionMaxYears`（只会少给减缴，不会多给）。
 * @returns 落在外时给出说明与标签；落在内时为 null。
 */
function outsideReductionWindow(
  item: FeeItem,
  reduction: ReductionContext,
  year: number,
): { message: string; label: string } | null {
  if (reduction.window !== null) {
    const { from, to } = reduction.window;
    if (year < from || year > to) {
      return {
        message:
          `第 ${String(year)} 年度不在减缴覆盖的年度区间内（自授予专利权当年即第 ${String(from)} 年度起 ` +
          `${String(to - from + 1)} 年，至第 ${String(to)} 年度为止）：本年度按全额计。`,
        label: `未减缴（仅第 ${String(from)}–${String(to)} 年度适用）`,
      };
    }
    return null;
  }
  if (item.reductionMaxYears !== undefined && year > item.reductionMaxYears) {
    return {
      message:
        `减缴只覆盖第 ${String(item.reductionMaxYears)} 年度及以前：本年度按全额计。` +
        `（本次未给授权年度，按专利年度上限作保守近似；授权较晚的案件实际可减缴的年度会超过该上限——` +
        `补上 reduction.grantPatentYear 即可按「自授予专利权当年起十年内」精确判断。）`,
      label: `未减缴（仅前 ${String(item.reductionMaxYears)} 年适用）`,
    };
  }
  return null;
}

/** 把请求的减缴对索引解算，并记下解算过程中的说明。 */
function resolveReduction(
  table: FeeTable,
  request: ReductionRequest | undefined,
  notes: string[],
): ReductionContext | null {
  if (request === undefined) return null;
  const kindRule = table.reductionKinds.find(entry => entry.kind === request.kind);
  if (kindRule === undefined) {
    notes.push(`官费索引没有登记「${request.kind}」这一类减缴资格：本次不按减缴计算。`);
  }
  if (!request.filed) {
    notes.push("本次减缴请求未办理费减备案。");
  }
  const joint = request.applicants >= 2;
  const percent = joint ? table.reductionPercent.joint : table.reductionPercent.single;
  const basis = joint
    ? `共同申请（申请人/专利权人 ${String(request.applicants)} 名）→ 减缴 ${String(percent)}%`
    : `单独申请（申请人/专利权人 1 名）→ 减缴 ${String(percent)}%`;
  let window: { from: number; to: number } | null = null;
  const grantYear = request.grantPatentYear;
  if (grantYear !== undefined) {
    window = { from: grantYear, to: grantYear + 9 };
  } else {
    notes.push(
      "本次未给 reduction.grantPatentYear（授权当年所处的专利年度），无法精确判断年费减缴的年度区间：" +
        "减缴覆盖「自授予专利权当年起十年内」，起点随授权年度移动。已退化为按第 10 年度及以前作保守近似" +
        "（只会少给减缴，不会多给）；补上该字段即可精确判断。",
    );
  }
  if (table.reductionTiming !== null) notes.push(table.reductionTiming);
  return { request, kindRule, percent, basis, window };
}

/** 概括减缴请求的处理结果。 */
function reductionOutcome(
  reduction: ReductionContext,
  lines: ComputedLine[],
  pending: PendingFee[],
  table: FeeTable,
): ReductionOutcome {
  const applied = lines.some(line => line.line.reduction?.startsWith("减缴 ") === true);
  return {
    kind: reduction.request.kind,
    applicants: reduction.request.applicants,
    filed: reduction.request.filed,
    reductionPercent: reduction.percent,
    reductionBasis: reduction.basis,
    applied,
    reason: reductionReason(reduction, applied, table, pending),
  };
}

/** 说明减缴为什么施行或没施行。 */
function reductionReason(
  reduction: ReductionContext,
  applied: boolean,
  table: FeeTable,
  pending: PendingFee[],
): string {
  if (reduction.kindRule === undefined)
    return `官费索引没有登记「${reduction.request.kind}」这一类减缴资格：本次不按减缴计算。`;
  if (!reduction.request.filed) {
    return "未办理费减备案：仅对不以此为前提的费种适用，其余按全额计。备案批准确后方可按批准后的应缴数额缴纳。";
  }
  if (!applied) {
    const blocked =
      pending.length > 0 ? "本案还有待补输入的费用项，减缴尚未作用到任何一行。" : "本案没有落在减缴范围内的费用项。";
    return `${reduction.basis}；${blocked}`;
  }
  const capped =
    reduction.window === null
      ? "（未给授权年度，年费减缴年度区间按第 10 年度及以前作保守近似）"
      : `（减缴覆盖第 ${String(reduction.window.from)}–${String(reduction.window.to)} 年度）`;
  return `${reduction.basis}；已按该比例计算适用费种${capped}。资格：${reduction.kindRule.eligibility}`;
}

/**
 * 合计已核验的应缴金额；有一条给不出就不给。
 *
 * `pending` 与「未核验」同等对待：连份数都算不出来的适用条目若被漏在合计之外，那个合计就是
 * 一个少算了一笔的价格。二者一并进入 `unverifiedIds`，`complete` 只在它为空时为真。
 */
function totalOf(lines: ComputedLine[], pending: PendingFee[], policy: FeePolicy): FeeTotal {
  if (lines.length === 0 && pending.length === 0) {
    // 覆盖为空 ≠ 已算全：一份没有任何适用条目的报告若给出「0.00 元」，读起来就是「本案不收费」。
    return { amount: null, complete: false, unverifiedIds: [] };
  }
  const incomplete = lines.filter(line => line.line.status !== "verified" || line.payableFen === null);
  const verified = lines.filter(
    (line): line is ComputedLine & { payableFen: number } =>
      line.line.status === "verified" && line.payableFen !== null,
  );
  const verifiedFen = sumFen(verified.map(line => line.payableFen));
  const unverifiedIds = [...incomplete.map(line => line.line.id), ...pending.map(item => item.id)];
  const complete = unverifiedIds.length === 0;
  const amount = complete
    ? formatFen(verifiedFen)
    : policy.failOnUnverified || verified.length === 0
      ? null
      : formatFen(verifiedFen);
  return { amount, complete, unverifiedIds };
}

/** 金额的支持程度：已登记且已核验 / 已登记未核验 / 未登记。 */
function statusOf(amountRecorded: boolean, verified: boolean): AmountStatus {
  if (!amountRecorded) return "unrecorded";
  return verified ? "verified" : "unverified";
}

/** 把条目的抄录出处抄进行。 */
function valueSourceOf(item: FeeItem): FeeLine["valueSource"] {
  return {
    sourceDoc: item.sourceDoc,
    sourceUrl: item.sourceUrl,
    publishedOn: item.publishedOn,
    verifiedOn: item.verifiedOn,
    effectiveFrom: item.effectiveFrom,
  };
}

/** 把一个条目写成类型过滤说明里可区分的一项（同名条目靠 id 与应用类型区分）。 */
function describeItem(item: FeeItem): string {
  const types =
    item.patentTypes === null ? "全部类型" : item.patentTypes.map(type => PATENT_TYPE_LABELS[type]).join("/");
  return `${item.name}（${item.id}，适用 ${types}）`;
}

/** 把可空的元金额解析成。 */
function amountFen(amount: string | null): number | null {
  return amount === null ? null : parseYuan(amount);
}
