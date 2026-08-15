/**
 * 渲染管线的输入契约错误：非法文件名/案卷号/模板 id 等用户输入问题。
 *
 * 与运行时错误（Chrome 缺失、IO 失败）区分，便于工具层映射为
 * `invalid_tool_input` 而非 `tool_execution_failed`。
 */
export class SatiDocumentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SatiDocumentInputError";
  }
}
