/**
 * src/patent — LLM 结构化抽取输入卫生（防提示注入）。
 *
 * 吸收 semantica-cnlaw llm_extraction.py 的 json.dumps 隔离思路：
 * 不可信外部文本（交底书/检索文献/法条/用户输入）统一经 dataBlock 序列化为
 * JSON 字符串字面量，与指令区物理隔离——即使文本内含 `</data>`、围栏闭合符
 * 或注入指令，也无法逃逸出数据段（JSON 字符串里它们只是普通字符，且 `<` 经
 * `<` 转义后字面上不可能出现可闭合外层块的标签文本）。
 *
 * 约定：所有 LLM 结构化抽取通道的「外部文本拼接」必须走 dataBlock，禁止明文
 * 拼接进指令区。指令区只含开发/工作流作者可控的文本。
 */

/**
 * 把不可信外部值序列化为隔离数据块。
 *
 * JSON.stringify 使内容成为单个字符串字面量：换行/引号/反斜杠被转义，无法闭合
 * 外层块。但它不转义 `<`，故额外用 `\u003c` 转义数据内的全部 `<`——`</data>`
 * 在字面上不再出现，伪闭合符不可能逃逸数据段；`\u003c` 经 JSON.parse 还原为
 * 原文，内容无损。null 输出 "null" 字面量；JSON.stringify(undefined) 返回
 * undefined，兜底为空字符串。
 */
export function dataBlock(value: unknown): string {
  const json = JSON.stringify(value);
  return `<data>\n${(json ?? "").replace(/</g, "\\u003c")}\n</data>`;
}

/** 围栏闭合符：数据文本若含它会在明文拼接下打断围栏（dataBlock 下已安全）。 */
export const FENCE_CLOSER = "```";

/**
 * 纵深防御：剥离数据文本中明显的提示注入指令（不替代 dataBlock）。
 *
 * 仅匹配强信号短语（完整指令句式），不匹配孤立出现的"忽略/忘记"（正常法律
 * 文本中"忽略"常见，误伤会破坏原文）。默认 handler 只用 dataBlock（保原文
 * 可恢复）；需要双保险的调用方可自行套用 safeDataBlock。
 */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(?:all\s+)?(?:previous|above)\s+(?:instructions?|prompts?|content)/gi, "[ignored instruction]"],
  [/disregard\s+(?:all\s+)?(?:previous|above)\s+(?:instructions?|prompts?|content)/gi, "[ignored instruction]"],
  [/忽略(?:以上|上述|此前)?(?:所有)?(?:指令|提示|要求|内容)/g, "[已忽略指令]"],
  [/忘记(?:以上|上述|此前)?(?:所有)?(?:指令|提示|要求)/g, "[已忽略指令]"],
  [/无视(?:以上|上述|此前)?(?:所有)?(?:指令|提示|要求)/g, "[已忽略指令]"],
];

/** 剥离强信号注入指令（保守；无强信号命中时原样返回）。 */
export function stripPromptInjection(value: string): string {
  let out = value;
  for (const [pattern, replacement] of INJECTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** dataBlock + stripPromptInjection 双保险（用于极不信任来源且不介意改写原文时）。 */
export function safeDataBlock(value: string): string {
  return dataBlock(stripPromptInjection(value));
}
