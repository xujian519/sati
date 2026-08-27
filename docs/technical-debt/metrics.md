# Sati 技术债务指标基线与趋势

> 由 `node scripts/measure-techdebt.mjs --update` 自动生成，谨防手工编辑。
> 最近一次快照：**2026-08-27**

## 规模

| 维度 | 值 |
|---|---|
| src TS 文件 / 行数 | 1020 / 180236 |
| src JS 文件 | 0 |
| tests 文件 | 490 |
| ui/src 文件 / 行数 | 454 / 81446 |
| ui/server 文件 / 行数 | 102 / 30933 |

## 异味指标（越少越好）

| 指标 | 总量 | 热点模块 |
|---|---|---|
| `any`/`@ts-expect-error`/`@ts-ignore` | 1 | context(1) |
| 裸 `console.*` | 153 | cli(137) · telemetry(8) · adapters(3) |
| 空 `catch {}` | 0 | — |
| 静默吞错 `catch`（体仅注释/空白） | 155 | adapters(40) · always-on(15) · tool(14) |
| 无参 `catch {` | 397 | adapters(70) · patent(42) · tool(38) |
| `TODO/HACK/FIXME/XXX` | 4 | always-on(4) |
| 分层违规 `ui/server→src` | 14 | — |
| 分层违规 `src→ui` | 0 | — |
| edgeclaw `lib` 编译产物直连 | 1 | — |
| 知识卡逐字节重复（组 / 冗余文件 / 冗余字节） | 72 组 · 92 文件 · 546268 B | — |

## God function（单函数 ≥ 300 行）

| 文件 | 函数 | 行 | 类型 |
|---|---|---|---|
| `ui/src/components/chat/hooks/useChatComposerState.ts` | `useChatComposerState` | 1433 | function |
| `ui/src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx` | `PdfDocumentPreview` | 1138 | function |
| `ui/src/components/app-shell/SidebarV2.tsx` | `SidebarV2` | 1017 | function |
| `ui/src/components/chat/hooks/useChatSessionState.ts` | `useChatSessionState` | 941 | function |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx` | `MessagesPaneV2` | 937 | function |
| `src/router/RouterRuntime.ts` | `createRouterRuntime` | 877 | function |
| `ui/src/components/main-content-v2/FilesV2.tsx` | `FilesV2` | 877 | function |
| `ui/src/components/main-content-v2/SkillsV2.tsx` | `ImportFromFolder` | 854 | function |
| `ui/src/components/chat-v2/MessagesPaneV2.render.test.tsx` | `(anonymous)` | 842 | arrow |
| `ui/src/components/chat/view/subcomponents/MessageComponent.tsx` | `(anonymous)` | 812 | arrow |
| `ui/src/stores/useSessionStore.ts` | `useSessionStore` | 807 | function |
| `ui/src/components/chat-v2/ComposerV2.tsx` | `ComposerV2` | 782 | function |
| `ui/src/components/git-panel/hooks/useGitPanelController.ts` | `useGitPanelController` | 704 | function |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | `useChatRealtimeHandlers` | 693 | function |
| `ui/src/components/app-shell/AppShellV2.tsx` | `AppShellV2` | 678 | function |
| `ui/src/hooks/useProjectsState.ts` | `useProjectsState` | 643 | function |
| `src/adapters/channel/tui/app/TuiApp.tsx` | `TuiApp` | 642 | function |
| `src/cli/sati.ts` | `main` | 635 | function |
| `ui/src/components/onboarding/view/subcomponents/LlmConfigurationStep.tsx` | `LlmConfigurationStep` | 630 | function |
| `ui/src/components/chat-v2/ChatInterfaceV2.tsx` | `ChatInterfaceV2` | 626 | function |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | `(anonymous)` | 598 | arrow |
| `ui/src/components/main-content/view/MainContent.tsx` | `SplitBody` | 574 | function |
| `src/context/memory/edgeclaw-memory-core/src/core/review/dream-review.ts` | `run` | 524 | method |
| `src/cli/createLocalGateway.ts` | `createLocalGateway` | 511 | function |
| `src/tool/builtin/readFile.ts` | `createReadFileTool` | 509 | function |
| `src/context/memory/edgeclaw-memory-core/src/core/retrieval/reasoning-loop.ts` | `retrieve` | 484 | method |
| `src/context/memory/edgeclaw-memory-core/src/core/pipeline/heartbeat.ts` | `runHeartbeat` | 477 | method |
| `ui/src/components/main-content-v2/CronV2.tsx` | `CronFormView` | 475 | function |
| `ui/src/components/settings/view/modelPool/components/ProviderCard.tsx` | `ProviderCard` | 447 | function |
| `ui/src/components/code-editor/view/subcomponents/DocxBuiltinPreview.tsx` | `DocxBuiltinPreview` | 439 | function |
| `src/cli/createLocalGateway.ts` | `prepareSessionRuntime` | 429 | method |
| `src/always-on/runtime/DiscoveryFire.ts` | `run` | 414 | method |
| `src/router/RouterRuntime.ts` | `execute` | 411 | function |
| `ui/src/components/chat-v2/processGrouping.test.ts` | `(anonymous)` | 409 | arrow |
| `ui/src/components/code-editor/view/subcomponents/SpreadsheetInteractivePreview.tsx` | `SpreadsheetInteractivePreview` | 407 | function |
| `src/gateway/client/eventMapping.ts` | `mapAgentEventForTurn` | 405 | function |
| `ui/src/components/chat-v2/MessageRowV2.tsx` | `MessageRowV2` | 403 | function |
| `ui/src/components/kanban/hooks/useBoardState.ts` | `useBoardState` | 398 | function |
| `ui/src/components/settings/view/integrations/im/components/WeComChannelSection.tsx` | `WeComChannelSection` | 398 | function |
| `ui/src/components/chat/hooks/useSlashCommands.ts` | `useSlashCommands` | 395 | function |
| `ui/src/components/main-content-v2/CronV2.test.tsx` | `(anonymous)` | 384 | arrow |
| `src/web/client/webMessage.ts` | `applyWebGatewayEvent` | 383 | function |
| `src/tool/execution/ToolRuntime.ts` | `execute` | 382 | method |
| `src/tool/builtin/readFile.ts` | `(anonymous)` | 381 | arrow |
| `ui/src/components/app-shell/MainAreaV2.tsx` | `MainAreaV2Content` | 381 | function |
| `ui/src/components/settings/view/integrations/im/components/FeishuChannelSection.tsx` | `FeishuChannelSection` | 381 | function |
| `ui/src/components/chat/tools/components/InteractiveRenderers/AskUserQuestionPanel.tsx` | `AskUserQuestionPanel` | 378 | arrow |
| `src/agent/loop/AgentLoop.ts` | `handleModelError` | 370 | method |
| `ui/src/components/chat/hooks/useFileMentions.tsx` | `useFileMentions` | 366 | function |
| `ui/src/components/settings/view/agentRoute/components/RouterSection.tsx` | `RouterSection` | 355 | function |
| `ui/src/components/main-content/view/MainContent.tsx` | `MainContent` | 346 | function |
| `src/tool/builtin/patentPdfDownload.ts` | `createPatentPdfDownloadTool` | 343 | function |
| `src/patent/graph/domains/inventiveness.ts` | `buildInventivenessGraph` | 342 | function |
| `ui/src/components/main-content-v2/PlansAndCronJobs.tsx` | `PlansAndCronJobs` | 334 | function |
| `src/gateway/client/telemetry.ts` | `emitSessionTelemetry` | 333 | function |
| `ui/src/components/main-content-v2/DashboardV2.tsx` | `DashboardV2` | 332 | function |
| `ui/src/hooks/useSatiConfig.ts` | `useSatiConfigState` | 332 | function |
| `ui/src/components/settings/view/agentSearch/components/ToolsSection.tsx` | `ToolsSection` | 328 | function |
| `src/gateway/server/GatewayWsConnection.ts` | `dispatchRequest` | 316 | method |
| `ui/src/components/code-editor/view/CodeEditor.tsx` | `CodeEditor` | 310 | function |
| `ui/src/components/chat-v2/SubagentDetailMessageFlow.tsx` | `SubagentDetailMessageFlow` | 309 | function |
| `ui/src/components/settings/view/integrations/im/components/WeixinChannelSection.tsx` | `WeixinChannelSection` | 303 | function |

## Top 30 大文件

| 文件 | 行 |
|---|---|
| `ui/src/components/main-content-v2/SkillsV2.tsx` | 2503 |
| `src/cli/createLocalGateway.ts` | 2461 |
| `src/agent/loop/AgentLoop.ts` | 2310 |
| `ui/server/sati-bridge.js` | 2128 |
| `ui/src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx` | 1861 |
| `ui/server/routes/taskmaster.js` | 1854 |
| `src/adapters/channel/wecom/WeComChannel.ts` | 1764 |
| `src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts` | 1711 |
| `ui/src/components/chat/hooks/useChatComposerState.ts` | 1631 |
| `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts` | 1624 |
| `src/model/catalog/providers.ts` | 1593 |
| `ui/src/components/code-editor/view/subcomponents/CodeEditorBinaryFile.tsx` | 1523 |
| `src/adapters/channel/weixin/WeixinChannel.ts` | 1497 |
| `ui/server/routes/git.js` | 1490 |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx` | 1447 |
| `ui/src/stores/useSessionStore.ts` | 1441 |
| `ui/src/components/main-content-v2/DashboardV2.tsx` | 1352 |
| `src/gateway/client/InProcessGateway.ts` | 1350 |
| `src/adapters/channel/feishu/FeishuChannel.ts` | 1337 |
| `ui/src/components/app-shell/SidebarV2.tsx` | 1305 |
| `ui/src/components/chat-v2/processGrouping.ts` | 1296 |
| `src/always-on/runtime/DiscoveryFire.ts` | 1257 |
| `src/router/RouterRuntime.ts` | 1221 |
| `ui/src/components/chat/hooks/useChatSessionState.ts` | 1177 |
| `ui/server/routes/commands.js` | 1148 |
| `src/context/memory/edgeclaw-memory-core/src/core/file-memory.ts` | 1139 |
| `ui/server/routes/agent.js` | 1136 |
| `ui/src/components/main-content/view/MainContent.tsx` | 1106 |
| `ui/server/routes/config.js` | 1103 |
| `ui/src/components/main-content-v2/CronV2.tsx` | 1098 |

## 测试覆盖（tests/<模块> 文件数）

| 模块 | 测试文件 |
|---|---|
| patent | 101 |
| tool | 59 |
| knowledge | 43 |
| agent | 40 |
| gateway | 27 |
| context | 26 |
| model | 25 |
| session | 24 |
| always-on | 13 |
| mcp | 13 |
| router | 13 |
| extension | 10 |
| cron | 9 |
| rule | 9 |
| literature | 8 |
| pilot | 8 |
| cli | 7 |
| web | 7 |
| permission | 4 |
| test-support | 4 |
| workflow | 4 |
| adapters | 3 |
| methodology | 3 |
| telemetry | 3 |
| board | 2 |
| shared | 2 |
| task | 2 |
| browser | 1 |
| fs | 1 |
| lifecycle | 1 |
| network | 1 |
| status | 1 |

| **合计** | **474** |

## i18n en/zh-CN 对齐

| namespace | en keys | zh keys | 缺 zh | 缺 en |
|---|---|---|---|---|
| alwaysOn | 156 | 156 | 0 | 0 |
| auth | 23 | 23 | 0 | 0 |
| chat | 354 | 354 | 0 | 0 |
| codeEditor | 143 | 143 | 0 | 0 |
| common | 429 | 429 | 0 | 0 |
| kanban | 44 | 44 | 0 | 0 |
| routing | 64 | 64 | 0 | 0 |
| settings | 1043 | 1043 | 0 | 0 |
| sidebar | 125 | 125 | 0 | 0 |
| stylePanel | 56 | 56 | 0 | 0 |
| tasks | 94 | 94 | 0 | 0 |
| teamPanel | 44 | 43 | 2 | 1 |


## 历史快照

