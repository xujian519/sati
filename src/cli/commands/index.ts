// cli/commands 子模块 barrel。
// ui/server 桥接层经此入口消费 chatSearch（barrel 收口面，见 check-ui-server-boundary 门禁）。
// 注意：不要把这些符号放进 src/cli/index.ts —— 顶层 cli barrel 会连带
// createLocalGateway/satiServer（gateway+agent+tool+patent 全树），拉大消费方加载面。
export { runChatSearchFormatted, runChatSearch, runChatSearchCli, type RunChatSearchOptions } from "./chatSearch.js";
