/**
 * 可选方法在本进程未接线时的**抛出**语义（与 `not_configured` 降级结果相对）。
 *
 * 多数可选能力（always_on_* / knowledge_capabilities）未接线时可以返回
 * `notConfigured(...)` 占位结果，调用方读 `error.code` 自行降级；但像
 * `close_project_sessions` 这类"操作是否真的发生"决定后续动作的方法，占位结果
 * 会被误读成"已经排空"——调用方随后就在活跃写入器之下删文件。这类调用点必须
 * 拿到一个显式失败，且能凭 `code` 与其它请求失败区分开。
 */
export class GatewayMethodUnavailableError extends Error {
  public readonly code = "method_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "GatewayMethodUnavailableError";
  }
}
