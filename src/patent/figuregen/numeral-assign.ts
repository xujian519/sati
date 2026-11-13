/**
 * src/patent/figuregen — 附图标号一致性归一（标号分配 + 结构/图面双向对齐）。
 *
 * **用途**：把"附图标记"在两侧对齐——结构侧 `FigureNode.ref`（机器可读）与图面侧 label
 * 里的**可见**标号（本仓惯例「处理模块(20)」）；并在一幅图内按系列自动分配互不冲突的标号。
 *
 * **与 DSH 的对应关系**：标号**分配口径**与 DSH 同口径——每幅图从 `100 + 100 × (图号 − 1)`
 * 起、步进 2（见 {@link numeralSeriesStart} 与 {@link DEFAULT_NUMERAL_STEP}）。故本仓自动
 * 分配出的标号与 DSH 产物可逐幅对照，不会出现"同一幅图两套编号"。本仓在这层之上再加一层
 * **一致性归一**（ref ↔ 图面可见标号）：两处标记各写一处时，缺任一处都会静默失配；这里把它
 * 做成可复算的纯函数，并让渲染器在图面缺标号时补画。
 *
 * **为什么本仓需要「从 label 反推 ref」**：`FigureNode.ref` 是**机器可读**的附图标记
 * （渲染器只把它写进 SVG 的 `data-ref` 属性，**不画到图面上**），而图面上**可见**的标号
 * 靠 label 文本自带。两处各写一处 ⇒ 必然出现两种缺口：
 * - 只写 label 不给 ref ⇒ 图上有可见标号，但核验器回读不到 `data-ref`，图↔文双向核对
 *   （V2/V3）与跨调用占用核对拿不到这个标记；
 * - 只给 ref 不写 label ⇒ `data-ref` 有、图面上看不到标号（读者无从把说明书里的 20 对上图）。
 * 本模块给出两向归一：{@link backfillRefsFromLabels}（label→ref）与
 * {@link findRefsMissingInLabels}（ref→图面待补画清单），后者由渲染器消费（渲染器按 ref
 * 补画 `(ref)`，不在本模块改 label 文本）。
 *
 * **词法复用**（不另写一套标记正则）：
 * - "什么算图面上的附图标记"由 `ref-label.ts` 的 {@link stripRefMark} 判定（半/全角
 *   括号 + 1–3 位数字，与 `svg-annotate.ts` 的 `REF_MARK_PATTERN` 同一口径）；裸数字形态
 *   （「处理模块20」）属说明书正文惯例，**不算图面标记**（同 `svg-annotate.ts` 的
 *   `validateSvgReferences` 口径）；
 * - "取值是否合法"由 `numeral.ts` 的 {@link isRefNumeral}（正整数）判定。
 *
 * **两种号段语义（按调用场景二选一，不混用）**：
 * - {@link numeralSeriesStart} + {@link autoAssignNumerals}：**每幅图一个互不相交的号段**
 *   （图 1 → 100/102、图 2 → 200/202）——同一个 20 在不同图里指不同部件。
 * - {@link assignFamilyNumerals}：**同族连续号段**（`figure_family`，如 FIG.1A/FIG.1B 是
 *   同一套部件的两个视角）——族内第一幅 100/102，第二幅接着 104/106。
 *
 * 纯函数模块：无时钟、无随机、不读文件；归一一律返回新对象，不改入参。
 */

import { stripRefMark } from "./ref-label.js";
import { isRefNumeral } from "./numeral.js";
import { figureNodes, type FigureNode, type FigureSpec } from "./types.js";

/** 一条标号分配结果。 */
export type NumeralAssignment = {
  /** 节点 id。 */
  readonly id: string;
  /** 分配到的附图标记。 */
  readonly numeral: number;
  /** 是否来自调用方的显式声明。 */
  readonly explicit: boolean;
};

/** 标号分配的错误码（冲突/越界）。 */
export type NumeralAssignErrorCode = "conflicting_numeral" | "invalid_numeral_range";

/**
 * 标号分配失败。
 *
 * - `conflicting_numeral`：同一标号被两个节点占用（显式声明撞车，或显式声明落在已占用号上）。
 * - `invalid_numeral_range`：标号/步进/起点越界（不是正整数、或声明里不是阿拉伯数字）。
 */
export class NumeralAssignError extends Error {
  readonly code: NumeralAssignErrorCode;

  constructor(code: NumeralAssignErrorCode, message: string) {
    super(message);
    this.name = "NumeralAssignError";
    this.code = code;
  }
}

/** 标号步进（DSH 同口径）：同一幅图内相邻自动标号相差 2（100、102、104…）。 */
const DEFAULT_NUMERAL_STEP = 2;

/** 每幅图的标号系列起点基数（DSH 同口径）：图 1 从 100 起。 */
const NUMERAL_SERIES_BASE = 100;

/** 每幅图占用的标号段长度（DSH 同口径）：图号 +1 即整体后移 100。 */
const NUMERAL_SERIES_SPAN = 100;

/**
 * 每幅图的标号系列起点：100 + 100 × (图号 − 1)（DSH 同口径）。
 *
 * 图 1 → 100、图 2 → 200、图 3 → 300：各图占用互不相交的号段，跨图复用同一套号段会让
 * "同一个 20 在不同图里指不同部件"，图↔文双向核对就失去了唯一性。
 *
 * @throws NumeralAssignError 图号不是正整数。
 */
export function numeralSeriesStart(figureNumber: number): number {
  if (!Number.isInteger(figureNumber) || figureNumber < 1) {
    throw new NumeralAssignError("invalid_numeral_range", `图号必须是正整数（收到 ${figureNumber}）`);
  }
  return NUMERAL_SERIES_BASE + NUMERAL_SERIES_SPAN * (figureNumber - 1);
}

/** 该字符是否阿拉伯数字（ASCII 0–9；与仓库内 `\d` 的口径一致）。 */
function isDigit(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

/** 文本是否全为阿拉伯数字（非空）。 */
function isDecimalText(text: string): boolean {
  if (text.length === 0) return false;
  for (const ch of text) {
    if (!isDigit(ch)) return false;
  }
  return true;
}

/**
 * 解析调用方声明的标号字符串。
 *
 * 只认阿拉伯数字形态：`"20"` 可，`"20A"`/`"二十"`/`"-5"`/`""` 一律越界报错——标号要能被
 * 写进 `data-ref` 并与说明书正文里的同一串数字对上，非阿拉伯数字做不到这件事。
 */
function parseDeclaredNumeral(raw: string, what: string): number {
  const text = raw.trim();
  if (!isDecimalText(text)) {
    throw new NumeralAssignError("invalid_numeral_range", `${what} 的标号必须是阿拉伯数字（收到 "${raw}"）`);
  }
  const value = Number(text);
  if (!isRefNumeral(value)) {
    throw new NumeralAssignError("invalid_numeral_range", `${what} 的标号必须是正整数（收到 "${raw}"）`);
  }
  return value;
}

/** 下一个右括号的位置（半角/全角皆可）；找不到返回 -1。 */
function findClosingParen(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === ")" || ch === "）") return index;
  }
  return -1;
}

/** 片段内左右括号各一个（= 恰好一个标记片段，而非两个标记连写）。 */
function isSingleParenPair(span: string): boolean {
  let opens = 0;
  let closes = 0;
  for (const ch of span) {
    if (ch === "(" || ch === "（") opens += 1;
    else if (ch === ")" || ch === "）") closes += 1;
  }
  return opens === 1 && closes === 1;
}

/** 片段中的阿拉伯数字（其余字符忽略）。 */
function digitsIn(span: string): string {
  let digits = "";
  for (const ch of span) {
    if (isDigit(ch)) digits += ch;
  }
  return digits;
}

/**
 * 一行 label 里的括号形态标记取值（按出现顺序）。
 *
 * 形态口径不在本文件另立：**判定器是现成词法 `stripRefMark`**——它能从该片段剥净的才是
 * 本仓认定的括号形态标记（半/全角括号 + 1–3 位数字）。本函数只把「被剥掉的片段」还原成
 * 取值，不另写标记正则。
 */
function marksInLine(line: string): number[] {
  const values: number[] = [];
  let index = 0;
  while (index < line.length) {
    const ch = line[index];
    if (ch !== "(" && ch !== "（") {
      index += 1;
      continue;
    }
    const close = findClosingParen(line, index);
    if (close < 0) break;
    const span = line.slice(index, close + 1);
    // 整段可被 stripRefMark 剥净 ⇒ 该片段是标记（形态口径与 stripRefMark 逐字一致）。
    if (stripRefMark(span).trim() === "" && isSingleParenPair(span)) {
      const digits = digitsIn(span);
      if (digits.length >= 1 && digits.length <= 3) {
        const value = Number(digits);
        if (isRefNumeral(value)) values.push(value);
      }
    }
    index = close + 1;
  }
  return values;
}

/** label 里的全部括号形态标记取值（逐行扫描，按出现顺序）。 */
function bracketMarkValues(label: string): number[] {
  const values: number[] = [];
  for (const rawLine of label.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // 本行没有括号标记（现成词法判定）。
    if (stripRefMark(line) === line) continue;
    values.push(...marksInLine(line));
  }
  return values;
}

/**
 * 从 label 尾部解析可见标号（如「处理模块(20)」→ 20）；无标记返回 undefined。
 *
 * 复用现成词法（`stripRefMark` 判定形态、`isRefNumeral` 判定取值），不另写正则。
 * 裸数字形态（「处理模块20」）属说明书正文惯例，**不算图面标记**（同 `svg-annotate.ts` 的
 * `validateSvgReferences` 口径），故不解析——否则「步骤20」这类编号会被当成附图标记。
 */
export function parseLabelNumeral(label: string): number | undefined {
  const values = bracketMarkValues(label);
  if (values.length === 0) return undefined;
  return values[values.length - 1];
}

/**
 * label 是否已含该标号的可见形态（括号形态；含任意位置，不限尾部）。
 *
 * 渲染器的"不重复画"判据用它：已含则不补画，否则会出现「处理模块(20)(20)」。
 */
export function labelContainsNumeral(label: string, numeral: number): boolean {
  if (!isRefNumeral(numeral)) return false;
  return bracketMarkValues(label).includes(numeral);
}

/**
 * label 首行是否以**裸数字**形态结尾且数值等于给定标记（如「处理模块20」）。
 *
 * 只认「独立数字」：前后不能再接数字（否则「处理模块200」里的 200 不等于 20）。
 */
function endsWithBareNumeral(label: string, numeral: number): boolean {
  const firstLine = label.split("\n")[0] ?? "";
  const match = /(?<![0-9])(\d{1,3})(?![0-9])$/u.exec(firstLine.trimEnd());
  return match !== null && Number(match[1]) === numeral;
}

/**
 * 图面补画：label 缺少该标号的可见形态时，在**首行**（组件名行）尾部追加 `(ref)`。
 *
 * 追加形态为 `(ref)`（本仓惯例，**无空格**），与 `svg-annotate.ts` 的追加形态一致；落在首行
 * 是因为 `stripRefMark` 把首行当作组件名主干，标记跟在名字后面才读得通（多行标签
 * 「混料器\n储料仓」补成「混料器(20)\n储料仓」）。
 *
 * 已含该标号则原样返回（不重复画）；标号非法（非正整数）也原样返回。
 */
export function withVisibleNumeral(label: string, numeral: number): string {
  if (!isRefNumeral(numeral)) return label;
  if (labelContainsNumeral(label, numeral)) return label;
  // **裸数字形态也算「这个号已经画在图面上」**：「处理模块20」里的 20 就是该节点的标记，
  // 再补成「处理模块20(20)」是重复标注（而且多出的 4 个字符会撑破布局预算的盒宽 ⇒
  // 渲染复核报「文字被框线贯穿」）。注意这条只用于**渲染补画**的判据；核验侧
  // （`findRefsMissingInLabels`）仍按括号形态判定——裸数字是说明书正文惯例，
  // 不算图面标记（与 `svg-annotate.ts` 的口径一致）。
  if (endsWithBareNumeral(label, numeral)) return label;
  const lines = label.split("\n");
  if (lines.length === 0) return label;
  lines[0] = `${lines[0]}(${numeral})`;
  return lines.join("\n");
}

/**
 * 分配一组节点的附图标记。
 *
 * - `explicit`：调用方显式声明的 id → 标号（字符串形态，含非阿拉伯数字时要报错）。
 * - `reserved`：已被别处占用的标号（跳过，不分配）。
 * - 步进默认 2（DSH 同口径）；同号冲突抛 NumeralAssignError("conflicting_numeral")。
 *
 * 分配顺序：先落显式声明（显式之间撞号即报冲突；显式落在 `reserved` 上同样报冲突），
 * 再按 `ids` 顺序给未声明的节点分配自动号（跳过 `reserved` 与已被显式占用的号）。
 * `ids` 之外的 `explicit` 键不参与分配（没有对应节点可挂）。
 */
export function assignNumerals(
  ids: readonly string[],
  options: {
    readonly figureNumber?: number;
    readonly start?: number;
    readonly step?: number;
    readonly explicit?: Readonly<Record<string, string>>;
    readonly reserved?: readonly string[];
    /** 额外已占用的标号（跳过，不分配）——用于「同族续号」时避开本幅的显式 ref。 */
    readonly taken?: readonly number[];
  },
): NumeralAssignment[] {
  const step = options.step ?? DEFAULT_NUMERAL_STEP;
  if (!Number.isInteger(step) || step < 1) {
    throw new NumeralAssignError("invalid_numeral_range", `标号步进必须是正整数（收到 ${step}）`);
  }
  const start = options.start ?? numeralSeriesStart(options.figureNumber ?? 1);
  if (!isRefNumeral(start)) {
    throw new NumeralAssignError("invalid_numeral_range", `标号起点必须是正整数（收到 ${start}）`);
  }

  /** 已被占用的标号（reserved + 显式声明 + 调用方声明的额外占用 + 已自动分配）。 */
  const taken = new Set<number>();
  for (const raw of options.reserved ?? []) {
    taken.add(parseDeclaredNumeral(raw, "reserved"));
  }
  for (const numeral of options.taken ?? []) {
    if (!isRefNumeral(numeral)) {
      throw new NumeralAssignError("invalid_numeral_range", `已占用标号必须是正整数（收到 ${numeral}）`);
    }
    taken.add(numeral);
  }

  /** id → 分配结果。 */
  const assigned = new Map<string, NumeralAssignment>();
  /** 待自动分配的 id（保持 `ids` 顺序）。 */
  const pending: string[] = [];

  for (const id of ids) {
    if (assigned.has(id)) continue; // 同一 id 重复列出：只分配一次
    const raw = options.explicit?.[id];
    if (raw === undefined) {
      pending.push(id);
      continue;
    }
    const numeral = parseDeclaredNumeral(raw, `节点 ${id}`);
    if (taken.has(numeral)) {
      throw new NumeralAssignError("conflicting_numeral", `标号 ${numeral} 被重复占用（节点 ${id}）`);
    }
    taken.add(numeral);
    assigned.set(id, { id, numeral, explicit: true });
  }

  let candidate = start;
  for (const id of pending) {
    while (taken.has(candidate)) candidate += step;
    taken.add(candidate);
    assigned.set(id, { id, numeral: candidate, explicit: false });
    candidate += step;
  }

  const result: NumeralAssignment[] = [];
  for (const id of ids) {
    const assignment = assigned.get(id);
    if (assignment !== undefined) result.push(assignment);
  }
  return result;
}

/**
 * 对一幅图的节点集合做变换（顶层 nodes **或**各面板的 nodes），返回新 FigureSpec。
 *
 * 多面板附图的节点住在 `panels` 里 ⇒ 归一（回填 ref、补画标号、自动发号）必须覆盖它们，
 * 否则面板里的标记在图面上不显示、在核验侧也查不到（声明了却没核验的假保证）。
 *
 * `transform` 约定：**无变化时返回入参数组本身（同一引用）**，本函数据此判断是否需要
 * 造新对象（无变化 ⇒ 原样返回入参，便于调用方用引用比较判断"是否发生过归一"）。
 */
function mapFigureNodes(
  figure: FigureSpec,
  transform: (nodes: readonly FigureNode[]) => readonly FigureNode[],
): FigureSpec {
  if (figure.panels !== undefined && figure.panels.length > 0) {
    let changed = false;
    const panels = figure.panels.map(panel => {
      const nodes = transform(panel.nodes);
      if (nodes !== panel.nodes) changed = true;
      return { ...panel, nodes: [...nodes] };
    });
    return changed ? { ...figure, panels } : figure;
  }
  const nodes = transform(figure.nodes);
  return nodes === figure.nodes ? figure : { ...figure, nodes: [...nodes] };
}

/**
 * 归一：label 自带可见标号但缺 ref ⇒ 补 ref（让 data-ref 与图面一致）。
 *
 * 只补不删、不改 label 文本；返回新 FigureSpec（不改入参）。已有 ref 的节点原样保留
 * （label 标号与 ref 不一致属冲突，由调用方按 V4 口径处置，本函数不替它选边）。
 * 无可补节点时原样返回入参（同一引用），便于调用方用引用比较判断"是否发生过归一"。
 */
export function backfillRefsFromLabels(figure: FigureSpec): FigureSpec {
  return mapFigureNodes(figure, nodes => {
    let changed = false;
    const next = nodes.map(node => {
      if (node.ref !== undefined) return node;
      const numeral = parseLabelNumeral(node.label);
      if (numeral === undefined) return node;
      changed = true;
      return { ...node, ref: numeral };
    });
    return changed ? next : nodes;
  });
}

/**
 * 归一：ref 有值但 label 里没有对应可见标号 ⇒ 返回「需要在图面上补画的标号」。
 *
 * 供渲染器消费（渲染器按 ref 补画 "(ref)"），不要在此改 label 文本。
 *
 * 「label 标号 ≠ ref」也落在这里：label 写的是 (30)、ref 是 20 时，label 不含 20 ⇒ 20 需
 * 补画，同时 (30) 仍是冲突现场（交给 V4 一类的规则去判），本函数不吞掉这个信号。
 */
export function findRefsMissingInLabels(figure: FigureSpec): { id: string; ref: number }[] {
  const missing: { id: string; ref: number }[] = [];
  for (const node of figureNodes(figure)) {
    if (node.ref === undefined || !isRefNumeral(node.ref)) continue;
    if (labelContainsNumeral(node.label, node.ref)) continue;
    missing.push({ id: node.id, ref: node.ref });
  }
  return missing;
}

/**
 * 自动分配：既无 ref、label 里也无可见标号的节点 ⇒ 按系列分配（100 系列、步进 2）。
 *
 * 显式 ref 的节点不参与；reserved 里的标号跳过。
 * 返回新 FigureSpec（不改入参）+ 分配结果清单。
 *
 * label 里已有可见标号但缺 ref 的节点**不参与**自动分配：那个号由
 * {@link backfillRefsFromLabels} 回填（图面已经写着这个号，自动再发一个号会让同一节点
 * 带两个号）。需要"先回填再自动分配"时按该顺序串起来用。
 */
export function autoAssignNumerals(
  figure: FigureSpec,
  options: { readonly start?: number; readonly step?: number; readonly reserved?: readonly string[] },
): { figure: FigureSpec; assignments: NumeralAssignment[] } {
  const allNodes = figureNodes(figure);
  const pending: FigureNode[] = allNodes.filter(
    node => node.ref === undefined && parseLabelNumeral(node.label) === undefined,
  );
  if (pending.length === 0) return { figure, assignments: [] };

  const assignments = assignNumerals(
    pending.map(node => node.id),
    {
      start: options.start ?? numeralSeriesStart(figure.figure_no),
      step: options.step,
      reserved: options.reserved,
    },
  );
  const byId = new Map(assignments.map(item => [item.id, item.numeral]));
  const next = mapFigureNodes(figure, nodes => {
    let changed = false;
    const mapped = nodes.map(node => {
      const numeral = byId.get(node.id);
      if (numeral === undefined) return node;
      changed = true;
      return { ...node, ref: numeral };
    });
    return changed ? mapped : nodes;
  });
  return { figure: next, assignments };
}

/**
 * 把 ref 补进 label：节点有 ref 而 label 未带该可见标号时，在 label 首行尾部追加 `(ref)`。
 *
 * **这是接线用的可选步骤，不是本模块契约的一部分**（契约里的两个归一函数都不改 label 文本），
 * 存在的理由是一个**构造期不变式**：盒宽由 `layout.ts` 按 FigureSpec 的 label 计算，而渲染器
 * 的补画发生在渲染期——补画的标号不在盒宽预算内，文字会溢出框、与框线相交（渲染复核 RC1 判
 * fail，交付门 `figure-gate` 因此阻断）。
 *
 * 要让"布局、核验、渲染"看到同一份文本（仓库的「核验与渲染必须同源」口径），应在**布局/渲染
 * 之前**调用本函数：label 先带上 `(ref)`，盒宽按带标号的文本算，渲染器的补画随之成为空操作
 * （label 已含该标号 ⇒ 不重复画）。
 *
 * 追加规则与渲染器完全一致（都用 {@link withVisibleNumeral}），故两侧画出的文本逐字相同。
 * 返回新 FigureSpec（不改入参）；无可补节点时原样返回入参。
 */
export function applyVisibleNumerals(figure: FigureSpec): FigureSpec {
  return mapFigureNodes(figure, nodes => {
    let changed = false;
    const next = nodes.map(node => {
      if (node.ref === undefined) return node;
      const label = withVisibleNumeral(node.label, node.ref);
      if (label === node.label) return node;
      changed = true;
      return { ...node, label };
    });
    return changed ? next : nodes;
  });
}

/**
 * 同族跨图续号（`figure_family` 语义）。
 *
 * **语义**：同一次生成里的多幅图若属于同一族（如 FIG.1A / FIG.1B 这对部分视图），
 * 它们**共用一个连续的标号系列**——族内第一幅从 `start` 起发号，后续幅接着上一幅
 * 最后一个号继续，而不是每幅各占一个互不相交的 100 号段。
 *
 * **与 {@link numeralSeriesStart} 的分工**：后者给「互不相交的号段」（不同族/不同图，
 * 同一个 20 在不同图里指不同部件）；本函数给「同族连续号段」（同族即同一套部件的
 * 不同视角，号必须能对上）。两者按语义二选一，不混用。
 *
 * **占用保护**：每幅图已声明的 `ref`（显式标记与从 label 回填的标记）都计入该幅的
 * 已占用集合，自动发号跳过它们 ⇒ 续号不会撞上本幅已有的号；族内后续幅的起点由
 * 上一幅**实际分配出去**的最大号推进 ⇒ 一幅都没发号的图不消耗号段。
 *
 * 与 {@link autoAssignNumerals} 的分工：后者是**单幅**发号（每幅各自 100 系列）；
 * 本函数是**跨幅**发号（同族连续）。
 */
export function assignFamilyNumerals(
  figures: readonly FigureSpec[],
  options: {
    /** 族标识（调用方给的族名，仅用于报告与诊断；空串无意义，调用方应拒收）。 */
    readonly family: string;
    readonly start?: number;
    readonly step?: number;
    readonly reserved?: readonly string[];
  },
): { figures: FigureSpec[]; assignments: NumeralAssignment[]; start: number; step: number } {
  const step = options.step ?? DEFAULT_NUMERAL_STEP;
  if (!Number.isInteger(step) || step < 1) {
    throw new NumeralAssignError("invalid_numeral_range", `标号步进必须是正整数（收到 ${step}）`);
  }
  const start = options.start ?? numeralSeriesStart(figures[0]?.figure_no ?? 1);
  if (!isRefNumeral(start)) {
    throw new NumeralAssignError("invalid_numeral_range", `标号起点必须是正整数（收到 ${start}）`);
  }

  const out: FigureSpec[] = [];
  const assignments: NumeralAssignment[] = [];
  let cursor = start;
  for (const figure of figures) {
    const backfilled = backfillRefsFromLabels(figure);
    const allNodes = figureNodes(backfilled);
    const pending = allNodes.filter(node => node.ref === undefined && parseLabelNumeral(node.label) === undefined);
    if (pending.length === 0) {
      out.push(backfilled);
      continue;
    }
    const taken = allNodes.map(node => node.ref).filter((ref): ref is number => ref !== undefined && isRefNumeral(ref));
    const assigned = assignNumerals(
      pending.map(node => node.id),
      { start: cursor, step, reserved: options.reserved, taken },
    );
    assignments.push(...assigned);
    const highest = assigned.reduce((max, item) => Math.max(max, item.numeral), cursor - step);
    cursor = highest + step;
    const byId = new Map(assigned.map(item => [item.id, item.numeral]));
    out.push(
      mapFigureNodes(backfilled, nodes => {
        let changed = false;
        const mapped = nodes.map(node => {
          const numeral = byId.get(node.id);
          if (numeral === undefined) return node;
          changed = true;
          return { ...node, ref: numeral };
        });
        return changed ? mapped : nodes;
      }),
    );
  }
  return { figures: out, assignments, start, step };
}
