# Sati 技术债务指标基线与趋势

> 由 `node scripts/measure-techdebt.mjs --update` 自动生成，谨防手工编辑。
> 最近一次快照：**2026-09-21**

## 规模

| 维度 | 值 |
|---|---|
| src TS 文件 / 行数 | 1043 / 175367 |
| src JS 文件 | 0 |
| tests 文件 | 579 |
| ui/src 文件 / 行数 | 571 / 92364 |
| ui/server 文件 / 行数 | 108 / 31827 |

## 指标口径

| 指标 | 作用域 |
|---|---|
| console | src + ui/server（.ts/.tsx/.js/.jsx/.mjs/.cjs；豁免两处 C39 收束入口 ui/server/utils/consoleLogger.js 与 ui/src/utils/logging.ts） |
| unsafe | src + ui/src（.ts/.tsx，含同址 *.spec.*；TS AST 精确统计 AnyKeyword + @ts-* 指令） |
| asUnknownAs | src + ui/src（.ts/.tsx，含同址 *.spec.*；TS AST 统计 `x as unknown as T` 双重断言）。**口径变更**：2026-09-15（issue #339）首度纳入——此前该形态完全未统计，故 0 → N 的变化来自口径变更而非新增债务 |
| catch | src + ui/src + ui/server 产品代码（排除 *.spec.* / *.test.*）。**口径变更**：2026-09-16（issue #341）纳入 ui/server——此前仅 src + ui/src，于是「空 catch {}」报 0 而 ui/server 实有 1 处，且同为「错误 & 可观测」类的 console/todos 早已含 ui/server，口径自相矛盾 |
| todos | src + ui/src + ui/server + tests（.ts/.tsx/.js/.jsx/.mjs/.cjs） |
| vendored | src/context/memory/edgeclaw-memory-core（**整体移出文件级指标**，2026-09-16 issue #341）：外部搬入的记忆内核，自带 package.json / tsconfig 与独立 build·test，不随本仓演进。其 src 与 tests 下的 .ts 此前计入 src 规模与两张排期表，现单列于 metrics.md「vendored 子包」节；该子包自己的 lib/（编译产物）与 ui-source/（memory-dashboard 资产）本就由目录名豁免 |

## 异味指标（越少越好）

| 指标 | 总量 | 热点模块 |
|---|---|---|
| `any`/`@ts-expect-error`/`@ts-ignore` | 3 | ui/src(3) |
| `as unknown as`（双重断言） | 31 | ui/src(24) · adapters(2) · tool(2) |
| 裸 `console.*` | 158 | cli(137) · telemetry(8) · ui/server(5) |
| 空 `catch {}` | 0 | — |
| 无参 `catch {`（总计） | 667 | ui/server(152) · ui/src(114) · adapters(70) |
| ↳ **无注释**（隐患类，目标） | **8** | — |
| ↳ 已带意图注释 | 659 | — |
| `TODO/HACK/FIXME/XXX` | 11 | always-on(4) · tests(4) · ui/src(2) |
| 分层违规 `ui/server→src` | 14 | — |
| 分层违规 `src→ui` | 0 | — |
| edgeclaw `lib` 编译产物直连 | 1 | — |
| 知识卡逐字节重复（组 / 冗余文件 / 冗余字节） | 70 组 · 90 文件 · 527689 B | — |

## God function（单函数 ≥ 300 行）

| 文件 | 函数 | 行 | 类型 |
|---|---|---|---|
| `ui/src/components/app-shell/SidebarV2.tsx` | `SidebarV2` | 1008 | function |
| `ui/src/components/chat-v2/MessagesPaneV2.render.test.tsx` | `(anonymous)` | 943 | arrow |
| `ui/src/components/main-content-v2/FilesV2.tsx` | `FilesV2` | 853 | function |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx` | `MessagesPaneV2` | 824 | function |
| `ui/src/components/chat-v2/ComposerV2.tsx` | `ComposerV2` | 741 | function |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | `useChatRealtimeHandlers` | 719 | function |
| `ui/src/components/git-panel/hooks/useGitPanelController.ts` | `useGitPanelController` | 704 | function |
| `ui/src/components/main-content-v2/skills/import/ImportFromFolder.tsx` | `ImportFromFolder` | 688 | function |
| `ui/src/components/chat-v2/ChatInterfaceV2.tsx` | `ChatInterfaceV2` | 668 | function |
| `ui/src/hooks/useProjectsState.ts` | `useProjectsState` | 647 | function |
| `src/adapters/channel/tui/app/TuiApp.tsx` | `TuiApp` | 643 | function |
| `src/cli/sati.ts` | `main` | 636 | function |
| `ui/src/stores/useSessionStore.ts` | `createSessionActions` | 631 | function |
| `ui/src/components/app-shell/AppShellV2.tsx` | `AppShellV2` | 630 | function |
| `ui/src/components/onboarding/view/subcomponents/LlmConfigurationStep.tsx` | `LlmConfigurationStep` | 630 | function |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | `(anonymous)` | 622 | arrow |
| `ui/src/components/main-content/view/MainContent.tsx` | `SplitBody` | 573 | function |
| `ui/src/components/chat/hooks/useSessionSubmit.ts` | `useSessionSubmit` | 528 | function |
| `ui/src/components/main-content-v2/CronV2.tsx` | `CronFormView` | 476 | function |
| `ui/src/components/chat/hooks/useChatComposerState.ts` | `useChatComposerState` | 467 | function |
| `src/router/execution/executeRouterDecision.ts` | `executeRouterDecision` | 449 | function |
| `ui/src/components/settings/view/modelPool/components/ProviderCard.tsx` | `ProviderCard` | 447 | function |
| `ui/src/components/chat-v2/MessageRowV2.tsx` | `MessageRowV2` | 429 | function |
| `ui/src/components/code-editor/view/subcomponents/DocxBuiltinPreview.tsx` | `DocxBuiltinPreview` | 421 | function |
| `src/gateway/client/eventMapping.ts` | `mapAgentEventForTurn` | 417 | function |
| `src/cli/projectRuntimeFactory.ts` | `createProjectRuntimeResolver` | 411 | function |
| `ui/src/components/chat-v2/processGrouping.test.ts` | `(anonymous)` | 409 | arrow |
| `ui/src/components/code-editor/view/subcomponents/SpreadsheetInteractivePreview.tsx` | `SpreadsheetInteractivePreview` | 407 | function |
| `ui/src/components/settings/view/integrations/im/components/WeComChannelSection.tsx` | `WeComChannelSection` | 398 | function |
| `ui/src/components/chat/hooks/useSlashCommands.ts` | `useSlashCommands` | 395 | function |
| `src/tool/execution/ToolRuntime.ts` | `execute` | 388 | method |
| `ui/src/components/main-content-v2/CronV2.test.tsx` | `(anonymous)` | 384 | arrow |
| `src/web/client/webMessage.ts` | `applyWebGatewayEvent` | 383 | function |
| `ui/src/components/app-shell/MainAreaV2.tsx` | `MainAreaV2Content` | 381 | function |
| `ui/src/components/settings/view/integrations/im/components/FeishuChannelSection.tsx` | `FeishuChannelSection` | 381 | function |
| `ui/src/components/chat/tools/components/InteractiveRenderers/AskUserQuestionPanel.tsx` | `AskUserQuestionPanel` | 378 | arrow |
| `ui/src/components/settings/view/agentSearch/components/ToolsSection.tsx` | `ToolsSection` | 378 | function |
| `ui/src/components/kanban/hooks/useBoardState.ts` | `useBoardState` | 368 | function |
| `ui/src/components/chat/hooks/useFileMentions.tsx` | `useFileMentions` | 366 | function |
| `ui/src/components/settings/view/agentRoute/components/RouterSection.tsx` | `RouterSection` | 357 | function |
| `ui/src/stores/useSessionStore.actions.test.tsx` | `(anonymous)` | 354 | arrow |
| `src/tool/builtin/patentFigureProject.ts` | `createPatentFigureProjectTool` | 353 | function |
| `ui/src/components/main-content/view/MainContent.tsx` | `MainContent` | 346 | function |
| `src/gateway/server/GatewayWsConnection.ts` | `dispatchRequest` | 343 | method |
| `src/patent/graph/domains/inventiveness.ts` | `buildInventivenessGraph` | 342 | function |
| `ui/src/components/chat/view/subcomponents/MessageComponent.tsx` | `(anonymous)` | 335 | arrow |
| `ui/src/components/main-content-v2/PlansAndCronJobs.tsx` | `PlansAndCronJobs` | 334 | function |
| `src/gateway/client/telemetry.ts` | `emitSessionTelemetry` | 333 | function |
| `ui/src/components/main-content-v2/DashboardV2.tsx` | `DashboardV2` | 332 | function |
| `ui/src/hooks/useSatiConfig.ts` | `useSatiConfigState` | 332 | function |
| `ui/src/components/chat/hooks/useSlashCommandExecute.ts` | `useSlashCommandExecute` | 331 | function |
| `ui/src/components/code-editor/view/CodeEditor.tsx` | `CodeEditor` | 310 | function |
| `ui/src/components/chat-v2/SubagentDetailMessageFlow.tsx` | `SubagentDetailMessageFlow` | 309 | function |
| `src/patent/figuregen/check.ts` | `checkFigures` | 306 | function |
| `src/cli/projectRuntimeFactory.ts` | `resolve` | 303 | function |
| `ui/src/components/settings/view/integrations/im/components/WeixinChannelSection.tsx` | `WeixinChannelSection` | 303 | function |
| `src/gateway/client/InProcessGateway.ts` | `submitTurn` | 300 | method |

## Top 30 大文件

| 文件 | 行 |
|---|---|
| `ui/server/sati-bridge.js` | 2347 |
| `src/adapters/channel/wecom/WeComChannel.ts` | 1764 |
| `src/model/catalog/providers.ts` | 1593 |
| `ui/server/routes/git.js` | 1529 |
| `src/adapters/channel/weixin/WeixinChannel.ts` | 1497 |
| `src/gateway/client/InProcessGateway.ts` | 1489 |
| `ui/src/components/main-content-v2/SkillsV2.tsx` | 1441 |
| `ui/src/stores/useSessionStore.ts` | 1347 |
| `ui/src/components/main-content-v2/DashboardV2.tsx` | 1345 |
| `src/adapters/channel/feishu/FeishuChannel.ts` | 1337 |
| `ui/src/components/app-shell/SidebarV2.tsx` | 1310 |
| `ui/src/components/chat-v2/processGrouping.ts` | 1294 |
| `ui/src/components/chat-v2/MessagesPaneV2.render.test.tsx` | 1234 |
| `ui/server/routes/agent.js` | 1224 |
| `ui/src/components/chat-v2/ComposerV2.tsx` | 1188 |
| `ui/src/components/chat-v2/MessagesPaneV2.tsx` | 1183 |
| `ui/server/routes/taskmaster.js` | 1179 |
| `ui/server/routes/config.js` | 1173 |
| `src/agent/loop/AgentLoop.ts` | 1146 |
| `ui/src/components/main-content-v2/CronV2.tsx` | 1130 |
| `ui/src/components/main-content/view/MainContent.tsx` | 1111 |
| `src/model/streaming/streamModel.ts` | 1085 |
| `ui/server/routes/commands.js` | 1082 |
| `src/always-on/runtime/DiscoveryFire.ts` | 1079 |
| `src/cli/sati.ts` | 1028 |
| `src/adapters/channel/protocol/ImLiveReplyController.ts` | 1017 |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | 1005 |
| `ui/src/components/main-content-v2/FilesV2.tsx` | 964 |
| `ui/server/routes/config.test.js` | 934 |
| `src/pilot/config/loadPilotConfig.ts` | 922 |

## vendored 子包（单列，不计入上述规模与排名）

> `src/context/memory/edgeclaw-memory-core` 是从外部项目整体搬入的记忆内核（自带 `package.json` / `tsconfig` / 独立 `build`·`test`），本仓不参与其演进。按 #341 从**规模 / Top 大文件 / God function** 三处整体移出，在此单列以免丢失可见度。

| 子包 | 文件 | 行 | ≥ 300 行函数 |
|---|---|---|---|
| `src/context/memory/edgeclaw-memory-core` | 49 | 16682 | 3 |

其自身 Top 5 大文件（**不参与**上方排名）：

| 文件 | 行 |
|---|---|
| `src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts` | 1711 |
| `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts` | 1624 |
| `src/context/memory/edgeclaw-memory-core/src/core/file-memory.ts` | 1139 |
| `src/context/memory/edgeclaw-memory-core/src/core/review/dream-review.ts` | 1046 |
| `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-prompts.ts` | 986 |

## 测试覆盖（tests/<模块> 文件数）

| 模块 | 测试文件 |
|---|---|
| patent | 121 |
| tool | 64 |
| agent | 57 |
| knowledge | 38 |
| context | 32 |
| gateway | 32 |
| model | 32 |
| session | 28 |
| router | 18 |
| always-on | 14 |
| mcp | 13 |
| adapters | 11 |
| cron | 11 |
| extension | 11 |
| pilot | 11 |
| rule | 10 |
| cli | 9 |
| web | 9 |
| literature | 8 |
| permission | 4 |
| test-support | 4 |
| telemetry | 3 |
| board | 2 |
| methodology | 2 |
| network | 2 |
| shared | 2 |
| task | 2 |
| browser | 1 |
| fs | 1 |
| lifecycle | 1 |
| runtime | 1 |
| status | 1 |

| **合计** | **555** |

## i18n en/zh-CN 对齐

| namespace | en keys | zh keys | 缺 zh | 缺 en |
|---|---|---|---|---|
| alwaysOn | 156 | 156 | 0 | 0 |
| auth | 23 | 23 | 0 | 0 |
| chat | 374 | 374 | 0 | 0 |
| codeEditor | 143 | 143 | 0 | 0 |
| common | 435 | 435 | 0 | 0 |
| kanban | 44 | 44 | 0 | 0 |
| routing | 64 | 64 | 0 | 0 |
| settings | 1060 | 1060 | 0 | 0 |
| sidebar | 125 | 125 | 0 | 0 |
| stylePanel | 56 | 56 | 0 | 0 |
| tasks | 94 | 94 | 0 | 0 |
| teamPanel | 44 | 43 | 1 | 0 |


## 历史快照

