# Agent Note: 工作区账本快照不再二次增长（周期锚点 + 增量重放）

Status: implemented

## Problem

`#537`（TD-SESSION-N02）：`recordWorkspaceState` 每笔写入都把**当前完整账本状态**落进 transcript，而读取侧 `scanLatestWorkspaceState` 只认最新一条——历史快照 100% 是死重。又因 `verified` 是 append-only（`WorkspaceLedger.applyWorkspaceNote` 每记一条 checkpoint 就 `verified.push`，单调编号、只增不减），「状态规模」随会话线性增长，于是**单条快照 O(n)、累计 O(n²)**：issue 实测 200 次笔记累计 3.65 MiB（第 10/50/100/200 次单条 2.0/9.4/18.5/37.1 KiB），按此斜率约 1000+ 次笔记即撞 `DEFAULT_MAX_TRANSCRIPT_READ_BYTES = 50MB`。越限后 `readTranscript` 返回 `transcript_too_large`（error 级）→ `WorkspaceLedgerStore.read()` 返回 `unavailable` → `workspace_note` **永久拒绝写入**（同一条 transcript 不会自行变小）。这是硬故障而非渐进劣化，且 transcript 是所有能力面共用的 durable 载体（续算扫描 / 全量读取 / 备份 / 搜索），账本膨胀会同时抬高它们的成本。

本条是 `docs/notes/implemented/2026-09-15-workspace-ledger-read-path.md`（PR #378）**显式留下的未决风险**——该 note 的「Unresolved risks」第一段就点名 TD-SESSION-N02 仍 open，并要求「两条必须**先设计再一起改**：改成只落增量会让 transcript 失去『单条即可重建』的自恢复性，且要同时定义重放语义」。本 note 就是那条「先设计」的落地。

### 一处对方案前提的修正（实测）

`docs/open-issues-remediation-plan.md` §3.4 的「现状」称「今天每个 `workspace_note` 必写一条，即使内容相同」。**实测已不成立**：`WorkspaceNoteTool.execute` 早已是 `if (result.changed) { write(...) }`，且 `applyWorkspaceNote` 用 `deepEqualWorkspaceLedger` 判等——内容相同的 note 返回 `changed:false`，工具**不写**（`tests/tool/builtin/workspace/workspace-note.spec.ts` 已有 `provider.writes === 0` 断言）。⇒ 方案 §3.4 修法① 的「按 change token 去重」**已交付**；本批只需补它的**文件级**护栏（无变化写入 transcript 字节不增长），真正待修的是修法② —— append-only 增长导致的、**内容确实在变**的全量快照二次累积。change-token 去重对这一面无效：每记一条 checkpoint 状态都不同，必写一条 O(n) 全量快照。

## Decision

在 PR #378 钉死的决策面内（**每条 `workspace_state` 快照自足** + **读取侧 last-one-wins** + **不动 durable 边界**），把「每笔写入落全量快照」改为「**每 K 笔一个自足全量锚点 + 其间 O(1) 增量**」：

1. **新增 log-only 增量条目 `workspace_state_delta`**（`TranscriptEntry.ts`），载荷是**一条已接受的 note**（`WorkspaceNoteInput`），不是状态差分。与 `retry_schedule` 同性质：不进模型可见消息、不驱动 turn 判定（**不**加入 `ACTIVITY_ENTRY_TYPES`）、不参与重放投影，**仅** `WorkspaceLedgerReader` 消费。

2. **读取侧重放复用既有纯状态机**：`scanLatestWorkspaceState` 遇 `workspace_state`（锚点）→ 累积器重置为该全量状态、`deltasSinceAnchor=0`；遇 `workspace_state_delta` → `applyWorkspaceNote(acc, note)` 顺序累积。**重放走的就是写时那条 `applyWorkspaceNote`**（纯函数、确定性），所以重建出的状态与写时逐字一致，无需新发明一套重放语义——这正是 #378 要求「同时定义重放语义」的最小答案：**不定义新语义，复用旧的**。无前导锚点的增量（被裁剪/损坏）**跳过**而非应用到臆造空基座（宁可缺失，不可错账本，沿用 #378「缺失比陈旧安全」）。

3. **写侧锚点节奏**（`WorkspaceLedgerStore.write`）：仅当（a）调用方交回产生该 state 的 note、（b）已存在可重放基座 `haveBase`、（c）`deltasSinceAnchor < K`、（d）writer 支持增量——四条全满足才落增量；否则落全量锚点。**首笔写入必落锚点**（无基座可重放）；`K = WORKSPACE_LEDGER_ANCHOR_INTERVAL = 32`。`deltasSinceAnchor` 由**每次 read 从 transcript 重算**（不是 store 本地计数），故节奏是 transcript 全局的、跨 resume 稳定，且**冷读最多重放 K 条增量**（读成本有界）。

4. **durable 边界一字未动**：增量条走与全量快照**完全相同**的 `recordEntry` 批写路径（pending 批写 / flushCheckpoint 语义 / ack / 串行链 / close 前已接受条目照常落盘），`recordWorkspaceStateDelta` 只是又一个 `recordEntry` 调用点。`write()` 无 note 时（旧调用面 / 内存 writer 防御路径）**退回全量锚点**，行为与改前一致。

效果：N 笔写入的全量快照数从 N 降为 `ceil(N/(K+1))`（N=100 → **4 个锚点 + 96 条增量**，实测断言）；累计字节从 O(n²) 降为 ~O(n²/K)（锚点项）+ O(n)（增量项），把 50MB 硬顶从 ~1000 笔记推到 ~4000+ 笔记。锚点 O(n) 不可消除——它是「自足快照」硬前提的直接代价（见 Alternatives）；K 是「冷读重放成本」与「锚点字节」之间的唯一旋钮，32 让重放微不足道而锚点字节降 ~32×。

## Alternatives considered

- **只落增量、不再落全量快照（incremental-only）** — **再次否决**（#378 已列为落选）。它让 transcript 失去「单条即可重建」的自恢复性：任何一次冷读都要从**文件第一条**重放全部增量，且一旦头部某条增量损坏/被裁剪，其后全部不可重建。本方案保留周期全量锚点，正是为了把「重放起点」始终钉在最近的自足锚点上，冷读成本与损坏爆炸半径都被 K 界住。方案 §2.3 第 1 条与 §3.4 都明文「**不得**改成只落增量」。

- **给 50MB 上限做「反向扫文件尾部找最后一条 `workspace_state`」** — **再次否决**（#378 已列为落选）。它需要给 `TranscriptReader` 增加反向扫描能力，牵动其精心构造的增量状态机（半行字节 / 头部指纹 / sequence 守卫）；且 50MB 触顶时**整个会话读路径都已失效**（`editLastTurn`/`forkSession`/`resumeAgentSession`/`readSessionMessages` 同样拿到空 entries），账本只是症状之一。真正该立项的是 transcript 分片/轮转（独立议题）。本方案从**写侧**根除膨胀，让账本根本不会把 transcript 顶到 50MB，比在读侧给一个已坏掉的上限打补丁更对症。

- **锚点之间写「状态差分」而非「note」** — 落选。状态差分（哪条 verified 新增、next 改成什么）需要新定义一套 diff/patch 语义并处理 `core` 槽位交换、`open` 关闭回填 `closesOpen` 等编号不变量，等于把 `applyWorkspaceNote` 的复杂逻辑复制一份到读侧、且两边要保持同步——正是 #378 警告的「要同时定义重放语义」的高风险形态。改用 note 作增量载荷后，重放 = 调用同一个 `applyWorkspaceNote`，零新语义、天然与写侧一致。

- **截断 `verified` 历史以压快照体积** — 落选。`verified` 的单调编号是 `nextVerifiedNumber` / `nextOpenNumber`（扫 `closesOpen` 防编号复用）的分配依据，也是账本「append-only 编号 checkpoint」核心不变量；截断会破坏编号唯一性与「已验证」审计语义。渲染侧本就只显示最近一条 + 计数（`renderWorkspaceLedgerBlock`），但**状态**必须留全量。

- **抬高 50MB 上限** — 落选。O(n²) 不变，只是把硬故障推迟；且 transcript 是共用载体，抬上限会同时放大续算/备份/搜索成本。治标不治本。

- **只在 turn 边界（flushCheckpoint）落锚点、turn 内合并** — 落选。它对「每 turn 一条 checkpoint」这一最常见模式零改善（每 turn 仍落一条 O(n) 全量快照，累计仍 O(n²)）；只有「一 turn 多 note」才被合并。无法根治。

## Consequences

- **正向**：账本默认开（`SATI_WORKSPACE_LEDGER_ENABLED=1`，当前默认关）后的长会话不再撞 50MB 硬顶；transcript 膨胀及其对续算/备份/搜索的连带抬升被 ~32× 压制；change-token 去重（已有）+ 周期锚点（本批）两面合起来覆盖「重复写」与「增长写」。
- **读取侧**：冷读现在会重放最近锚点之后的 ≤K 条增量（每条一次 `applyWorkspaceNote`，纯内存、O(K)）；游标增量扫描的 O(1) 常态路径不变（`deltasSinceAnchor` 随游标一起携带）。
- **格式契约**：transcript 多一种 log-only 条目类型。解析侧 `isTranscriptEntry` 只校验 base 字段（type/sessionId/turnId/sequence/createdAt），不校验 `state`，故增量条（带 `note` 无 `state`）天然可解析；旧 reader 遇到未知 type 也只是不当作 `workspace_state`（向前兼容：旧版读新 transcript 会忽略增量条、退化为「只认锚点」，仍得到一个略旧但自足的账本，不会崩）。
- **护栏（新增测试）**：① 单条锚点即可重建完整账本（格式级自足断言，**负控制**：把锚点改成非自足则此用例红）；② 锚点+增量重放 == `applyWorkspaceNote`；③ N=100 笔记全量快照数 == `ceil(N/(K+1))`=4 而非 100；④ 新会话冷读 / resume 冷读（全新 store 读同一文件）/ 跨锚点边界读三路等价；⑤ 无变化写入 transcript 字节不增长（文件级）；⑥ 无前导锚点的增量被跳过。既有 9 条 `workspace-ledger-store.spec.ts`（游标复用 / 锚失效 / 等长重写 / 超限 unavailable）全绿。
- **棘轮联动**：`pnpm measure:update`（`src/session/` 行数变化）；不触 `inputSchema`（无 fixture 重录）、不触事件面（`workspace_state_delta` 不是 `AgentEvent`/gateway frame）、不触 i18n（`ui/src` 无 `workspace_state` 命中）。

## 相关

- 前置决策：`docs/notes/implemented/2026-09-15-workspace-ledger-read-path.md`（PR #378，本 note 兑现其「Unresolved risks」第一条）。
- 议题：`#537`（TD-SESSION-N02）；账本状态机 `src/session/workspace/WorkspaceLedger.ts`；读取 `WorkspaceLedgerReader.ts`；写入节奏 `WorkspaceLedgerStore.ts`；条目类型 `src/session/transcript/TranscriptEntry.ts`。
- 方案：`docs/open-issues-remediation-plan.md` §2.3 第 1 条 / §3.4 / §6.2「P4 改 transcript 写入格式」风险行。
