/**
 * 交底书实施例骨架解析（确定性正则，零 LLM）。
 *
 * 从交底书段落提取实施例编号集合（"embodiment_N"），供 mapper 原子对
 * LLM 输出的 embodimentRefs 做交叉校验（引用不存在的实施例 → 计入 gap）。
 *
 * 语义边界（方案 P5）：只解析**交底书**中的「实施例 N」「实施方式 N」；
 * 不含说明书草稿的「具体实施方式」章节与 "[00xx]" 段号（撰写前预检场景
 * 下二者尚不存在）。
 */

/** 中文数字 一~十 → 阿拉伯数字（交底书常见"实施例一"）。 */
const CN_DIGITS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/**
 * 中文数字解析（评审 I2 扩展）：单字（一~十）→ 1-10；「十X」（X=一~九）→ 11-19；
 * 其他多字写法（如"二十"、"九十"）不支持 → undefined（诚实不猜测，避免误解析）。
 */
function parseCnNumber(raw: string): number | undefined {
  if (raw.length === 1) return CN_DIGITS[raw];
  if (raw.length === 2 && raw[0] === "十") {
    const unit = CN_DIGITS[raw[1]];
    return unit !== undefined && unit < 10 ? 10 + unit : undefined;
  }
  return undefined;
}

/** 「实施例 1」「实施例2」「实施方式三」「实施例十一」等；编号为 1-3 位阿拉伯数字或 1-2 位中文数字（后向数字边界）。 */
const EMBODIMENT_RE = /(?:实施例|实施方式)\s*([0-9]{1,3}|[一二三四五六七八九十]{1,2})(?!\d)/g;

/** 提取实施例编号列表（去重 + 按数字升序，确定性输出）。 */
export function extractEmbodimentIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(EMBODIMENT_RE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const num = /^\d+$/.test(raw) ? Number(raw) : parseCnNumber(raw);
    if (num !== undefined && Number.isInteger(num) && num >= 1) {
      ids.add(`embodiment_${num}`);
    }
  }
  return [...ids].sort((a, b) => embodimentNumber(a) - embodimentNumber(b));
}

/** 解析 "embodiment_N" → N（供排序；非法输入按 0 处理，不参与）。 */
function embodimentNumber(id: string): number {
  const m = /^embodiment_(\d+)$/.exec(id);
  return m === null ? 0 : Number(m[1]);
}
