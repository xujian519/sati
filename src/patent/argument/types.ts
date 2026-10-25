/**
 * 论证引用叶子类型：claim-chart / syllogism / claim-binding 三套结构的互操作指针。
 *
 * 本文件只放类型（S-03 先落叶子模块，避免 Wave 1 反向依赖 Wave 3）；
 * 映射函数、`assertArgumentRef` 与去重逻辑由 S-09 补齐，不改变各结构自身存储格式。
 */

/**
 * 指向论证对象的引用。三个字段均可选以兼容既有结构；
 * 不变量「至少一个字段非空」由 S-09 的 `assertArgumentRef` 在构造/映射处校验。
 */
export type ArgumentRef = {
  /** claim-chart 要素编号，如 "1a"。 */
  elementId?: string;
  /** reasoning 事实黑板中的事实引用。 */
  factRef?: string;
  /** 法规/判例条文引用。 */
  articleRef?: string;
};

export type ArgumentGapSource = "claim-chart" | "syllogism" | "claim-binding";

/**
 * 统一缺口条目。`kind` 的取值域由各来源定义并由 S-09 收敛；
 * 现阶段保持字符串以免预先锁死尚未对齐的来源语义。
 */
export type ArgumentGap = {
  ref: ArgumentRef;
  kind: string;
  detail: string;
  source: ArgumentGapSource;
};
