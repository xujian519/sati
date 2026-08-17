// cli/commands 子模块 barrel（ui/server 经此消费 chatSearch，见 check-ui-server-boundary 门禁）。
// 勿放进顶层 cli/index.ts——会连带 createLocalGateway 全树，拉大消费方加载面。
export { runChatSearchFormatted, runChatSearch, runChatSearchCli, type RunChatSearchOptions } from "./chatSearch.js";
