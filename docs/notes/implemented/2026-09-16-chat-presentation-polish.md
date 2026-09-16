# Agent Note: 展示层小修（Bash 信封解包 / 用户气泡判据 / 清死键）

Status: implemented

## Problem

三处互不相关的展示层问题（上游 #590 / #570 切片）：

1. **shell 工具卡片显示的是包装而不是命令输出**。`src/tool/builtin/bash.ts` 结果为
   `BASH_RESULT[success][state]` + 六条 `Assertions:` + `Interpretation:` + `stdout:`
   前缀（信封里的断言是给模型的证据），而 UI 原样渲染——`ui/src` 里没有任何剥离逻辑
   （grep `Assertions|Interpretation|stdout_visible` 零命中）。
2. **同文本连发两次时第二次的乐观气泡可能被吞**：`hasEquivalentUserMessage`
   只比较「归一化文本 + 图片数 + 附件名」。
3. `working.compactingLevel` 是无引用的死键。

## Decision

**P6a**：新增 `ui/src/components/chat/tools/toolPresentation.ts`（纯展示，不改发给模型的
结果），Bash 卡片的标题与正文改走它：

- 优先用结构化数据（live 路径的 `payload`，即工具返回的 `data`；兼容上游的
  `toolUseResult.data` 形状）——它给出权威的 stdout/stderr/exitCode/durationMs；
- 否则解析**完整**信封。与上游的两处适配：退出码接受任意整数或 `null`（超时/中断；
  上游正则硬编码 `(0)`），且 Sati 在 stdout 之后还有 `stderr:` 段需一并切分；
- 两者都不命中 → 原样返回（缺行、截断的 live 预览、形似文本都绝不吞内容）。
- 标题形如 `Output (3 lines) · exit 1 · 1.3s`。

配套把工具的结构化 `data` 透传进 `toolResult.payload`（`useChatMessages`）——此前 live
路径唯一的结构化来源在派生 `toolResult` 时被丢掉，只剩被截断的 `resultPreview`。

**P6b**：`hasEquivalentUserMessage` 加身份短路——两侧都带 `turnId`/`runId` 时以它为身份
（同 turn 才是同一条消息），两侧都缺 id 时退回原内容比较。与上游 #570 的实现逐字一致。

**P6c**：删除 `working.compactingLevel`（en + zh-CN）。

## Alternatives considered

- **在后端去掉信封、直接把 stdout 作为工具结果** — 落选：信封里的 `Assertions` 是给模型
  的判据（`bash.ts` 明确要求模型读 `retrieved_data_available`），后端去掉会削弱模型侧证据。
- **移植上游 `UnifiedToolCall.tsx` 整个组件** — 落选：它依赖 Sati 没有的 i18n 命名空间与
  不同的 collapsible 契约，Sati 的 `ToolRenderer` 结构不同。
- **用户消息去重完全移除** — 落选：会重新引入「乐观气泡与已落盘消息重复」的原问题。
- **把 `TOOL_ERROR[...]` 信封也解包** — 落选（本批）：那是**所有**工具共用的错误卡片，
  不是 shell 专属；解包它要重排 `MessageComponent` 的错误渲染契约，与本批「shell 卡片
  正文」的范围无关。失败命令的真实 stderr 已经完整可见（见下面的浏览器验证）。
- **让 `hasEquivalentUserMessage` 直接比较 store 消息 id** — 落选：乐观气泡不在 store 里，
  没有 id 可比；身份只能来自提交时约定的 turn id。

## Consequences

- shell 卡片的正文是命令输出本身（实测 `pwd` → `Users/xujian/projects/MediaCrawler`），
  包装行只在磁盘/模型侧保留；失败命令的 stderr 完整可见。
- **`P6b` 的判据目前不生效**（诚实披露）：Sati 的乐观气泡不带 `runId`（上游的提交路径会
  由客户端生成 turn runId 并随帧下发，Sati 没有这条链路——`sati-bridge` 在服务端
  `randomUUID()` 生成 runId），而历史投影（`ui/server/routes/messages.js` → WebMessage）也
  不暴露用户消息的 turnId。落地判据本身是上游对齐的第一步；完整生效需要：
  ① composer 生成 turn runId 并放进提交帧 → ② `sati-bridge` 优先采用客户端 runId →
  ③ WebMessage/ChatMessage 投影带上用户消息的 turnId。三条都不做时，两侧永远没有 id，
  判据退化为原行为（不会造成额外重复）。
- **耗时只在 live 行上可见**：历史刷新后的行没有结构化数据（`routes/messages.js` 只附带
  搜索类 payload），此时标题只有退出码。要让耗时长期可见，需要把 duration 放进信封或
  历史投影——本批不做。
