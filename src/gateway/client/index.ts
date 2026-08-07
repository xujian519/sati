/**
 * gateway/client 轻量 barrel。
 *
 * 只导出 probe 相关（轻量、无重依赖），供 TUI/CLI 等入口按需 import，
 * 避免拉入 gateway 主 barrel（gateway/index.js）的完整客户端图。
 */

export {
  probeGatewayServer,
  connectRemoteGatewayIfAvailable,
  type ProbeGatewayServerOptions,
} from "./probeServer.js";
