# Agent Note: 上游 PilotDeck v2026.09.10（PR #568）语义移植

Status: implemented

## Problem

上游是 Sati 的白标源，但以 tag 发布且 force-push，历史同步只能「重取 diff → 语义改写 → 补测试」，无法 cherry-pick。上次同步是 2026-08-19（#510/#511/#513/#497/#499），此后有 100+ 个上游 PR（#534–#568）未移植；`v2026.09.10` 的唯一内容是 PR #568（164 文件 / +5642 −1990，主题「长会话输入/渲染响应性 + 模型配置简化 + 界面一致性」），而它的 diff 基线正建立在那批未移植提交之上。**整体照搬必然引入大量 Sati 不存在的目标代码**，只能分层取舍。

去掉「Sati 已有等价物」与「依赖未同步基座」两类后，真正值得移植的是三类真实缺口：

1. **删除与写入的竞态**：项目/会话删除只做 `fs.rm`，而 gateway 里可能还有跑着的 turn 和转录写入队列——迟到的标题生成/写队列会把已删文件写回来，或让已删会话复活。
2. **回合收尾被后台任务阻塞**：会话标题生成挂在 turn 结束路径上，标题请求慢就会拖住 `turn_completed` 事件与转录收尾。
3. **长会话的 UI 响应性**：打字机每帧重解析整篇 Markdown、拖拽宽度每次 `mousemove` 都落盘并触发渲染、渲染失败时无任何现场可查。

## Decision

四次语义提交（`fix(gateway)` / `fix(agent)` / `feat(gateway)` / `fix(ui)`），外加一段 changelog 与本节。

**P0 后端会话/项目生命周期**

- `AgentTranscriptWriter.close?()`（可选）：停止接受写入并等待在途 append；`JsonlTranscriptWriter` 加 `closed` 标志，在 `recordEntry` 入口与写链内部双检（**按 Sati 自己的 `flushPending`/`appendRecordsSingleWrite` 写链插入，未照抄 hunk**）。
- `TurnRunner`：删 `flushReadySessionTitle`，`finalizeSessionMetadata` 改为 `pending?.cleanup()` + `reappendTail(turnId)`——标题不再阻塞回合收尾；标题完成的 `.then` 内加 `disposed || aborted` 守卫，`maybeGenerateSessionTitle` 首行 `disposed` 短路；新增 `disposed` 字段与 `dispose()`。`FileArtifactCollector.start()` 从 `input_accepted` 之前移到之后；`turn_completed` 的 yield 移到 `recordTurnResult` + `finalizeSessionMetadata` 之后。
- `AgentSession.dispose()`：running 则 `abort("session_closed")`，再 `await turnRunner.dispose?.()`。
- `SessionRouter`：新增 `closingSessions`/`closingProjects`/`projectGenerations`/`pausedProjects`/`creatingSessions` 五个状态；`getOrCreate` 加 `assertProjectOpen` + 代数校验（创建/重建期间项目被关 → `dispose()` 并抛 `Project was closed while …`）；新增 `closeProject`/`resumeProject`；`emitSessionEvict` 由 `void` 改为 `Promise<void>` 并**先 `dispose()` 再回调驱逐钩子**；`close()` 改为等待既有排空 promise（不再抢跑）。
- 协议 MINOR **1.8**：新增可选方法 `close_project_sessions`（`Gateway.closeProjectSessions?`）。服务端未实现时**显式抛错**而非 `not_configured` 降级——删除方必须确知会话已排空，否则会在活跃写入器之下删文件。
- `ui/server`：`deleteProject` 先 `closeProjectSessions({projectKey})`、`finally` 里 `resume: true` 解冻（删除失败不能把项目永久暂停）；`deleteSession` 先 `closeSession` 并清理 `pending-inputs/<id>.json`；`sati-bridge.js` 加删除窗口（`beginProjectDeletion`/`beginSessionDeletion`）——窗口内拒绝新建状态与提交，且 gateway 连接就绪后**复检**一次（连接期间可能刚进入删除窗口）；`routes/messages.js` 读取失败改显式 500 `session_messages_read_failed`，不再用空历史掩盖故障。

**P2 UI（全部为新增文件 + 少量接线）**

- `chatFormatting.ts` 删除 `decodeHtmlEntities`/`normalizeInlineCodeFences`/`unescapeWithMathProtection`，`useChatMessages.ts` 4 处调用点改直接透传，`Markdown.tsx` 去掉围栏规范化——保 LaTeX/代码/路径不被反转义破坏。
- `utils/frameBatcher.ts`（新）+ `SidebarV2.tsx` 拖拽宽度按帧合并、松手用合并器记录的最新值落盘（不再回读 DOM），并补卸载时的监听器清理。
- `lib/uiDiagnostics.ts`（新，环形 20 条）+ `ErrorBoundary` 记 `react-boundary` 与「重新加载界面」按钮；`reloadUi()` 先派发 `sati:flush-drafts` 再 reload。
- `utils/clipboard.ts` 加 `copyHtmlToClipboard`（`ClipboardItem` 双 MIME，不可用时退回纯文本）+ `MarkdownCopyBlocks.tsx`（新，代码块/表格级 hover 复制，表格 TSV 转义、去重 KaTeX）+ `Markdown.tsx` 注册 `pre`/`table`。
- `useTypewriter`：>4000 字符时最多 50ms 发布一次（追平帧必刷）；`useChatComposerState` 补 `pagehide`/`visibilitychange`/`sati:flush-drafts` 三个 flush 触发点（`reloadUi` 的草稿保留依赖最后一个）。
- `MessagesPaneV2`：新增空视口检测（800ms 后判定，排除隐藏标签页/空会话/assistant 运行中）→ 记 `chat-empty-viewport` 诊断并显示告警条；虚拟化门槛从 `>60 条` 扩为 `>60 条 或 (>40 条且估算总高 >20000)`。

**P3 桌面端**：`rendererRecovery.ts`（新，52 行）——`render-process-gone`（排除 `clean-exit`）与 `unresponsive` → 中英 `showMessageBox`（默认不重载）→ `webContents.reload()`。

## Alternatives considered

- **整体照搬 PR #568** — 落选：164 文件里 Sati 不存在的目标代码占大半（`SendingMessages`/`QueuedMessagesTray`/`ThinkingBlock`/`ModelSettingsModal`/`useChatModelSelection`/`globalModelSelection`/`queuedInput`/`appearance.ts` 等），全部来自未移植的 #550/#552/#562。照搬会产生无法编译的引用。
- **本机复制一份「上游基线」再对比** — 落选：force-push 后本地没有可信基线，拿到的是 rebase 后新 commit；`gh api pulls/568/files` 的逐文件 `.patch` 才是唯一权威来源。
- **P0-5 项目注册只读化（`listRegisteredWebProjects` + `createRegisteredWebProjectResolver`）** — 落选：实测 Sati 无消费者。上游接的是 dialog registry，Sati 没有 `src/gateway/dialog/projectRegistry.ts`；Sati 唯一的等价注入点 `src/adapters/web/httpRouter.ts` 的 `resolveProject` 是**从未被注入的死扩展点**且语义相反（返回路径 vs 校验）。只改 `listProjects` 是半个改动，不改。
- **CodeMirror 去重改走上游的 Vite `dedupe` + `optimizeDeps.include`** — 落选：Sati 已用 `pnpm.overrides` 钉单版本（#278）解决了同一问题，两套机制叠加会互相掩盖，取舍一即可。
- **P2-4 `useModelMenuLayout`（模型菜单视口内收）** — 落选：实测 Sati 没有对应目标——`isModelMenuOpen`/`modelCatalog` 在 `ui/src` 零命中，`ComposerV2.tsx` 无模型菜单，模型切换只在 settings 的 `ModelsSection.tsx`。计划里「接 ComposerV2 现有菜单」的前提是错的。
- **ErrorBoundary 照抄上游的 `error: Error` 签名** — 落选：react-error-boundary v6 在 Sati 把错误类型定义为 `unknown`，上游签名过不了类型检查；改为 `error instanceof Error ? error.name : "Error"`。
- **照抄上游的 `!m-0`/`!my-0`** — 落选：Sati 是 Tailwind 4.3.3，前缀 important 已废弃，改后缀形式 `m-0!`/`my-0!`。
- **桌面端 `applicationMenu.ts` 与 `appearance.ts` 一并移植** — 落选：Sati 已有应用菜单（自带中文与 `role: "reload"`），`appearance.ts` 依赖 Sati 不存在的 `appearance.json` + `pilotdeck:set-appearance` IPC 整条链。只取 `rendererRecovery.ts`，`isChinese` 由 main.ts 用 `app.getLocale()` 注入。
- **桌面端也拦 Ctrl/Cmd+R** — 落选：Sati 应用菜单已用 `role: "reload"` 绑定同一加速键，再拦一次会让一次按键触发两次重载；只保留 F5（Electron 不像浏览器那样默认绑功能键）。

## Consequences

- 换来：删除项目/会话不再被迟到写入复活；标题生成不再拖住回合收尾且有 `dispose()` 兜底；长会话打字机与侧栏拖拽的每帧布局压力下降；渲染异常有环形缓冲可查且给出重载入口；桌面端进程崩溃/卡死有恢复对话框。
- 付出与已知限制：
  - **`close_project_sessions` 是可选方法**：旧客户端不调用它时行为与从前一致（仍有竞态），这是有意的 feature-detect 而非遗漏。
  - **桌面端语言跟随系统 locale**：应用内切换 UI 语言不会同步到崩溃对话框（Sati 桌面壳没有独立的 appearance 配置，跟随上游需要连 `appearance.ts` 一起移植）。
  - **KaTeX 表格去重测试未移植**：Sati 的 `Markdown.tsx` 按需动态 `import()` math 插件，上游那条同步断言在 Sati 无法成立；`Markdown.copy.test.tsx` 收 7/8 条。
  - **`unescapeWithMathProtection` 是继承自 EdgeClaw 基线（2026-05-09）的遗留代码**，非 Sati 自研修复（`git blame` 已核实），删除与上游一致；代价是模型输出里字面量 `\n` 不再被转成换行，交由 Markdown 处理。
  - **虚拟化门槛放宽**：40–60 条的超长消息会话现在也会虚拟化，文本选择范围受窗口限制——这是上游的取舍，20000px 阈值用于把「普通小会话」排除在外。
  - 事件面**无新增事件类型**：`docs/event-producer-consumer.md` 的改动是纯行号偏移（TurnRunner 行号变化），已随分支重新生成。
  - 环境事实（非本次引入）：`tests/team/team-tools-integration.spec.ts` 在本机会因本地安装的 stdio MCP server 挂住子进程，跑后端测试需 `--test-force-exit`。
