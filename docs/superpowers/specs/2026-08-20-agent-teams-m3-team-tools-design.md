# M3 设计：团队工具面 + 调度器补齐 + 角色注册接线

> 前置：M1（durable 成员底座，2ee2468b）、M2（任务池/调度器/邮箱/TeamEvent，d7516ada → abacebfa，含最终审查 C1/C2/I1 修复）。本设计承接 M2 计划文档「留待 M3/M4」清单（10 个 `team_*` 工具 + 角色注册接线 + isCaptainOnline/message_delivered/blockedByCount/归档）与最终复审观察项（scanner 路径 onMemberIdle）。
> 范围决策（用户已确认）：**保持工具面**（活动面板留 M4）、**9 个工具语义适配**（无 claim_task——自动认领唯一路径；delete 改 archive）、**角色全量接线**（5 注册 + 7 复用立场补充 + composition 角色化）、**单迭代完整交付**。

## 一、目标

让团队编排层从「编程式入口」（M2 的 `teamSubsystem` 句柄）升级为 **agent 驱动**：队长（主会话）通过 `team_*` 工具建队/派单/转派/归档，成员（团队成员角色）回合内通过 `team_update_task` 完成任务。任务终结路径闭环后，M2 的 C2 re-claim 循环（回合内无工具可完成 → 无进展重试至 maxAttempts）自然收敛为「成员失败/无响应的兜底重试」。

## 二、范围

### 包含
1. 9 个 `team_*` 工具（`src/tool/builtin/team/`，domain: `team`）
2. 任务语义：成员回合内完成任务（显式标记终结）、归档、blockedByCount 维护
3. 补齐项：isCaptainOnline 接线、message_delivered payload 演进、scanner 路径 onMemberIdle 接线
4. 角色接线：5 新增角色注册 + 7 复用角色立场 systemPrompt + patent-team-composition 角色化
5. 测试：工具驱动集成用例 + stress 扩展 + llm-replay fixture 重录

### 不包含（明确后置）
- 活动面板（Web UI，`ui/src/components/team-panel/`）——M4
- 队长会话内「转派接管失败任务」的自动策略——留 M4 及以后（M3 保持 failed 后由队长显式 reassign）
- gateway 协议版本升级——M3 全部 additive（payload 增字段、gateway 层内部状态），协议维持 1.3

## 三、架构总览

```
队长会话（captain，主会话）
  │  team_* 工具（domain: team，经 ToolRegistry 注册）
  ▼
src/tool/builtin/team/          ← 新增：9 工具（薄封装，复用 M2 原子）
  │  TeamDb 读写 + validateAttemptUpdate + onTaskGraphChanged/onMemberIdle
  ▼
src/agent/team/                 ← M2 既有：TeamDb / scheduler / mailbox / waker / scanner
  │  + isCaptainOnline（gateway 活跃连接表）
  ▼
src/gateway/                    ← 新增：sessionKey 连接活跃追踪（内部状态，协议不动）
```

工具层不复制业务逻辑：全部复用 M2 锁内原子（`withTeamLock` / `beginTaskAttempt` / `invalidateTaskAttempt` / `validateAttemptUpdate` / `scanStrandedTasks`）与邮箱租约（mailbox）。工具职责 = 参数校验 → 锁内 read-modify-write → 触发事件/调度。

## 四、工具面（9 个 `team_*` 工具）

文件组织：`src/tool/builtin/team/` feature-folder，5 文件（每文件 1-3 工具 + index barrel 注册）。全部声明 `outputSchema`（`ToolRegistry({ requireOutputSchema: true })` 强制，createBuiltinRegistry 已开启）。

| 文件 | 工具 | 职责 | 事件 |
|---|---|---|---|
| `teamManagement.ts` | `team_create` | 建队（name + 可选首批成员 roleSlug[]）；成员 roleSlug 须在注册角色表内（复用 registerRoleDefinition 装配结果） | `team_created` |
| | `team_add_member` | 招募成员（roleSlug 校验 + modelRoute 继承队长/默认） | `member_added` |
| | `team_remove_member` | 成员退休（`insertRetired` + 名下 open 任务 invalidate 回池） | `member_removed` |
| `teamTasks.ts` | `team_create_task` | 建任务（subject/description/dependencies/maxAttempts）→ `onTaskGraphChanged` 自动认领唤醒 | `task_created` |
| | `team_update_task` | 状态推进：`completed`（+output）/ `failed`（+reason）/ `canceled`；`validateAttemptUpdate`（attemptId）校验；**成员仅能操作自己名下任务**；completed 后任务终结（下游依赖解锁 → 触发调度）；重算 `blockedByCount` | `task_completed` / `task_failed` / `task_updated` |
| | `team_reassign_task` | 转派：invalidate（新 handoffId）+ 指定成员或回池（`nextAssigneeId`/`reassigning`）→ 调度 | `task_reassigned` |
| `teamMailbox.ts` | `team_send_message` | 投递消息到成员邮箱（复用 mailbox 租约写入）；收件人须为团队成员 | `message_delivered` |
| `teamStatus.ts` | `team_status` | 三视图只读：团队概览 / 成员状态（含 status/roleSlug/modelRoute）/ 任务列表（status/attempt/assignee/dependencies/blockedByCount/handoffId） | 无（纯查询） |
| `teamArchive.ts` | `team_archive` | 归档：`team_archived` 状态 + 调度器跳过该团队 + 成员全退休（retired_members）+ 任务/消息保留只读 | `team_archived` |

**工具权限语义**：domain: `team` 裁剪——captain（主会话，未裁剪域）可见全部 9 个；团队成员角色（新增 5 角色 domains 含 `"team"`）可见 `team_update_task` / `team_send_message` / `team_status`（作业必要面），不可见团队管理/归档（防越权）。实现：管理类工具 domain 标注 `team:manage`，作业类标注 `team`，按角色 `visibleDomains` 裁剪时 `team:manage` 仅 captain。

**关键语义：成员完成任务路径**
1. 成员回合中调用 `team_update_task({ taskId, status: "completed", output })`
2. 工具层校验：任务 assigneeId === 当前成员（经 `ToolContext` 的 sessionKey 判定）→ `validateAttemptUpdate(task, task.attemptId)`（fail-closed：终态/attemptId 已清拒绝）
3. 锁内 `updateTask({ ...task, status: "completed", output, updatedAt })`
4. 触发 `task_completed` → 成员回合结束 `turn_completed` → 既有 `onMemberIdle` → 调度器解锁下游依赖/派发下一任务
5. 任务终结后 C2 检查（attempt ≥ maxAttempts 置 failed）不命中（`ownedOpenTask` 仅匹配 open 状态）——re-claim 循环自然停止

**归档语义**：`team_archive` → 锁内复查（团队非 archived）→ 置 `archived` + 全部成员 `insertRetired`（reason: "team_archived"）+ 触发 `team_archived`。调度器认领前检查团队状态（与 isCaptainOnline 同点：archived 或 captain 离线 → 跳过）。归档不可逆（M3 无 unarchive；重建 = 新队）。

**blockedByCount 维护**：create_task / update_task / reassign_task 均按 `dependencies` 数组重算（未完成依赖计数）。依赖判定与 M2 调度器一致（dependencies 数组 + 终态检查），字段从「M3 预留」转为「实时维护」。

## 五、补齐项

### 5.1 isCaptainOnline（调度器钩子接线）
- 现状：`TeamSchedulerOptions.isCaptainOnline?: (captainSessionKey: string) => boolean` 已预留，createLocalGateway 未传 → 默认常在线（`scheduler.ts:85`）
- 实现：`src/gateway/` 新增连接活跃追踪（轻量模块，如 `src/gateway/server/sessionPresence.ts`）：
  - `GatewayWsConnection` 握手（hello 帧含 sessionKey）时注册该 sessionKey，`onClose` 注销；每收到帧刷新最近活跃时间戳
  - 对外暴露 `isSessionActive(sessionKey): boolean`（有活跃连接且最近帧在宽限窗内）
- 接线：createLocalGateway 构造 TeamScheduler 时传 `isCaptainOnline: key => sessionPresence.isSessionActive(key)`
- 语义：captain 离线 → 调度器暂停新认领（在途回合跑完即停，`scheduler.ts:91` 已有）——队长离线时成员不被自动唤醒，防无人接收成果的野回合
- 协议影响：无（gateway 内部状态，Web 客户端无感知）

### 5.2 message_delivered payload 演进
- 现状：`{ type: "message_delivered"; teamId; recipient; sender: string }`——sender 为批次首条
- 演进：新增 `senders: string[]`（批次完整发送者列表）；`sender` 保留（= senders[0]，兼容既有消费方）
- additive 变更：事件矩阵更新（payload 类型变化 → `pnpm gen:event-matrix`），Web 1.0 客户端未知字段忽略，协议不升版

### 5.3 scanner 路径 onMemberIdle 接线（最终复审观察项 3）
- 现状：`runMemberScan` 冷恢复回合的 turn_completed 只经 `handleMemberEvent`（审批冒泡），不触发 `onMemberIdle` → 冷恢复回合后任务保持 claimed 直至下次 stranded 扫描
- 接线：runMemberScan 的 onEvent 透传处补 onMemberIdle 调用（与 wake 包装层 turn_completed 分支同款：turn_completed + 成员 open 任务未达 maxAttempts → `teamScheduler.onMemberIdle(teamId, memberId)`）
- 语义：冷恢复回合结束即续派下一任务（与正常回合对齐）

## 六、角色接线（12 岗全量）

### 6.1 5 个新增角色注册
- 资产已存在（`skills/patent-teams/{case-manager,formal-examiner,applicant-counsel,defendant-counsel,tech-investigator}/SKILL.md`，已有 `type: role` frontmatter）
- 本任务：补全 frontmatter 完整字段（`tools` / `omitTools` / `readOnly` / `systemPrompt`）+ `domains`（各文件「工具域建议」小节 + `"team"` 域；formal-examiner 建议 `readOnly: true`）
- 注册装配：复用现有机制（`createLocalGateway` 加载 skills → `roleFromSkill` 解析 → `registerRoleDefinition`，`createLocalGateway.ts:2125-2130`）——确认装配循环覆盖 `skills/patent-teams/` 子目录，无需新装配代码
- 完成判据：12 岗全部可按 `subagent_type`（agent 工具）或团队 `roleSlug`（team_add_member）调度

### 6.2 7 个复用角色立场补充（团队变体角色资产）
- 约束：`docs/team-role-mapping.md` 明确「不改既有角色资产」（复用角色被既有 workflow/agent 调度使用，改资产有回归风险）；`roleFromSkill` 无注册时注入机制（SubagentDefinition 全部来自 SKILL.md frontmatter）
- 实现方式：在 `skills/patent-teams/` 下按 dsh 岗 id 建 **7 个团队变体角色 SKILL.md**（researcher / drafter / technical-expert / adversarial-reviewer / invalidity-petitioner / patentee-defender / adjudicator）——frontmatter 以对应复用角色资产为基底（tools/domains 照抄），systemPrompt = 基础职责 + `docs/team-role-mapping.md` 差异列的立场指令（覆盖度自评 / 真实性核验 / 对抗预判 / 防御立场反转 / 中立裁判等）
- 变体角色 id（roleSlug）= dsh 岗 id，与新增 5 角色同目录统一管理；映射表更新（7 个复用岗的「复用」列改为变体资产，标注基底角色）
- 完成判据：12 岗全部可在团队 roleSlug 调度下带正确立场/职责（变体 = 基底 + 差异指令）

### 6.3 patent-team-composition 角色化
- `skills/patent-team-composition/SKILL.md`（Task 9 资产）注册为可调度角色（建队引导：队长建队前加载 7 场景编制知识）
- 同步修正：SKILL.md 中 `agent_teams_*` 工具名引用 → Sati `team_*`（原标注「M3 落地」兑现）

## 七、测试与验证

1. **工具层单测**（`tests/tool/builtin/team/`）：9 工具参数校验 / 权限（captain vs 成员）/ 错误路径（非本人任务、stale-attempt、roleSlug 非法、收件人非成员）
2. **集成用例**（`tests/agent/team/team-gateway-integration.spec.ts` 扩展）：
   - 工具驱动全链：team_create → team_add_member → team_create_task → 自动认领 → 成员回合 `team_update_task(completed)` → 任务终结（attempt 不再递增）+ 下游解锁
   - reassign：invalidate → 新 attempt 认领
   - archive：归档后调度跳过 + 成员退休 + 数据保留
   - isCaptainOnline：captain 离线 → 新任务不认领
   - scanner onMemberIdle：冷恢复回合结束续派
3. **stress 矩阵扩展**（`scripts/team-stress-verify.mjs`）：工具驱动场景（含 update_task 写入路径，回应 M5）
4. **llm-replay fixture 重录**：9 个新工具改变 toolSchemaDigest → 既有 fixture 失配 → 按显式录制流程（`scripts/record-real-fixture.ts`）重录；完成后 `pnpm record:replay` 校验
5. **验证链**：`pnpm build` → 团队测试 → `pnpm lint`（含 check:event-matrix / check:patent-sop / check:patent-workflow-docs / check-html-templates）→ `pnpm format:check` → 全量测试

## 八、已知边界（M3 后）

- 转派接管失败任务的自动策略（failed → 自动 reassign）——M4+（M3 保持 failed 后由队长显式 reassign）
- 活动面板（Web）——M4
- team_archived 不可逆（无 unarchive）——如需恢复重建新队
- isCaptainOnline 宽限窗参数（连接活跃判定）默认 60s（实现时可调），M4 面板可展示成员在线状态时再调优
