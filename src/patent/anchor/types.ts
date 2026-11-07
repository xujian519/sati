/**
 * src/patent/anchor — 原文锚定的类型契约。
 *
 * 锚定只回答一个问题：某段特征文本能否作为**连续子串**出现在原申请文本中。
 * 它不做同义改写、不做语义概括，也不判断「实质支持」——那些结论由人给出。
 */

/** 归一化文本中的一个字符在原文中的来源区间（左闭右开，按 UTF-16 code unit 计）。 */
export type SourceSpan = {
  start: number;
  end: number;
};

/** 归一化结果：文本本身 + 每个字符到原文的映射（长度与 `text.length` 相同）。 */
export type NormalizedText = {
  text: string;
  spans: SourceSpan[];
};

/** 单条特征的匹配结果。 */
export type FeatureMatch = {
  /** 调用方传入的原始特征文本（不归一化，便于回显）。 */
  feature: string;
  /** 命中的原文区间；未命中为 null。 */
  hit: { start: number; end: number } | null;
};
