# Sati 技术债务指标基线与趋势

> 由 `node scripts/measure-techdebt.mjs --update` 自动生成，谨防手工编辑。
> 最近一次快照：**2026-09-11**

## 规模

| 维度 | 值 |
|---|---|
| src TS 文件 / 行数 | 1033 / 185487 |
| src JS 文件 | 0 |
| tests 文件 | 524 |
| ui/src 文件 / 行数 | 465 / 82807 |
| ui/server 文件 / 行数 | 103 / 31071 |

## 指标口径

| 指标 | 作用域 |
|---|---|
| console | src + ui/server（.ts/.tsx/.js/.jsx/.mjs/.cjs；豁免两处 C39 收束入口 ui/server/utils/consoleLogger.js 与 ui/src/utils/logging.ts） |
| unsafe | src + ui/src（.ts/.tsx，含同址 *.spec.*；TS AST 精确统计 AnyKeyword + @ts-* 指令） |
| catch | src + ui/src 产品代码（排除 *.spec.* / *.test.*） |
| todos | src + ui/src + ui/server + tests（.ts/.tsx/.js/.jsx/.mjs/.cjs） |

## 异味指标（越少越好）

| 指标 | 总量 | 热点模块 |
|---|---|---|
| `any`/`@ts-expect-error`/`@ts-ignore` | 3 | ui/src(3) |
| 裸 `console.*` | 158 | cli(137) · telemetry(8) · ui/server(5) |
| 空 `catch {}` | 0 | — |
| 无参 `catch {`（总计） | 518 | ui/src(115) · adapters(70) · patent(44) |
| ↳ **无注释**（隐患类，目标） | **37** | — |
| ↳ 已带意图注释 | 481 | — |
| `TODO/HACK/FIXME/XXX` | 11 | always-on(4) · tests(4) · ui/src(2) |
| 分层违规 `ui/server→src` | 14 | — |
| 分层违规 `src→ui` | 0 | — |
| edgeclaw `lib` 编译产物直连 | 1 | — |
| 知识卡逐字节重复（组 / 冗余文件 / 冗余字节） | 72 组 · 92 文件 · 546268 B | — |

## God function（单函数 ≥ 300 行）

| 文件 | 函数 | 行 | 类型 |
|---|---|---|---|
| `ui/src/components/chat/hooks/useChatComposerState.ts` | `useChatComposerState` | 1608 | function |
| `ui/src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx` | `PdfDocumentPreview` | 1130 | function |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx` | `MessagesPaneV2` | 1031 | function |
| `ui/src/components/app-shell/SidebarV2.tsx` | `SidebarV2` | 1008 | function |
| `ui/src/components/chat/hooks/useChatSessionState.ts` | `useChatSessionState` | 934 | function |
| `src/router/RouterRuntime.ts` | `createRouterRuntime` | 885 | function |
| `ui/src/components/main-content-v2/FilesV2.tsx` | `FilesV2` | 853 | function |
| `ui/src/components/main-content-v2/SkillsV2.tsx` | `ImportFromFolder` | 852 | function |
| `ui/src/components/chat-v2/MessagesPaneV2.render.test.tsx` | `(anonymous)` | 842 | arrow |
| `ui/src/components/chat/view/subcomponents/MessageComponent.tsx` | `(anonymous)` | 798 | arrow |
| `ui/src/components/chat-v2/ComposerV2.tsx` | `ComposerV2` | 780 | function |
| `ui/src/stores/useSessionStore.ts` | `useSessionStore` | 727 | function |
| `ui/src/components/git-panel/hooks/useGitPanelController.ts` | `useGitPanelController` | 704 | function |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | `useChatRealtimeHandlers` | 697 | function |
| `ui/src/components/chat-v2/ChatInterfaceV2.tsx` | `ChatInterfaceV2` | 672 | function |
| `ui/src/hooks/useProjectsState.ts` | `useProjectsState` | 647 | function |
| `src/adapters/channel/tui/app/TuiApp.tsx` | `TuiApp` | 643 | function |
| `src/cli/sati.ts` | `main` | 636 | function |
| `ui/src/components/app-shell/AppShellV2.tsx` | `AppShellV2` | 630 | function |
| `ui/src/components/onboarding/view/subcomponents/LlmConfigurationStep.tsx` | `LlmConfigurationStep` | 630 | function |
| `src/cli/createLocalGateway.ts` | `createLocalGateway` | 607 | function |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | `(anonymous)` | 600 | arrow |
| `ui/src/components/main-content/view/MainContent.tsx` | `SplitBody` | 573 | function |
| `src/context/memory/edgeclaw-memory-core/src/core/review/dream-review.ts` | `run` | 524 | method |
| `src/cli/createLocalGateway.ts` | `prepareSessionRuntime` | 517 | method |
| `src/tool/builtin/readFile.ts` | `createReadFileTool` | 509 | function |
| `src/context/memory/edgeclaw-memory-core/src/core/retrieval/reasoning-loop.ts` | `retrieve` | 484 | method |
| `src/context/memory/edgeclaw-memory-core/src/core/pipeline/heartbeat.ts` | `runHeartbeat` | 477 | method |
| `ui/src/components/main-content-v2/CronV2.tsx` | `CronFormView` | 476 | function |
| `ui/src/components/settings/view/modelPool/components/ProviderCard.tsx` | `ProviderCard` | 447 | function |
| `ui/src/components/chat-v2/MessageRowV2.tsx` | `MessageRowV2` | 429 | function |
| `ui/src/components/code-editor/view/subcomponents/DocxBuiltinPreview.tsx` | `DocxBuiltinPreview` | 421 | function |
| `src/gateway/client/eventMapping.ts` | `mapAgentEventForTurn` | 416 | function |
| `src/always-on/runtime/DiscoveryFire.ts` | `run` | 414 | method |
| `src/router/RouterRuntime.ts` | `execute` | 411 | function |
| `ui/src/components/chat-v2/processGrouping.test.ts` | `(anonymous)` | 409 | arrow |
| `ui/src/components/code-editor/view/subcomponents/SpreadsheetInteractivePreview.tsx` | `SpreadsheetInteractivePreview` | 407 | function |
| `ui/src/components/settings/view/integrations/im/components/WeComChannelSection.tsx` | `WeComChannelSection` | 398 | function |
| `ui/src/components/chat/hooks/useSlashCommands.ts` | `useSlashCommands` | 395 | function |
| `ui/src/components/main-content-v2/CronV2.test.tsx` | `(anonymous)` | 384 | arrow |
| `src/web/client/webMessage.ts` | `applyWebGatewayEvent` | 383 | function |
| `src/tool/execution/ToolRuntime.ts` | `execute` | 382 | method |
| `src/tool/builtin/readFile.ts` | `(anonymous)` | 381 | arrow |
| `ui/src/components/app-shell/MainAreaV2.tsx` | `MainAreaV2Content` | 381 | function |
| `ui/src/components/settings/view/integrations/im/components/FeishuChannelSection.tsx` | `FeishuChannelSection` | 381 | function |
| `ui/src/components/chat/tools/components/InteractiveRenderers/AskUserQuestionPanel.tsx` | `AskUserQuestionPanel` | 378 | arrow |
| `ui/src/components/kanban/hooks/useBoardState.ts` | `useBoardState` | 368 | function |
| `ui/src/components/chat/hooks/useFileMentions.tsx` | `useFileMentions` | 366 | function |
| `src/agent/loop/AgentLoop.ts` | `handleModelError` | 364 | method |
| `ui/src/components/settings/view/agentRoute/components/RouterSection.tsx` | `RouterSection` | 355 | function |
| `ui/src/components/main-content/view/MainContent.tsx` | `MainContent` | 346 | function |
| `src/gateway/server/GatewayWsConnection.ts` | `dispatchRequest` | 343 | method |
| `src/tool/builtin/patentPdfDownload.ts` | `createPatentPdfDownloadTool` | 343 | function |
| `src/patent/graph/domains/inventiveness.ts` | `buildInventivenessGraph` | 342 | function |
| `ui/src/components/main-content-v2/PlansAndCronJobs.tsx` | `PlansAndCronJobs` | 334 | function |
| `src/gateway/client/telemetry.ts` | `emitSessionTelemetry` | 333 | function |
| `ui/src/components/main-content-v2/DashboardV2.tsx` | `DashboardV2` | 332 | function |
| `ui/src/hooks/useSatiConfig.ts` | `useSatiConfigState` | 332 | function |
| `ui/src/components/settings/view/agentSearch/components/ToolsSection.tsx` | `ToolsSection` | 328 | function |
| `ui/src/components/code-editor/view/CodeEditor.tsx` | `CodeEditor` | 310 | function |
| `ui/src/components/chat-v2/SubagentDetailMessageFlow.tsx` | `SubagentDetailMessageFlow` | 309 | function |
| `ui/src/components/settings/view/integrations/im/components/WeixinChannelSection.tsx` | `WeixinChannelSection` | 303 | function |

## Top 30 大文件

| 文件 | 行 |
|---|---|
| `src/cli/createLocalGateway.ts` | 2696 |
| `ui/src/components/main-content-v2/SkillsV2.tsx` | 2525 |
| `src/agent/loop/AgentLoop.ts` | 2430 |
| `ui/server/sati-bridge.js` | 2228 |
| `ui/src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx` | 1885 |
| `ui/server/routes/taskmaster.js` | 1850 |
| `ui/src/components/chat/hooks/useChatComposerState.ts` | 1837 |
| `src/adapters/channel/wecom/WeComChannel.ts` | 1764 |
| `src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts` | 1711 |
| `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts` | 1624 |
| `src/model/catalog/providers.ts` | 1593 |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx` | 1544 |
| `ui/src/components/code-editor/view/subcomponents/CodeEditorBinaryFile.tsx` | 1511 |
| `src/adapters/channel/weixin/WeixinChannel.ts` | 1497 |
| `ui/server/routes/git.js` | 1491 |
| `src/gateway/client/InProcessGateway.ts` | 1421 |
| `ui/src/stores/useSessionStore.ts` | 1404 |
| `ui/src/components/main-content-v2/DashboardV2.tsx` | 1345 |
| `src/adapters/channel/feishu/FeishuChannel.ts` | 1337 |
| `ui/src/components/app-shell/SidebarV2.tsx` | 1310 |
| `ui/src/components/chat-v2/processGrouping.ts` | 1294 |
| `src/always-on/runtime/DiscoveryFire.ts` | 1256 |
| `src/router/RouterRuntime.ts` | 1230 |
| `ui/src/components/chat/hooks/useChatSessionState.ts` | 1171 |
| `ui/server/routes/commands.js` | 1149 |
| `src/context/memory/edgeclaw-memory-core/src/core/file-memory.ts` | 1139 |
| `ui/server/routes/agent.js` | 1133 |
| `ui/src/components/main-content-v2/CronV2.tsx` | 1130 |
| `ui/src/components/main-content/view/MainContent.tsx` | 1111 |
| `ui/src/components/chat-v2/ComposerV2.tsx` | 1109 |

## 测试覆盖（tests/<模块> 文件数）

| 模块 | 测试文件 |
|---|---|
| patent | 111 |
| tool | 60 |
| agent | 49 |
| knowledge | 42 |
| gateway | 29 |
| context | 28 |
| model | 27 |
| session | 25 |
| router | 14 |
| always-on | 13 |
| mcp | 13 |
| cron | 11 |
| extension | 10 |
| rule | 9 |
| literature | 8 |
| pilot | 8 |
| web | 8 |
| cli | 7 |
| adapters | 5 |
| permission | 4 |
| test-support | 4 |
| workflow | 4 |
| methodology | 3 |
| telemetry | 3 |
| board | 2 |
| shared | 2 |
| task | 2 |
| browser | 1 |
| fs | 1 |
| lifecycle | 1 |
| network | 1 |
| runtime | 1 |
| status | 1 |

| **合计** | **507** |

## i18n en/zh-CN 对齐

| namespace | en keys | zh keys | 缺 zh | 缺 en |
|---|---|---|---|---|
| alwaysOn | 156 | 156 | 0 | 0 |
| auth | 23 | 23 | 0 | 0 |
| chat | 367 | 367 | 0 | 0 |
| codeEditor | 143 | 143 | 0 | 0 |
| common | 435 | 435 | 0 | 0 |
| kanban | 44 | 44 | 0 | 0 |
| routing | 64 | 64 | 0 | 0 |
| settings | 1044 | 1044 | 0 | 0 |
| sidebar | 125 | 125 | 0 | 0 |
| stylePanel | 56 | 56 | 0 | 0 |
| tasks | 94 | 94 | 0 | 0 |
| teamPanel | 44 | 43 | 1 | 0 |


## 历史快照

