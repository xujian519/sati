/**
 * src/patent/fees/fees — 官费索引的装载与校验。
 *
 * 索引承载的是「一个案子能被怎么计价」：有哪些费种、在每个环节缴、按什么基准计数，以及
 * 每个金额的抄录记录（`amount` / `sourceDoc` / `sourceUrl` / `publishedOn` / `verifiedOn`）。
 *
 * **装载失败是设计，不是意外**：一个"以空表运行"的工具会把每个案子都报成已计价——它给出的
 * 是 0 元或一份没有金额的清单，而使用者看不出它其实什么都没读进来。因此资产缺失、不是映射、
 * 条目为空、id 重复、枚举非法、缺金额又不写理由，一律在此 fail-loud。
 *
 * 与「金额未转录」区分：`amount: null` 而价格在 `tiers` 里是**合法**的（年费就是），
 * 而 `amount: null` 又没有 `unpriceableReason` 是**资产缺陷**。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseYuan } from "./money.js";
import type {
  AnnuityTier,
  FeeBasis,
  FeeItem,
  FeeTable,
  FeeTrigger,
  FeeValueSource,
  LatePaymentRule,
  PatentType,
  ReductionKind,
  ReductionKindRule,
} from "./types.js";

/** 官费索引文件名。 */
export const FEE_FILE_NAME = "cn-fees.yaml";

/** 随包资产路径（`dist/assets/patent/fees/`；源码运行时为 `<repo>/assets/...`）。 */
const PACKAGED_FEE_PATH = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../assets/patent/fees",
  FEE_FILE_NAME,
);

/** 官费索引不可读、不是映射、或内容非法时抛出。 */
export class FeeTableError extends Error {
  /**
   * @param message - 索引哪里不对。
   */
  constructor(message: string) {
    super(message);
    this.name = "FeeTableError";
  }
}

/** 费种可能产生的环节。 */
export const FEE_TRIGGERS: readonly FeeTrigger[] = [
  "filing",
  "substantive-examination",
  "grant-registration",
  "annual-fee",
  "reexamination",
  "invalidation",
  "evaluation-report",
  "term-compensation",
  "document-copy",
  "restoration",
  "extension",
  "record-change",
  "pct-grace",
  "pct-national-phase",
];

/** 可能的计数基准。 */
export const FEE_BASES: readonly FeeBasis[] = [
  "per-case",
  "per-claim-beyond",
  "per-page-beyond",
  "per-priority",
  "per-annuity-year",
  "per-month",
];

/** 条目可以限定的专利类型。 */
export const PATENT_TYPES: readonly PatentType[] = ["invention", "utility-model", "design"];

/** 条例可以登记的费减资格。 */
export const REDUCTION_KINDS: readonly ReductionKind[] = ["individual", "enterprise", "institution"];

/** 专利类型的中文名（报告与说明用）。 */
export const PATENT_TYPE_LABELS: Record<PatentType, string> = {
  invention: "发明",
  "utility-model": "实用新型",
  design: "外观设计",
};

/** 计数需要扣减免费基数的基准。 */
const BEYOND_BASES: readonly FeeBasis[] = ["per-claim-beyond", "per-page-beyond"];

/**
 * 某个环节在索引里**没有条目**时的说明。
 *
 * 为什么必须有：`triggers` 是报告的覆盖面，调用方点了「办登」却拿到一份空清单，读起来就是
 * 「办登不收费」——而办登要缴的是授权当年的年费，只是那个费种挂在 `annual-fee` 名下。
 * 空表 ≠ 免费，这句话只写在工具描述里不够，必须出现在**这一次**的报告里。
 */
export const EMPTY_TRIGGER_NOTES: Partial<Record<FeeTrigger, string>> = {
  "grant-registration":
    "「grant-registration（办理登记手续）」现行没有独立费种：专利登记费、公告印刷费已由财税〔2018〕37号自 2018-08-01 起停征。" +
    "办登时应缴的是**授予专利权当年的年费**（专利法实施细则第114条），请把 `annual-fee` 列入 triggers 并在 `annuityYears` 给出该年度" +
    "——本报告没有这一行，不等于办登免费。",
};

/** 缺具体说明时对空环节的通用话术。 */
export function emptyTriggerNote(trigger: FeeTrigger): string {
  const specific = EMPTY_TRIGGER_NOTES[trigger];
  if (specific !== undefined) return specific;
  return (
    `triggers 里的「${trigger}」在费用索引里没有适用条目：可能该环节现行确无独立费种，` +
    `也可能是所给专利类型不适用。这不等于该环节不收费——请核对 triggers 与 patentType。`
  );
}

/** 索引文件的绝对路径：给了覆盖就用覆盖（相对进程工作目录解析），否则用随包资产。 */
export function feeTablePath(override?: string): string {
  return override !== undefined && override.trim() !== "" ? override : PACKAGED_FEE_PATH;
}

/** 已装载索引的进程内缓存（按路径分桶；资产是只读的，改文件后重启即可）。 */
const cache = new Map<string, FeeTable>();

/**
 * 装载官费索引。
 * @param tablePath - 路径覆盖；缺省用随包资产。
 * @returns 解析后的索引。
 * @throws FeeTableError - 文件不可读或内容非法。
 */
export function loadFeeTable(tablePath?: string): FeeTable {
  const path = feeTablePath(tablePath);
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new FeeTableError(
      `官费索引不可读：${path}（${error instanceof Error ? error.message : String(error)}）。` +
        `计价依赖该资产；缺失时**不能**以空表继续——那会把每个案子都报成已计价。`,
    );
  }
  const table = parseFeeTable(source, path);
  cache.set(path, table);
  return table;
}

/** 清空装载缓存（测试与热更新用）。 */
export function clearFeeTableCache(): void {
  cache.clear();
}

/** 校验失败的构造器：一律返回 `FeeTableError`。 */
type Fail = (message: string) => FeeTableError;

/**
 * 解析一份官费索引。
 * @param source - 文件正文。
 * @param origin - 文件路径，仅用于报错。
 * @returns 解析后的索引。
 * @throws FeeTableError - 任一处字段缺失或非法。
 */
export function parseFeeTable(source: string, origin: string): FeeTable {
  const fail: Fail = message => new FeeTableError(`官费索引 ${origin}：${message}`);
  let root: Record<string, unknown>;
  try {
    root = readMapping(parseYaml(source) as unknown, "根节点", fail);
  } catch (error) {
    if (error instanceof FeeTableError) throw error;
    throw new FeeTableError(
      `官费索引 ${origin}：YAML 解析失败（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const reductionPercent = readReductionPercent(root["reductionPercent"], fail);
  return {
    document: readString(root, "document", fail),
    revision: readOptionalString(root, "revision", fail),
    currency: readString(root, "currency", fail),
    reductionPercent,
    reductionKinds: readReductionKinds(root["reductionKinds"], fail),
    reductionTiming: readOptionalString(root, "reductionTiming", fail),
    ...readValueSource(root, fail),
    items: readItems(root["items"], fail),
  };
}

const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** 读取一个映射；不是映射即失败。 */
function readMapping(value: unknown, where: string, fail: Fail): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail(`${where} 必须是映射（YAML mapping），得到：${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/** 读取一个必填非空字符串。 */
function readString(mapping: Record<string, unknown>, field: string, fail: Fail): string {
  const value = mapping[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`字段 ${field} 必须是非空字符串，得到：${describe(value)}`);
  }
  return value;
}

/** 读取一个可选字符串（null / 缺失都算未登记）。 */
function readOptionalString(mapping: Record<string, unknown>, field: string, fail: Fail): string | null {
  const value = mapping[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`字段 ${field} 必须是非空字符串或 null，得到：${describe(value)}`);
  }
  return value;
}

/** 读取一个可选日期（`YYYY-MM-DD`）。 */
function readOptionalDate(mapping: Record<string, unknown>, field: string, fail: Fail): string | null {
  const value = mapping[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw fail(
      `字段 ${field} 必须是 YYYY-MM-DD 或 null，得到：${describe(value)}（日期请加引号，避免被 YAML 解析成别的类型）`,
    );
  }
  return value;
}

/** 读取一个必须落在允许集合内且只出现一次的取值。 */
function readEnum<T extends string>(value: unknown, allowed: readonly T[], where: string, fail: Fail): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw fail(`${where} 必须是 ${allowed.join(" / ")} 之一，得到：${describe(value)}`);
  }
  return value as T;
}

/** 读取一个非负整数。 */
function readCount(value: unknown, where: string, fail: Fail): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw fail(`${where} 必须是非负整数，得到：${describe(value)}`);
  }
  return value;
}

/** 读取一个可选非负整数。 */
function readOptionalCount(mapping: Record<string, unknown>, field: string, fail: Fail): number | null {
  const value = mapping[field];
  if (value === undefined || value === null) return null;
  return readCount(value, field, fail);
}

/** 读取一个可选布尔值。 */
function readOptionalBoolean(mapping: Record<string, unknown>, field: string, fail: Fail): boolean | null {
  const value = mapping[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw fail(`字段 ${field} 必须是布尔值或 null，得到：${describe(value)}`);
  }
  return value;
}

/** 读取一个 `(0, 100]` 之间的百分数。 */
function readPercent(value: unknown, where: string, fail: Fail): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw fail(`${where} 必须是 (0, 100] 之间的百分数，得到：${describe(value)}`);
  }
  return value;
}

/** 读取一个金额字段：null 表示未转录，否则必须是十进制元金额（数字会被规范成字符串）。 */
function readOptionalAmount(mapping: Record<string, unknown>, field: string, fail: Fail): string | null {
  const value = mapping[field];
  if (value === undefined || value === null) return null;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || parseYuan(text) === null) {
    throw fail(`字段 ${field} 必须是 null 或元金额（最多两位小数），得到：${describe(value)}`);
  }
  return text;
}

/** 读取抄录出处。 */
function readValueSource(mapping: Record<string, unknown>, fail: Fail): FeeValueSource {
  return {
    sourceDoc: readOptionalString(mapping, "sourceDoc", fail),
    sourceUrl: readOptionalString(mapping, "sourceUrl", fail),
    publishedOn: readOptionalDate(mapping, "publishedOn", fail),
    verifiedOn: readOptionalDate(mapping, "verifiedOn", fail),
    effectiveFrom: readOptionalDate(mapping, "effectiveFrom", fail),
  };
}

/** 读取减缴比例（单独 / 共同）。 */
function readReductionPercent(value: unknown, fail: Fail): { single: number; joint: number } {
  const mapping = readMapping(value, "字段 reductionPercent", fail);
  const single = readPercent(mapping["single"], "reductionPercent.single", fail);
  const joint = readPercent(mapping["joint"], "reductionPercent.joint", fail);
  if (joint >= single) {
    throw fail(
      `reductionPercent 必须体现「共同申请减得更少」：joint（${String(joint)}）应小于 single（${String(single)}）。` +
        `《专利收费减缴办法》第四条规定单独为 85%、两个以上共同为 70%。`,
    );
  }
  return { single, joint };
}

/** 读取减缴资格清单。 */
function readReductionKinds(value: unknown, fail: Fail): ReductionKindRule[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(`字段 reductionKinds 必须是非空数组，得到：${describe(value)}`);
  }
  const seen = new Set<ReductionKind>();
  return value.map(raw => {
    const mapping = readMapping(raw, "reductionKinds 的每一项", fail);
    const kind = readEnum(mapping["kind"], REDUCTION_KINDS, "reductionKinds.kind", fail);
    if (seen.has(kind)) throw fail(`reductionKinds 重复声明了 ${kind}`);
    seen.add(kind);
    return { kind, label: readString(mapping, "label", fail), eligibility: readString(mapping, "eligibility", fail) };
  });
}

/** 读取条目清单，拒绝重复 id。 */
function readItems(value: unknown, fail: Fail): FeeItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(
      `字段 items 必须是非空数组，得到：${describe(value)}。条目为空的索引会让每个案子都报成「无可计价费用」，` +
        `而使用者看不出索引其实没读进来。`,
    );
  }
  const seen = new Set<string>();
  return value.map(raw => {
    const mapping = readMapping(raw, "items 的每一项", fail);
    const id = readString(mapping, "id", fail);
    if (seen.has(id)) throw fail(`条目 id 重复：${id}`);
    seen.add(id);
    const basis = readEnum(mapping["basis"], FEE_BASES, `${id}.basis`, fail);
    const freeUnits = readOptionalCount(mapping, "freeUnits", fail);
    if (BEYOND_BASES.includes(basis) && freeUnits === null) {
      throw fail(`${id} 的 basis 为 ${basis} 时必须给出 freeUnits（免费基数）`);
    }
    if (freeUnits !== null && !BEYOND_BASES.includes(basis)) {
      throw fail(`${id} 的 basis 为 ${basis} 时不得给出 freeUnits`);
    }
    const amount = readOptionalAmount(mapping, "amount", fail);
    const tiers = readTiers(mapping["tiers"], id, basis, fail);
    const unpriceableReason = readOptionalString(mapping, "unpriceableReason", fail);
    if (amount === null && tiers.length === 0 && unpriceableReason === null) {
      throw fail(
        `${id} 没有金额：` +
          `要么给出 amount，要么给出 tiers，要么用 unpriceableReason 说明为什么给不出——` +
          `「留空」不是一种状态。`,
      );
    }
    return {
      id,
      name: readString(mapping, "name", fail),
      trigger: readEnum(mapping["trigger"], FEE_TRIGGERS, `${id}.trigger`, fail),
      patentTypes: readPatentTypes(mapping["patentTypes"], id, fail),
      basis,
      ...(freeUnits === null ? {} : { freeUnits }),
      amount,
      reducible: readOptionalBoolean(mapping, "reducible", fail),
      ...readReductionYears(mapping, id, basis, fail),
      tiers,
      ...readLatePayment(mapping["latePayment"], id, basis, fail),
      legalBasis: readOptionalString(mapping, "legalBasis", fail),
      ...(unpriceableReason === null ? {} : { unpriceableReason }),
      ...readOptionalNote(mapping, fail),
      ...readValueSource(mapping, fail),
    };
  });
}

/** 读取条目特有的口径提示。 */
function readOptionalNote(mapping: Record<string, unknown>, fail: Fail): { note?: string } {
  const note = readOptionalString(mapping, "note", fail);
  return note === null ? {} : { note };
}

/** 读取可选的专利类型清单。 */
function readPatentTypes(value: unknown, id: string, fail: Fail): PatentType[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(`${id}.patentTypes 必须是 null 或非空数组，得到：${describe(value)}`);
  }
  const types = value.map(item => readEnum(item, PATENT_TYPES, `${id}.patentTypes 的取值`, fail));
  if (new Set(types).size !== types.length) throw fail(`${id}.patentTypes 有重复取值`);
  return types;
}

/** 读取减缴年度上限，只有年费类条目可以带。 */
function readReductionYears(
  mapping: Record<string, unknown>,
  id: string,
  basis: FeeBasis,
  fail: Fail,
): { reductionMaxYears?: number } {
  const years = readOptionalCount(mapping, "reductionMaxYears", fail);
  if (years === null) return {};
  if (basis !== "per-annuity-year") {
    throw fail(`${id} 的 basis 为 ${basis} 时不得给出 reductionMaxYears（它只对年费有意义）`);
  }
  return { reductionMaxYears: years };
}

/** 读取年费分档，拒绝区间重叠。 */
function readTiers(value: unknown, id: string, basis: FeeBasis, fail: Fail): AnnuityTier[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail(`${id}.tiers 必须是数组，得到：${describe(value)}`);
  if (value.length > 0 && basis !== "per-annuity-year") {
    throw fail(`${id} 的 basis 为 ${basis} 时不得给出 tiers（分档只对年费有意义）`);
  }
  const tiers = value.map(raw => {
    const mapping = readMapping(raw, `${id}.tiers 的每一项`, fail);
    const fromYear = readCount(mapping["fromYear"], `${id}.tiers.fromYear`, fail);
    const toYear = readCount(mapping["toYear"], `${id}.tiers.toYear`, fail);
    if (toYear < fromYear) {
      throw fail(`${id}.tiers 的 toYear 不得早于 fromYear（${String(fromYear)}–${String(toYear)}）`);
    }
    const amount = readOptionalAmount(mapping, "amount", fail);
    if (amount === null) throw fail(`${id}.tiers 的 amount 必须是元金额`);
    return { fromYear, toYear, amount };
  });
  const sorted = [...tiers].sort((left, right) => left.fromYear - right.fromYear);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && current.fromYear <= previous.toYear) {
      throw fail(
        `${id}.tiers 的年度区间重叠：${String(previous.fromYear)}–${String(previous.toYear)} 与 ` +
          `${String(current.fromYear)}–${String(current.toYear)}`,
      );
    }
  }
  return tiers;
}

/** 读取滞纳金规则，只有年费类条目可以带。 */
function readLatePayment(value: unknown, id: string, basis: FeeBasis, fail: Fail): { latePayment?: LatePaymentRule } {
  if (value === undefined || value === null) return {};
  if (basis !== "per-annuity-year") {
    throw fail(`${id} 的 basis 为 ${basis} 时不得给出 latePayment（滞纳金只针对年费）`);
  }
  const mapping = readMapping(value, `${id}.latePayment`, fail);
  const maxMonths = readCount(mapping["maxMonths"], `${id}.latePayment.maxMonths`, fail);
  const tabulatedMonths = readCount(mapping["tabulatedMonths"], `${id}.latePayment.tabulatedMonths`, fail);
  if (tabulatedMonths > maxMonths) {
    throw fail(
      `${id}.latePayment.tabulatedMonths（${String(tabulatedMonths)}）不得超过 maxMonths（${String(maxMonths)}）：` +
        `已列表的月份必须是法定窗口的子集，否则会给出窗口之外的金额。`,
    );
  }
  return {
    latePayment: {
      monthlyPercent: readPercent(mapping["monthlyPercent"], `${id}.latePayment.monthlyPercent`, fail),
      maxMonths,
      tabulatedMonths,
      legalBasis: readOptionalString(mapping, "legalBasis", fail),
      ...readValueSource(mapping, fail),
    },
  };
}

/** 把未知值渲染成错误信息里的一段说明。 */
function describe(value: unknown): string {
  if (value === undefined) return "（缺失）";
  if (typeof value === "object") return Array.isArray(value) ? `数组（${String(value.length)} 项）` : "映射";
  return JSON.stringify(value);
}
