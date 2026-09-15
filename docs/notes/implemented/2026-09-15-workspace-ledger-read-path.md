# Agent Note: J-Space 账本读取路径专项（增量扫描 + 读取失败不再静默）

Status: implemented

## Problem

`#364`（TD-WORKSPACE-N02）、`#344`（TD-SESSION-N01）、TD-WORKSPACE-N01、TD-SESSION-N02
是**同一条账本读取路径**上的四重放大，本批处理前三条（第四条见「未纳入」）。

读取路径现状（处置前）：

```
modelRequest.readWorkspaceLedgerBlock()      ← 每次模型调用前
  └─ WorkspaceLedgerStore.read()
       ├─ readTranscript(path)               ← 全量派生 + 元素共享数组
       ├─ readLatestWorkspaceState(entries)  ← O(N) 扫描
       │    └─ 循环内对**每一个** workspace_state 都 cloneWorkspaceLedgerState
       │       （前面的拷贝全被丢弃，O(S×L) 深拷贝）
       └─ ?? this.latest                     ← 读不到时用陈旧内存态冒充真值
```

三条后果，严重性递增：

1. **每轮全量重扫（#344）**。账本条目随会话增长，而绝大多数轮次账本没有变化；
   这是每次模型调用前的**同步**路径，开销随会话长度线性增长。与 TD-SESSION-N02
   （每笔写入附加全量快照）叠加后是双重放大：写侧放大 transcript，读侧放大扫描。
   对应 `docs/performance-review.md` B 类「每轮全量重建」。当前被
   `SATI_WORKSPACE_LEDGER_ENABLED`（默认关）挡在路径外，但它是开关转正的拦路虎。
2. **克隆放大（TD-WORKSPACE-N01）**。`readLatestWorkspaceState` 的循环体内
   `latest = cloneWorkspaceLedgerState(entry.state)` 对每个匹配条目都深拷贝一次，
   只留最后一个。真实代价比「O(entries) 重扫」的描述重一档。
3. **静默消失（#364 / TD-WORKSPACE-N02）**。`readTranscript` 在
   `size > DEFAULT_MAX_TRANSCRIPT_READ_BYTES`（50MB）时**不抛错**，返回 `entries: []`
   加一条 `severity: "error"` 的 `transcript_too_large` 诊断；而 `read()` 只解构
   `{ entries }`、丢掉 `diagnostics`，于是：
   - **进程内不丢、跨进程丢**——`?? this.latest` 在进程内把失败掩盖成正常，新进程/新会话
     重开时账本凭空消失，模型侧只是「没有 `<workspace-state>` 块」，零告警、零诊断；
   - **陈旧态冒充真值**——长会话越过 50MB 后注入的是陈旧内存态而非 transcript 真值，
     与「账本由 transcript 重派生、抗压缩」这一模块核心契约直接背离。

第 3 条还有一条**未被登记的连带风险**：`workspace_note` 的读—改—写是
`read() ?? emptyWorkspaceLedger()` → `applyWorkspaceNote` → `write()`。当读返回陈旧态或
空态时，写回会把这份派生态**整体覆盖**成新的 `workspace_state` 快照，即
「读不到」会升级为「既有账本被丢掉」。

## Decision

### 一、增量扫描：以**条目对象身份**为失效信号的游标（#344 / TD-WORKSPACE-N01）

`WorkspaceLedgerReader` 新增 `scanLatestWorkspaceState(entries, cursor?)`，返回
`{ cursor, state }`：`cursor.scanned` 记住上轮覆盖的前缀长度，`cursor.anchor` 记住
该前缀**最后一条 entry 的对象引用**。下轮只从 `scanned` 往后扫。

关键是失效判定用对象身份而非数组长度：

```ts
if (cursor.scanned > 0 && entries[cursor.scanned - 1] !== cursor.anchor) return { start: 0, state: undefined };
```

这是成立的，因为 `readTranscript` 返回**元素共享**的数组（tail-append 快路径 `[...state.entries]`、
增量路径 `existing.push(...)` 后 `[...existing]`、回滚路径 `[...cached.entries]`），
只要没有触发全量重读，同一条 entry 的对象引用跨调用稳定；而 transcript 被替换 /
回滚 / 头部指纹不符时 reader 会走 `readFullAndCache` → `parseTranscript` 产出**全新对象**，
锚必然不匹配 → 从头重扫。长度型守卫恰恰漏掉「**等长覆盖**」（`cp -p`、同长度原地改写）
这一 reader 自己都专门设了头部指纹兜底的场景。

同一轮顺带修掉 TD-WORKSPACE-N01：循环内只记 `entry.state` 引用，克隆由调用方按需做一次。

### 二、读取失败可区分：判别式返回 + 诊断去重上行（#364 / TD-WORKSPACE-N02）

`SatiWorkspaceLedgerProvider.read()` 的返回从 `WorkspaceLedgerState | undefined`
改为判别式结果：

```ts
type WorkspaceLedgerReadResult =
  | { status: "ok"; state: WorkspaceLedgerState | undefined }
  | { status: "unavailable"; code: AgentTranscriptDiagnostic["code"]; message: string };
```

- `error` 级诊断（`transcript_too_large` / `transcript_entry_invalid` /
  `transcript_line_invalid`）→ `unavailable`，**不再回退 `this.latest`**：
  没有权威账本时，缺失比陈旧更安全，且调用方第一次有能力区分这两件事。
- 诊断按 `code + line` 去重后经 `createLogger("session")` 上报一次
  （`transcript_missing` 走 warn，其余 error）。账本每轮模型调用前都读一次，
  不去重就是每轮刷屏。
- 内存态兜底**只**保留给「URL 层面没有 transcript 路径」与「路径已声明但 transcript 里
  确实没有账本条目的会话」（如 `InMemoryTranscriptWriter` + `storage.transcriptPath`
  这种混合接线）——即兜底不再承担掩盖读取失败这一职责。

调用方随之适配：

- `modelRequest.readWorkspaceLedgerBlock`：`unavailable` 时不注入 `<workspace-state>`
  （store 已说明原因），并把该处裸 `catch` 补上 debug 级日志——它是 `src/agent/loop/`
  中少数「有注释、无输出」的吞错点。
- `toolContext.buildWorkspaceCoreDirective`：同样跳过，保持 best-effort。
- `workspace_note`：`unavailable` 时**拒绝写入**并抛 `tool_execution_failed`，
  理由写进错误文本。这是本批唯一的行为收紧，防的是「以空态为基座写回、丢掉既有账本」
  这条数据丢失路径（见 Problem 末段）。

### 三、补持久化边界的直测（TD-SESSION-N04）

新增 `tests/session/workspace/workspace-ledger-store.spec.ts`（9 条）：游标复用 / 锚失效 /
数组回退 / file-backed 往返（含克隆语义）/ 等长重写后读到新账本 / 超限 `unavailable`
且不回退陈旧态且诊断去重一次 / 未写过账本为空态而非失败 / 无路径的内存态。
`tests/tool/builtin/workspace/workspace-note.spec.ts` 的 `MemProvider` 适配新签名，
并补「不可读时拒绝写入且既有账本不变」。

## Alternatives considered

- **只加日志、不动 `read()` 签名** — 落选。日志能解释「为什么没有账本块」，但调用方
  仍分不清「没写过」与「读不到」，`workspace_note` 依然会以空态为基座写回并丢掉既有账本。
  这是本批最实质的一条风险，用日志掩盖它等于没修。
- **缓存键用 `entries.length`（长度型游标）** — 落选，且已用负控制证伪。把身份判据去掉后
  `tests/session/workspace/workspace-ledger-store.spec.ts` 立刻转红两条：
  等长重写的 e2e 用例返回 `'original'` 而非 `'replaced'`。长度型守卫在「等长覆盖」下
  静默返回陈旧账本——正是 reader 专门设头部指纹兜底的那类场景。
- **给 50MB 上限做「反向扫文件尾部找最后一条 `workspace_state`」** — 本批落选。
  这需要给 `TranscriptReader` 增加反向扫描能力，牵动它精心构造的增量状态机（半行字节 /
  头部指纹 / sequence 守卫）。而且 50MB 触顶时**整个会话的读路径都已失效**——`editLastTurn`、
  `forkSession`、`resumeAgentSession`、`readSessionMessages` 等同样拿到空 entries，
  账本只是症状之一。真正该立项的是 transcript 分片/轮转，属独立议题（见 Consequences）。
- **新造一条「会话诊断通道」（经 eventEmitter 发事件）而非用 logger** — 落选。
  `WorkspaceLedgerStore` 目前不在事件总线的接线面上，把它接上 `eventEmitter` 需要改
  `createAgentSession` 的装配顺序与依赖面，而本轮 UI 侧没有消费方（账本功能默认关），
  收益仅为「日志在界面上可见」。用现有 `createLogger` 即可满足 #364 要求的「有可见信号」，
  通道化留到账本默认开之前再评估。
- **保留 `read(): State | undefined`，另加 `readDiagnostics()`** — 落选。
  两个语义不同的读取方法比一个判别式返回值更难约束（调用方会忘记查诊断），
  且无法在类型上阻止「把 `undefined` 当空态用」。判别式让两种状态**不可混同**。
- **`workspace_note` 在不可读时降级为「按拒绝编辑回报」而不抛错** — 落选。
  `rejected` 的语义是「你的编辑不合法」（`applyWorkspaceNote` 的契约，模型据此改输入重试），
  而这里是「基座不可信、写下去会丢数据」，属工具执行失败。语义塞进 `rejected` 会让模型
  反复重试同一份数据。
- **`unavailable` 时仍注入内存态但在块内标注「可能过期」** — 落选。这会把「抗压缩账本」
  降级成「尽力而为的缓存」，且标注文本会进入 system prompt 与 `injected_context` 审计，
  污染「模型可见 = 已记录」的语义。宁可让调用方看到「本回合没有账本块 + 一条日志」。
- **把 TD-SESSION-N02（写侧每笔全量快照）一并做掉** — 落选，见下。

## Unresolved risks

- **TD-SESSION-N02 仍是 open**：`recordWorkspaceState` 每笔写入追加一份账本**全量**快照，
  transcript 单调增长，而 Reader 只取最新一条，先前快照成为死重。本批的游标缓存恰恰
  **依赖**「快照按顺序追加」这一前提（锚失效即全量重扫），所以两条必须**先设计再一起改**：
  改成只落增量会让 transcript 失去「单条即可重建」的自恢复性，且要同时定义重放语义。
  `#344` 原文已点明「缓存方案须同时考虑写侧放大」——本批明确了读取侧的正确性边界，
  写侧留待独立立项（登记于 `docs/technical-debt/backlog.md` §5 TD-SESSION-N02）。
- **`transcript_missing` 在会话首轮并入上报**：会话刚启动、transcript 尚未落盘时，
  账本读会产出一条 warn。它是**会话级一次**（去重生效）而非每轮，且确实解释了
  「为何没有账本块」，故按 #364 的口径上报；若账本默认开后噪声明显，应把
  `transcript_missing` 降为 debug 而不动其余诊断。
- **本批只覆盖「读不到 ⇒ 不写」**：`workspace_note` 拒绝写入后，模型看到的是工具错误。
  是否要在此之上补一条 `agent_status_message` 之类的用户可见提示，取决于账本默认开时
  的 UI 决策，未在本批引入。
