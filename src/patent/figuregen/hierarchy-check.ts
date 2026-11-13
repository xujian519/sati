/**
 * src/patent/figuregen — 构造层级 ↔ 权利要求归属表述的一致性核对（RC8，纯函数）。
 *
 * 用途：出图时**声明**的图内构造层级（父标记 → 直接子标记），与权利要求/说明书正文里
 * **写出**的归属表述（「<父标记>…的…<子标记>」）必须一致。附图上部件挂在哪个上位部件
 * 之下只能靠几何包含关系去猜（标号是外置的，引线引到轮廓外），猜错反而误导；可确定的
 * 判据只有这一条：两边都写明了归属却对不上 ⇒ 图文矛盾。本模块只做这一件事。
 *
 * 依据：专利法第二十六条第四款「权利要求书应当以说明书为依据，清楚、简要地限定要求保护
 * 的范围」——权利要求写出的构造归属须与说明书（含附图）对应得上；附图标记与说明书的
 * 对应义务见细则第 21 条。⚠️ 本模块只做**一致性核对**，不对第二十六条第四款作独立的法律
 * 判定（是否因此得不到说明书支持需人工复核），故发现级别固定 warn，不判 fail。
 *
 * 与 deepseek-harness 参考实现
 * （`packages/patent/patent-tools/src/figure/hierarchy-check.ts`）的差异，逐条列明：
 * 1. 标记用 `number` 而非 `string`：本仓的附图标记管线（`numeral.ts`）以数值承载标记，
 *    实务上限三位（`REF_NUMERAL_PRACTICAL_MAX = 999`）；
 * 2. 入参是单个对象（`edges` + `claimText`），不是两个位置参数；
 * 3. 发现面是本仓的 `{ rule, severity, message, evidence }`（规则号固定 RC8，证据单列），
 *    不是参考实现的 `{ check, message }`。本仓发现面没有独立的 warnings 通道，故**成环
 *    说明也挂在 RC8 上**，靠消息措辞与 `evidence` 区分「成环说明」与「归属矛盾」；
 * 4. 标记形态收紧为**纯数字 1..999 的规范写法**（无前导零）：`S101`（字母前缀步骤号）、
 *    `20A`（大写字母后缀的部分视图号）、`20a` 一律不作标记——与本仓 V14 的口径一致
 *    （大写字母后缀与字母前缀步骤号都不判）；
 * 5. 序号上下文（`权利要求N` / `权项N` / `图N`）显式排除：参考实现靠「两端必须是已声明
 *    节点」隐式排除它们，这里前置排除，避免权利要求序号与附图标记同形时误判；
 * 6. 只核「两边都说了、但对不上」：声明里根本没出现过的标记不作判据（那是建模问题，
 *    不是矛盾），与参考实现同口径。
 *
 * 本批边界：本模块是**纯函数**，尚未接入任何工具面。接入需给工具的 `inputSchema` 增加
 * `hierarchy` / `claimText` 入参 ⇒ 改 schema 会使 llm-replay fixture 失配，须在**重录
 * 窗口**内一并接线（AGENTS 第 6 条）；本批只落函数与测试，barrel 导出由主代理统一加。
 */

/** 声明的图内层级：父标记 → 直接子标记。 */
export type FigureHierarchyEdge = {
  /** 父标记（附图标记数值，如 31）。 */
  readonly parent: number;
  /** 直接子标记（如 311）。 */
  readonly child: number;
};

/** 一条层级不一致发现。规则号固定 RC8（已在 `check.ts` 的 `FigureCheckRuleId` 里登记）。 */
export type HierarchyCheckFinding = {
  /** 规则号（RC8）。 */
  readonly rule: "RC8";
  /** 级别：一致性核对只提示，不阻断。 */
  readonly severity: "warn";
  /** 模型可见的一句话结论。 */
  readonly message: string;
  /** 证据（两侧的比对依据）。 */
  readonly evidence?: readonly string[];
};

/** 层级核对的输入。 */
export type HierarchyCheckInput = {
  /** 声明的图内层级边（父 → 直接子）。 */
  readonly edges: readonly FigureHierarchyEdge[];
  /** 权利要求（或说明书）文本：从中提取「<父标记>…的…<子标记>」式归属表述。 */
  readonly claimText: string;
};

/** 附图标记取值上界（与 `numeral.ts` 的 `REF_NUMERAL_PRACTICAL_MAX` 同源）。 */
const MARKER_MAX = 999;

/**
 * 归属表述：父标记 … 的 … 子标记。
 *
 * - 两端必须是**纯数字**标记形态（1..999，无前导零）：`S101`（字母前缀步骤号）与
 *   `20A`（大写字母后缀的部分视图号）不作标记——与本仓 V14 的口径一致；
 * - 序号上下文（`权利要求N` / `权项N` / `图N`）显式排除，它们不是附图标记；
 * - 中间文字每侧至多 8 个字符，且不含数字与句读（跨过句读的两个数字不是归属表述，
 *   跨过数字的更不是）。
 */
const ATTRIBUTION_PATTERN =
  /(?<![0-9A-Za-z])(?<![权项])(?<!权利要求)(?<!图)(\d{1,3})(?![0-9A-Za-z])[^0-9，。；：、（）()]{0,8}?的[^0-9，。；：、（）()]{0,8}?(?<![0-9A-Za-z])(\d{1,3})(?![0-9A-Za-z])/gu;

/** 声明层级的索引。 */
type HierarchyIndex = {
  /** 声明里出现过的全部标记（边的两端）。 */
  readonly nodes: ReadonlySet<number>;
  /** 标记 → 直接父标记。 */
  readonly parentOf: ReadonlyMap<number, number>;
  /** 标记 → 全部祖先标记（含直接父标记）。 */
  readonly ancestorsOf: ReadonlyMap<number, ReadonlySet<number>>;
  /** 因成环被忽略的边。 */
  readonly cycleEdges: readonly FigureHierarchyEdge[];
};

/**
 * 该数值是否是附图标记形态：正整数且不超过三位（无小数、无前导零语义）。
 * @param value - 待判数值。
 * @returns 是附图标记形态时 true。
 */
function isMarker(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MARKER_MAX;
}

/**
 * 文本里的数字串是否是规范标记写法：取值合法且无前导零（`007` 不是标记形态）。
 * @param raw - 文本中捕获到的数字串。
 * @returns 合法时返回标记数值，否则 undefined。
 */
function toMarker(raw: string): number | undefined {
  const value = Number(raw);
  if (!isMarker(value)) return undefined;
  return String(value) === raw ? value : undefined;
}

/**
 * 建立层级索引。
 *
 * 成环（沿父边能回到自身）时**忽略该条边**并记一条成环说明：成环的层级无法判定归属，
 * 忽略一条边之后的部分仍可用，比整份声明作废更有用。
 * @param edges - 声明的构造层级。
 * @returns 层级索引。
 */
function indexHierarchy(edges: readonly FigureHierarchyEdge[]): HierarchyIndex {
  const nodes = new Set<number>();
  const validEdges: FigureHierarchyEdge[] = [];
  for (const edge of edges) {
    // 非标记形态的端点（0、负数、小数、超三位）不是附图标记，整条边不参与判定。
    if (!isMarker(edge.parent) || !isMarker(edge.child)) continue;
    validEdges.push(edge);
    nodes.add(edge.parent);
    nodes.add(edge.child);
  }
  const parentOf = new Map<number, number>();
  const cycleEdges: FigureHierarchyEdge[] = [];
  for (const edge of validEdges) {
    // 沿父链从 edge.parent 上溯：若能回到 edge.child，本条边会成环。
    const chain = new Set<number>([edge.child]);
    let cursor: number | undefined = edge.parent;
    while (cursor !== undefined && !chain.has(cursor)) {
      chain.add(cursor);
      cursor = parentOf.get(cursor);
    }
    if (cursor !== undefined) {
      cycleEdges.push(edge);
      continue;
    }
    parentOf.set(edge.child, edge.parent);
  }
  const ancestorsOf = new Map<number, ReadonlySet<number>>();
  for (const node of nodes) {
    const ancestors = new Set<number>();
    let cursor = parentOf.get(node);
    while (cursor !== undefined && !ancestors.has(cursor)) {
      ancestors.add(cursor);
      cursor = parentOf.get(cursor);
    }
    ancestorsOf.set(node, ancestors);
  }
  return { nodes, parentOf, ancestorsOf, cycleEdges };
}

/** 文本里抽取到的一条归属表述（父标记 → 子标记）。 */
type Attribution = {
  readonly parent: number;
  readonly child: number;
};

/**
 * 从权利要求/说明书正文抽取归属表述。
 * @param claimText - 权利要求或说明书正文。
 * @returns 抽取到的归属表述（按出现顺序，可重复）。
 */
function extractAttributions(claimText: string): Attribution[] {
  const attributions: Attribution[] = [];
  for (const match of claimText.matchAll(ATTRIBUTION_PATTERN)) {
    const parent = toMarker(match[1] ?? "");
    const child = toMarker(match[2] ?? "");
    if (parent === undefined || child === undefined) continue;
    if (parent === child) continue;
    attributions.push({ parent, child });
  }
  return attributions;
}

/**
 * 核对声明的图内层级与权利要求写出的归属表述是否一致。
 *
 * 只报**矛盾**：权利要求写出「父标记…的…子标记」，而声明的层级里该子标记并不挂在该父
 * 标记之下（直接父标记不是它、也不是它的祖先）⇒ 报 RC8。声明里缺一条边（父标记根本没
 * 出现在声明中）不作判据——那是建模问题，不是矛盾。
 * @param input - 声明的层级边与权利要求/说明书正文。
 * @returns 发现列表（成环说明在前，归属矛盾在后）；无不一致时为空数组。
 */
export function checkFigureHierarchy(input: HierarchyCheckInput): HierarchyCheckFinding[] {
  const hierarchy = indexHierarchy(input.edges);
  const findings: HierarchyCheckFinding[] = hierarchy.cycleEdges.map(edge => ({
    rule: "RC8",
    severity: "warn",
    message:
      `构造层级声明成环：${String(edge.parent)} → ${String(edge.child)} 沿父边回到自身，该条已忽略` +
      "（成环边不参与归属判定，请修正声明的层级）",
    evidence: [`声明层级边：${String(edge.parent)} → ${String(edge.child)}（成环，已忽略）`],
  }));
  const reported = new Set<string>();
  for (const { parent, child } of extractAttributions(input.claimText)) {
    // 两端标记都必须是声明过的节点：只在一侧出现过的标记不作判据。
    if (!hierarchy.nodes.has(parent) || !hierarchy.nodes.has(child)) continue;
    const key = `${String(parent)}>${String(child)}`;
    if (reported.has(key)) continue;
    reported.add(key);
    // 父标记可以是子标记的直接父，也可以是更上位的祖先（间接归属）。
    if (hierarchy.ancestorsOf.get(child)?.has(parent) === true) continue;
    const actual = hierarchy.parentOf.get(child);
    const placement = actual === undefined ? "画在顶层（未声明直接父标记）" : `画在 ${String(actual)} 之下`;
    findings.push({
      rule: "RC8",
      severity: "warn",
      message:
        `权利要求说「${String(parent)}…的…${String(child)}」，而声明的图内层级把 ${String(child)} ${placement}` +
        `（${String(parent)} 不是 ${String(child)} 的上位部件）：图纸层级与权利要求的构造归属不一致` +
        "（专利法第二十六条第四款：权利要求书应当以说明书为依据），请按权利要求重绘图，或把权利要求的归属表述改成与图一致",
      evidence: [
        `权利要求归属表述：${String(parent)} 的 ${String(child)}`,
        actual === undefined
          ? `声明层级：${String(child)} 未声明直接父标记（画在顶层）`
          : `声明层级：${String(child)} 的直接父标记为 ${String(actual)}`,
      ],
    });
  }
  return findings;
}
