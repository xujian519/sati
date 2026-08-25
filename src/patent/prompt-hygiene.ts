/**
 * src/patent — LLM 结构化抽取输入卫生（防提示注入）。
 *
 * 吸收 semantica-cnlaw llm_extraction.py 的 json.dumps 隔离思路：
 * 不可信外部文本（交底书/检索文献/法条/用户输入）统一经 dataBlock 序列化为
 * JSON 字符串字面量，与指令区物理隔离——即使文本内含 `</data>`、围栏闭合符
 * 或注入指令，也无法逃逸出数据段（JSON 字符串里它们只是普通字符，且 `</`
 * 经 `<\/` 转义后字面上不可能出现可闭合外层块的标签文本）。
 *
 * 约定：所有 LLM 结构化抽取通道的「外部文本拼接」必须走 dataBlock，禁止明文
 * 拼接进指令区。指令区只含开发/工作流作者可控的文本。
 */

/**
 * 把不可信外部值序列化为隔离数据块。
 *
 * JSON.stringify 使内容成为单个字符串字面量：换行/引号/反斜杠被转义，无法闭合
 * 外层块。它不转义 `<`，故仅把 `</` 序列额外转义为 `<\/`——单个 `<`（如
 * "厚度<5mm"）保留原样，满足 claim-chart 等下游的逐字引用契约；`</data>`
 * 伪闭合符因 `</` 被转义，字面上不再出现闭合标签，无法逃逸数据段。`\/` 经
 * JSON.parse 还原为 `/`，内容无损。null 输出 "null" 字面量；
 * JSON.stringify(undefined) 返回 undefined，兜底为空字符串。
 */
export function dataBlock(value: unknown): string {
  const json = JSON.stringify(value);
  return `<data>\n${(json ?? "").replace(/<\//g, "<\\/")}\n</data>`;
}
