// adapters/channel/protocol 子模块 barrel。
// ui/server 桥接层经此入口消费 ChannelCommandRegistry 模块符号（barrel 收口面，
// 见 check-ui-server-boundary 门禁）。其余 protocol 符号按需扩展。
export {
  executeChannelCommand,
  getRegisteredCommands,
  resolveCommand,
  resolveIncomingMessage,
  setUpdateRestartHandler,
  type ChannelCommand,
  type CommandExecContext,
} from "./ChannelCommandRegistry.js";
