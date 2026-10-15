/**
 * src/patent/fees/types — 官费索引的类型契约。
 *
 * 贯穿全部类型的一条切分是**适用范围 vs 金额**：一个案子该缴哪些费种、每个费种计几份，
 * 由条目的结构决定，永远可答；而每一个金额都是从某份官方文书**抄录**来的内容，各自带着
 * 出处与核验日期。金额没抄录时它是**未知**，不是零——这条切分是 `AmountStatus` 与
 * `FeeTotal.unverifiedIds` 存在的原因。
 */

/** 费种适用的专利类型。 */
export type PatentType = "invention" | "utility-model" | "design";

/**
 * 费种产生的环节。
 *
 * 这是**报告的覆盖面**，不是提示：调用方没点到的环节一律不计价，所以漏一个环节在报告里
 * 读起来就是「该环节不收费」。工具描述必须把这一点说给模型听。
 */
export type FeeTrigger =
  /** 提出申请：申请费、公布印刷费、申请附加费、优先权要求费。 */
  | "filing"
  /** 请求实质审查。 */
  | "substantive-examination"
  /** 办理登记手续（现行无独立费种，见 `EMPTY_TRIGGER_NOTES`）。 */
  | "grant-registration"
  /** 授权当年以后的年费。 */
  | "annual-fee"
  /** 请求复审。 */
  | "reexamination"
  /** 请求宣告无效。 */
  | "invalidation"
  /** 请求作出专利权评价报告。 */
  | "evaluation-report"
  /** 请求专利权期限补偿（请求费与补偿期年费）。 */
  | "term-compensation"
  /** 请求出具专利文件副本。 */
  | "document-copy"
  /** 请求恢复权利。 */
  | "restoration"
  /** 请求延长期限。 */
  | "extension"
  /** 办理著录事项变更。 */
  | "record-change"
  /** PCT 进入中国国家阶段的宽限费。 */
  | "pct-grace"
  /** PCT 进入中国国家阶段的其他费用（译文改正、单一性恢复、优先权恢复）。 */
  | "pct-national-phase";

/**
 * 一个费种的计数基准。
 *
 * `per-case` 与 `per-annuity-year` 由案子的形态决定；其余按条目的 `freeUnits` 扣减免费基数，
 * 或对调用方给出的案件事实计数。
 */
export type FeeBasis =
  /** 每件一份。 */
  | "per-case"
  /** 超过 `freeUnits` 项的权利要求，每项一份。 */
  | "per-claim-beyond"
  /** 超过 `freeUnits` 页的说明书，每页一份。 */
  | "per-page-beyond"
  /** 每项优先权要求一份。 */
  | "per-priority"
  /** 每个专利年度一份。 */
  | "per-annuity-year"
  /** 每请求一个月一份。 */
  | "per-month";

/**
 * 费减**资格**（《专利收费减缴办法》第三条的三类主体）。
 *
 * ⚠️ 资格与比例是两个维度，不要合并：比例取决于**申请人是一个还是多个**
 * （办法第四条），与主体是个人还是单位无关。上游 dsh 把两者合成
 * `individual → 85% / enterprise → 70%`，会让**企业单独申请少减 15 个百分点**、
 * **两个个人共同申请多减 15 个百分点**——后者是缴费不足、要丢权利的方向。
 */
export type ReductionKind = "individual" | "enterprise" | "institution";

/**
 * 一个金额的抄录出处。
 *
 * 每个字段在没人登记之前都是 null：**没有核验日期的金额是未核验，不是默认已核验**。
 */
export type FeeValueSource = {
  /** 抄录所据的文书。 */
  sourceDoc: string | null;
  /** 该文书的可打开地址，便于复核。 */
  sourceUrl: string | null;
  /** 该文书自身的发布日。 */
  publishedOn: string | null;
  /** 逐条核对通过的日期。 */
  verifiedOn: string | null;
  /** 该标准开始施行的日期。 */
  effectiveFrom: string | null;
};

/** 年费的一档：覆盖的专利年度与每年金额。 */
export type AnnuityTier = {
  /** 该档覆盖的首个专利年度。 */
  fromYear: number;
  /** 该档覆盖的末个专利年度。 */
  toYear: number;
  /** 每年的金额（元，十进制字符串）。 */
  amount: string;
};

/** 年费缴费期满之后的滞纳金规则。 */
export type LatePaymentRule = {
  /** 每超过缴费时间一个月加收当年全额年费的百分数。 */
  monthlyPercent: number;
  /** 可补缴的月数上限（细则第 115 条：自应当缴纳年费期满之日起 6 个月内补缴）。 */
  maxMonths: number;
  /**
   * 官方年费计算参考表**已列出**的最高滞纳金月份数。
   *
   * 参考表只列到 5 个月（25%），而细则第 115 条的补缴窗口是 6 个月。两者差一个月，
   * 且差额方向决定「多缴」还是「缴费不足」——第 `tabulatedMonths` 个月之后不给金额，
   * 由 `compute.ts` 交人工核价，不猜。
   */
  tabulatedMonths: number;
  /** 规则的法条依据。 */
  legalBasis: string | null;
} & FeeValueSource;

/** 一个索引条目。 */
export type FeeItem = {
  /** 表内唯一 id。 */
  id: string;
  /** 官费名称。 */
  name: string;
  /** 产生的环节。 */
  trigger: FeeTrigger;
  /** 适用的专利类型；null 表示三种类型同价。 */
  patentTypes: PatentType[] | null;
  /** 计数基准。 */
  basis: FeeBasis;
  /** `beyond` 类基准扣减的免费基数；这些基准必填。 */
  freeUnits?: number;
  /** 单价（元）；未转录时为 null。 */
  amount: string | null;
  /** 是否属于费用减缴范围；未登记时为 null。 */
  reducible: boolean | null;
  /** 年费类条目减缴覆盖的最高专利年度（未给授权年度时的保守近似）。 */
  reductionMaxYears?: number;
  /** 年费分档；未转录时为空。 */
  tiers: AnnuityTier[];
  /** 年费的滞纳金规则。 */
  latePayment?: LatePaymentRule;
  /** 该费种的法条依据。 */
  legalBasis: string | null;
  /** 金额留空的原因；`amount` 为 null 时必填（不能只是「留空」）。 */
  unpriceableReason?: string;
  /** 该费种特有的口径提示，会随计价行一起带到报告里。 */
  note?: string;
} & FeeValueSource;

/** 一类减缴资格。 */
export type ReductionKindRule = {
  kind: ReductionKind;
  /** 该资格在中文里的写法。 */
  label: string;
  /** 认定条件，照政策原文写（含现行门槛）。 */
  eligibility: string;
};

/** 一份已装载的官费索引。 */
export type FeeTable = {
  /** 官费标准/指南的标题。 */
  document: string;
  /** 索引对准的版本。 */
  revision: string | null;
  /** 全部金额的币种。 */
  currency: string;
  /**
   * 减缴比例：`single` 为「专利申请人或者专利权人为个人或者单位」（单独），
   * `joint` 为「两个或者两个以上的个人或者单位」（共同）。
   */
  reductionPercent: { single: number; joint: number };
  /** 索引登记的减缴资格。 */
  reductionKinds: ReductionKindRule[];
  /**
   * 请求减缴的时限提示：请求减缴**申请费**应与申请同时提出，其他费用可在缴费期限届满日
   * 两个半月之前提出；未按规定时限提交的不予减缴（《专利收费减缴办法》第五条）。请求减缴时
   * 会随报告说明一起给出。
   */
  reductionTiming: string | null;
  /** 索引条目，按资产文件里的顺序。 */
  items: FeeItem[];
} & FeeValueSource;

/** 一个案子请求的费减。 */
export type ReductionRequest = {
  /** 依据哪一类资格请求减缴。 */
  kind: ReductionKind;
  /** 专利申请人/专利权人的人数；共同申请时大于 1，决定减缴比例。 */
  applicants: number;
  /** 是否已办理费减**备案**（《专利收费减缴办法》第八条的批准备案）。 */
  filed: boolean;
  /**
   * 授权当年所处的专利年度；决定减缴覆盖「自授予专利权当年起十年内」的哪一段。
   *
   * 取 `patent_deadlines` 的授权/办登条目给出的 `patentYear`（**字段同名**，见计划 §6.4）。
   * 缺省时退化为「第 1–10 年度」的保守近似（只会**少给**减缴，不会多给）。
   */
  grantPatentYear?: number;
};

/** 调用方知道的案件事实。 */
export type FeeQuery = {
  patentType: PatentType;
  /** 本案涉及的环节；只对点到的环节计价。 */
  triggers: FeeTrigger[];
  /** 权利要求总项数（申请附加费）。 */
  claims?: number;
  /** 说明书总页数（申请附加费）。 */
  specificationPages?: number;
  /** 优先权要求项数。 */
  priorityClaims?: number;
  /** 要计算年费的专利年度，从 1 起。 */
  annuityYears?: number[];
  /** 请求延长的月数。 */
  extensionMonths?: number;
  /** 年费已超期的月数。 */
  lateMonths?: number;
  /** 本案请求的费减。 */
  reduction?: ReductionRequest;
};

/** 一个金额的支持程度。 */
export type AmountStatus =
  /** 金额与核验日期都已登记。 */
  | "verified"
  /** 金额已登记，但没有核验日期。 */
  | "unverified"
  /** 金额未登记。 */
  | "unrecorded";

/** 一个已计价的费种。 */
export type FeeLine = {
  id: string;
  name: string;
  basis: FeeBasis;
  /** 计价份数；需要缺失输入才能计数的条目改报 `pending`。 */
  quantity: number;
  /** 份数是怎么算出来的（模型可读的话术）。 */
  quantityBasis: string;
  /** 单价（元）；无法给出时为 null。 */
  unitAmount: string | null;
  /** 单价 × 份数（元）；无法给出时为 null。 */
  subtotal: string | null;
  /** 减缴之后应缴（元）；无法给出时为 null。 */
  payable: string | null;
  /** `unitAmount`/`payable` 的支持程度。 */
  status: AmountStatus;
  /** 本行施行的减缴（模型可读），未施行时为 null。 */
  reduction: string | null;
  /** 该费种的法条依据。 */
  legalBasis: string | null;
  /** 金额出处，照抄自条目。 */
  valueSource: FeeValueSource;
  /** 调用方必须知道的、与本行有关的事。 */
  notes: string[];
};

/** 因为缺案件输入而无法计价的费种。 */
export type PendingFee = {
  id: string;
  name: string;
  /** 需要调用方补的输入名。 */
  requiredInput: string;
  reason: string;
};

/** 费减请求的解算结果。 */
export type ReductionOutcome = {
  kind: ReductionKind;
  /** 申请人/专利权人人数。 */
  applicants: number;
  filed: boolean;
  /** 本次适用的减缴百分数。 */
  reductionPercent: number;
  /** 比例是怎么定下来的。 */
  reductionBasis: string;
  /** 该比例是否真的作用到了某一行。 */
  applied: boolean;
  /** 结论性说明。 */
  reason: string;
};

/** 报告的合计。 */
export type FeeTotal = {
  /** 合计（元）；不得给出时为 null。 */
  amount: string | null;
  /**
   * 每一行适用费用是否都带有已核验的应缴金额。
   *
   * ⚠️ 覆盖为空（一行适用条目都没有）时也为 false：那一份报告不是「已算全」，是「什么都没算」——
   * 给它一个 0.00 元的合计，读起来就是「本案不收费」。
   */
  complete: boolean;
  /** 使合计不完整的行 id。 */
  unverifiedIds: string[];
};

/** 一个已计价的案子。 */
export type FeeReport = {
  /** 报告中全部金额的币种。 */
  currency: string;
  lines: FeeLine[];
  /** 需要调用方补输入才能计价的条目。 */
  pending: PendingFee[];
  reduction: ReductionOutcome | null;
  total: FeeTotal;
  /** 对整份报告成立的说明。 */
  notes: string[];
};
