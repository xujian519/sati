# Sati × PilotDeck 引入方案（上游 v2026.09.19 之后）

Status: implemented（#599 的 P0 / P1 / P3 已落地；P4 见「非目标」）

范围基线：上游 `OpenBMB/PilotDeck` 在 **PR #593（2026-09-16 合并）之后**的增量
基准提交：Sati `main`（HEAD `125c75885`）；上游 `main` 最新 = `cd52c9af`（#599 合并，2026-09-18）
分支策略：一条分支 + 一个 PR（AGENTS.md 关键环境事实：main 受保护）

---

## 一、基线认定：上次同步到底同步到哪

| 时间 | 事件 | 证据 |
|---|---|---|
| 2026-08-02 | 全量同步 PilotDeck→Sati | `cad4f61d0` |
| 2026-09-10 | 移植上游 tag `v2026.09.10` | `c73bb8d2a`（#284） |
| 2026-09-16 | 09 月方案：覆盖 09-11 后合并的 10 个 PR，选定 6 项 | `docs/pilotdeck-2026-09-upstream-port-plan.md` |
| 09-16 ~ 09-18 | P1–P6 落地（状态 implemented，note 齐备） | `docs/notes/implemented/2026-09-16-*.md` |

⇒ 已消耗的上游边界 = **#593**；未消耗 = **#599**。

## 二、上游 delta（v2026.09.17 / v2026.09.19）

| tag | 合并提交 | 日期 | 含 | 状态 |
|---|---|---|---|---|
| `v2026.09.17` | `ecedc5c3` | 09-16 | PR #593 的 6 个提交（时间线身份重构 + 4 个修复提交） | 09 月方案已判定（仅取切片） |
| `v2026.09.19` | `cd52c9af` | 09-18 | **PR #599**：`aeb7c0e3` 崩溃安全 + `5c112833` fork 重定向（+448/−69，9 文件） | **本方案对象** |

`main` 上 09-18 之后无新提交（`pushed_at` 2026-09-20 为分支侧推送，代码面未变）。

### #599 的三处机制

1. **单记录快照**：整份替换上下文写进 `compact_boundary` 记录的 `snapshot` 字段，边界与
   替换内容同一条 JSONL 记录。
2. **有效性门控重放**：只有快照通过形状校验才授权丢弃边界前历史；legacy/损坏边界保留原文
   并发 warning；legacy 替换记录不再作为模型可见消息。生效不依赖 turn 完成。
3. **尾记录隔离 + fork 重定向**：写前探测文件尾避免截断记录吞并下一条；fork 时重定向快照内
   消息的会话内路径。

## 三、逐项适用性判定（Sati 现状核对）

| 上游机制 | Sati 现状（改动前） | 判定 |
|---|---|---|
| 边界 + 替换消息分条写 | `src/agent/turn/TurnRunner.ts` 的 `onCompactPersisted` 与上游被替换代码逐行同构 | ✅ 缺陷面存在 |
| 重放仅凭边界丢弃历史 | `TranscriptReplay.findLastCompactBoundaryIndex` + `beforeBoundary`；替换消息另受 `completedTurnIds` 门控 | ✅ 缺陷面存在（turn 未完成时更重） |
| 截断尾吞并 | `JsonlTranscriptWriter` 已有 `tailProbed`/`tornTail` 补换行 + 单条 `write(2)` + 短写循环 | ⛔ 已覆盖（实现强于上游） |
| `flush: true`（fsync） | 全仓无 fsync 调用 | 🔸 单记录形态下不需要（见「非目标」） |
| fork 重定向 | `forkSession.ts` 只覆盖 `accepted_input` + 三类消息条目 | ⚠️ 快照形态下必须补，否则分叉会话指向源会话的媒体/溢出路径 |
| `lastCompactBoundaryIndex` 等返回字段 | 模块外无消费方 | ✅ 改动面可控 |

**Sati 官有耦合（上游没有，本次必须一并处理）**：

- `projectFullMessageSequence` 的索引须与压缩当时的 `shadowedRanges` 对齐——替换消息不再成条，
  须把快照消息纳入该序列；`replayShadowedMessagesAt` 的输入切片还须**含上次边界自身**，
  否则多压缩会话的后一次记录整体缺一段。
- `TurnRunner` 的压缩重放本来要过 `PatentOutputGate`（免责声明等），上游形态会丢掉这一步
  ⇒ 先门禁取文本、再内联快照。
- `findLastCompactBoundaryIndex` 在 Sati 身兼两职（编辑最后 turn 的压缩尾巴校验、遮蔽原文展开），
  不能直接改语义 ⇒ 重放授权改用文件内私有的 `findLastReplayBoundaryIndex`（双轨判定，见 P2）。

## 四、落地批次与状态

| 批次 | 内容 | 状态 |
|---|---|---|
| P0 | 先复现：`tests/session/compact-snapshot-crash.spec.ts` 四条用例（含记录间崩溃、部分落盘、turn 未完成、快照损坏） | ✅ 先红（4/4 fail，症状为空投影）后绿 |
| P1 | 单记录快照 + 有效性门控 + 门禁保留 + 两个 Sati 官有耦合修复 | ✅ `src/session/transcript/CompactSnapshot.ts`、`TurnRunner`、`TranscriptEntry`、`TranscriptReplay` |
| P2 | legacy 口径：取**双轨 B**（无 `snapshot` 字段的旧记录沿用旧语义；声明快照却不可读的记录不授权丢历史 + warning） | ✅ 已实现（改判理由与行为边界见 note 的 Decision / Alternatives） |
| P3 | fork 重定向（`mapTranscriptEntryMessages` + `control_boundary` 入处理集） | ✅ 含负控制用例 |
| P4 | durability 加固（fsync 级） | ⛔ 非目标，理由见下 |

决策记录：`docs/notes/implemented/2026-09-20-compact-snapshot-crash-safety.md`

## 五、非目标（明确不做）

| 项 | 理由（本次新增证据） |
|---|---|
| #593 全批（含 `fc6743d9` / `91d69f1a` / `000313cd` / `24d6606e` 四个修复提交） | 目标模块在 Sati **不存在**：`src/agent/stream/TurnTimeline.ts`、`ui/src/stores/sessionTimeline.ts`、`ui/server/pilotdeck-bridge.js` 均无文件；四个提交是在同一 PR 新建的时间线子系统**内部**修缺陷，无移植对象。「完整时间线协议」仍否 |
| #599 的 `prepareTail()` | Sati 已有更强的 torn-tail 处理，照搬是降级 |
| #599 的 `flush: true`（fsync） | 单记录形态下快照不完整即不授权丢历史，崩溃安全不依赖 fsync；断电丢整批等价于「压缩回滚」而非丢历史。只在实测出反例时再做 |
| #585 项目侧栏 | 仍待先复现两条症状（新建 workspace 侧栏延迟可见 / 删除项目后分页总数重复递减） |
| #586 模型选择器分组、#591 代码块主题 | 价值低 / Sati 无此缺陷 |
| #574 删除文本→工具调用兜底与 `thinkFsm`、#587 删除 temperature | 与 Sati 现有契约冲突（沿用 09 月方案否决理由） |
| #570 UploadStore 路径收敛 | Sati 已是分叉实现 |

## 六、验证记录

- 新增用例：`tests/session/compact-snapshot-crash.spec.ts`（4）、`tests/web/fork-compact-snapshot.spec.ts`（1）。
- 负控制：摘掉 `control_boundary` 重定向 ⇒ fork 用例红（快照内媒体路径停在源会话目录）。
- 既有 fixture 迁移：`transcript-replay-compaction.spec.ts` 改写为快照 / legacy 双契约；
  `project-messages` / `shadowed-messages-replay` / `transcript-replay-cache` / `output-gate-wiring`
  由 legacy 形态迁到快照形态；`shadowed-messages-replay` 的「产物丢失」篡改改为从快照里删一条。
- 生成物回填：`pnpm gen:doc-claims`（新增源文件影响 `docs/code-facts.md` 模块索引）、
  `pnpm measure:update`（`docs/technical-debt/metrics.md` 基线）。
- 门禁：`pnpm check`（含 11 个领域门禁）。

## 七、下一次同步的起点

- 已消耗到 **#599（`cd52c9af`，2026-09-18）**；上游 `v2026.09.19` 即此提交。
- 下次先看 `v2026.09.20` 之后的 tag 与 `main` 最新提交，再按本文件「三、适用性判定」的
  同一方法（先核对目标模块在 Sati 是否存在，再谈移植）逐项过。
