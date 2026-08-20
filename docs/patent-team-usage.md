# 专利团队 — 使用指南

> 面向：专利工程师 / 代理人 / 律师（主会话任 captain，即"队长"）
> 日期：2026-08-20
>
> **接线状态：已落地（M1–M4）。** 团队编排层全量可用：durable 成员底座（teams.db 持久化团队/成员/任务/消息）、任务池 + 事件驱动调度器（M2）、9 个 `team_*` 工具 + 12 岗角色注册（M3）、Web 活动面板 + 失败任务自动转派 + 队长下线判定（M4，网关协议 1.4）。
> 关联文档：角色映射与注册接线见 [`docs/team-role-mapping.md`](team-role-mapping.md)；组建模板（7 场景包任务 DAG 全文）见 `skills/patent-team-composition/SKILL.md`；dsh 移植背景见 `docs/community-agent-teams-research.md`。

复杂专利作业（撰写、答复 OA、无效宣告、侵权诉讼等）可组建持久团队并行分工：队长只负责建队、下发任务、审批关键结论与收口，12 个专业角色自动认领任务、按依赖顺序推进、互相交付。简单案件（单份分析报告、单纯形式补正）直接单会话完成，不必建队。

## 一、快速上手（3 步）

在**队长会话**（就是普通聊天会话）里直接说，例如：

> "组建一个专利无效宣告团队，处理 CN2026XXXXXXXX 号案件，案卷目录在 /cases/xxx"

Agent 会依据内置组建模板 `skills/patent-team-composition/SKILL.md` 自动执行：

1. **建队** `team_create`（队名建议 `patent-team-<案卷号>`）
2. **招募** `team_add_member`：按场景角色包逐个添加（无效宣告包 6 人：检索员/撰写员/技术专家/无效请求人/专利权人/合议组）
3. **下发** `team_create_task`：按场景 DAG 建任务（带 dependencies）；调度器自动按依赖分派给空闲成员

之后无需干预：成员逐个完成任务并回报，你只需要在**审批卡片**出现时点"通过/拒绝"（见第五节）。全部完成后（或中途）可让 agent 收口、`team_archive` 归档。

## 二、两种使用入口

| 入口 | 能力 | 说明 |
|---|---|---|
| **对话式**（推荐） | 全部 9 个 `team_*` 工具 | 队长会话自然语言驱动；建任务 DAG、角色简报、审批、收口都在这 |
| **Web 团队面板** | 建队 / 添加成员 / 转派任务 / 归档 / 实时事件流 | 侧边栏底部 **Team** 按钮进入；**无建任务表单**——任务下发与审批必须走对话 |

## 三、9 个 `team_*` 工具速查

按 domain 分两档：**`team:manage`（仅队长会话可见）** 与 **`team`（成员角色可见）**。实现：`src/tool/builtin/team/`（`teamManagement.ts` / `teamTasks.ts` / `teamMailbox.ts` / `teamStatus.ts` / `teamArchive.ts`）。

| 工具 | domain | 关键参数 | 用途 |
|---|---|---|---|
| `team_create` | team:manage | `name`（必填）、`memberRoleSlugs?` | 建队（队长会话为 captain） |
| `team_add_member` | team:manage | `teamId`、`roleSlug` | 招募成员（12 岗 role id 见下节；成员继承队长 modelRoute） |
| `team_remove_member` | team:manage | `teamId`、`memberId`、`reason?` | 退休成员（不可逆；名下 open 任务回池暂缓） |
| `team_create_task` | team:manage | `teamId`、`subject`、`description?`、`dependencies?`、`maxAttempts?` | 下发任务（依赖成环抛 `team_task_cycle`；默认重试 3 次） |
| `team_update_task` | **team** | `teamId`、`taskId`、`status`、`attemptId`（必填）、`output?` | 成员/队长报告任务结果（stale attempt 拒绝；队长可 pending→cancelled） |
| `team_reassign_task` | team:manage | `teamId`、`taskId`、`memberId?` | 转派任务（指定成员重派；缺省回池暂缓） |
| `team_send_message` | **team** | `teamId`、`recipient`（成员）、`content` | 成员间邮箱投递（优先于任务分派） |
| `team_status` | **team** | `teamId` | 查团队视图（team/members/tasks） |
| `team_archive` | team:manage | `teamId` | 归档（**不可逆**：全员退休、调度停派；任务/消息仍可读） |

## 四、7 个场景包与 12 岗角色

**场景包**（成员数不含 captain；任务 DAG 全文见 `skills/patent-team-composition/SKILL.md`）：

| 场景 | 成员 | 目标 |
|---|---|---|
| 立案包 | 4（案件管理员/检索员/技术专家/撰写员） | 交底书从接收到"补充合格、可进入撰写" |
| 撰写包 | 5（检索员/撰写员/对立审查员/技术专家/申请人代理） | 新申请文件（权利要求+说明书+附图要求） |
| 答复审查意见包 | 5（同上，撰写团队可延续不重建） | OA 答复 |
| 补正包 | 2（撰写员/形式审查员） | 补正通知书答复或主动补正 |
| 复审包 | 5（检索员/撰写员/对立审查员/申请人代理/合议组） | 驳回决定复审（3 个月期限） |
| 无效宣告包 | 6（检索员/撰写员/技术专家/无效请求人/专利权人/合议组） | 无效宣告请求 + 专利权人防御 + 合议组模拟 |
| 侵权诉讼包 | 6–7（+ 技术调查官，高价值案件） | 侵权比对 + 原告主张 × 被告抗辩 + 庭审对抗模拟 |

**12 岗角色**（role id 可直接作 `team_add_member` 的 `roleSlug`；注册接线与映射表见 `docs/team-role-mapping.md`）：`case-manager`（案件管理员）、`researcher`（检索员）、`drafter`（撰写员）、`technical-expert`（技术专家）、`adversarial-reviewer`（对立审查员）、`applicant-counsel`（申请人代理）、`formal-examiner`（形式审查员）、`invalidity-petitioner`（无效请求人）、`patentee-defender`（专利权人）、`adjudicator`（合议组/裁判）、`defendant-counsel`（被告代理人）、`tech-investigator`（技术调查官）。

立场纪律（模板强制）：裁判不参与任一方策略起草；技术事实（技术专家/调查官）与法律论证（代理/裁判）分离；复审/无效 = 请求方 × 防御方 + 合议组，每个立场一个成员，不合并。

## 五、审批闭环（HITL）

成员的专利结论命中输出门禁审批词时，回合挂起并产生 `approval_pending`：

1. **冒泡**：`TeamApprovalForwarder`（`src/agent/team/member/approval-forwarder.ts`）把事件转发到**队长会话** watcher（标注成员来源）
2. **卡片**：队长聊天区**输入框上方**出现靛蓝审批卡片（`ui/src/components/chat/view/subcomponents/ApprovalRequestsBanner.tsx`，挂在 `ComposerV2.tsx:447`）：触发关键词、"待审批"徽章、可展开消息预览、可选拒绝理由框、"通过/拒绝"按钮
3. **回写**：点"通过/拒绝"→ `approvalDecide` 回写**成员会话**挂起审批，成员回合继续执行（拒绝带 feedback 打回重做）

队长离线时事件不丢——挂起态按成员会话留存，`approvalListPending` 兜底，重新上线后仍可审批。

## 六、主界面显示

**入口**：侧边栏底部 "Team" 按钮（Users 图标，`ui/src/components/app-shell/SidebarV2.tsx:1199`）→ 主内容区切到团队面板 tab（`ui/src/components/main-content/view/MainContent.tsx:763`，组件在 `ui/src/components/team-panel/`）。

| 界面区域 | 显示内容 |
|---|---|
| **团队卡网格** | 队名 + 队 id、归档黄徽章、**队长在线圆点**（绿=在线 / 灰=离线，离线超 60s 宽限后调度暂停）、成员数、任务数；末尾虚线"新建团队"卡 |
| **成员网格** | 每成员一张卡：状态圆点（idle 灰 / working 绿 / retired 浅灰 + 半透明）、成员 id、模型路由（provider / model）、角色徽章 |
| **任务看板** | 每行：彩色状态徽章（pending 灰 / claimed 蓝 / in_progress 琥珀 / completed 绿 / failed 红 / cancelled 灰）+ subject + attempt 次数 + 阻塞数 + 负责人；非终态任务带"转派"下拉；右上"归档团队"（二次确认） |
| **事件流** | 底部实时滚动（50 条窗口）：14 种 TeamEvent 彩色徽章（`task_claimed` 蓝 / `task_completed` 绿 / `task_failed` 红 / `task_retried` 琥珀 / `message_delivered` 紫…）+ `taskId · memberId · attempt:N` 描述 |
| **聊天区（队长会话）** | 成员审批冒泡为输入框上方靛蓝审批卡片（见第五节）；聊天流内可随时对话指挥成员 |

**数据通道**：快照 `POST /api/teams/panel`（5s 轮询，sessionKey 留空 = 全部团队）+ 操作 `POST /api/teams/action`（直调 `team_*` 工具）+ WebSocket `kind:"team_event"` 实时流（经 `ui/server` 中转 + `session-watch-registry` 广播）。网关协议 1.4 新增三个可选方法：`panelHeartbeat`（Web 下线判定，`ui/server/team-presence.js` 每 30s 心跳）/ `teamPanelSnapshot` / `teamToolCall`。

## 七、关键行为约束

- **队长在线才派发**：调度器检查 `isCaptainOnline`（CLI 帧或面板心跳，60s 宽限）；队长离线 → 暂停派发，在线后恢复
- **并发闸**：`maxConcurrentMembers` 默认 4（deployment 可调）；6–7 人场景包按 DAG 依赖逐批分派
- **成员继承队长 modelRoute**（provider/model/effort），不指定异构；仅当明确要求（如"检索用 X 模型"）才指定
- **邮箱优先**：成员邮箱未读投递优先于任务分派；成员回合内完成即回报 captain
- **归档不可逆**：`team_archive` 全员退休、调度停派，任务/消息只读保留
- **一 captain 一活跃团队**：一个队长会话同时只领导一个活跃团队，建队前确认无未收口团队

## 八、已知限制

1. 事件流仅在队长会话有活跃 turn 时实时投递，否则事件丢失——由面板 5s 快照轮询兜底（`EventStream.tsx` 注释）
2. 冷恢复（重启后续跑）turn 的 `approval_pending` 不冒泡到队长（M1 遗留；调度器直调 `wakeMember` 路径已接线）
3. 成员卡只显示工作状态（idle/working/retired），无浏览器在线态；在线态仅队长圆点体现

## 九、参照资产

- `skills/patent-team-composition/SKILL.md` — 组建模板（7 场景包任务 DAG 全文、创建序列、协作纪律）
- `docs/team-role-mapping.md` — 12 岗 ↔ Sati 既有角色映射表、注册接线说明
- `docs/community-agent-teams-research.md` — dsh-agent-teams 调研（移植来源）
- `src/agent/team/` — 团队编排层实现（storage/protocol/member/scheduler/taskpool）
- `src/tool/builtin/team/` — 9 个 `team_*` 工具实现
- `src/gateway/teamPanel.ts` + `ui/src/components/team-panel/` — 面板快照与 UI 实现
