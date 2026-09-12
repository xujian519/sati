# Agent Note: team 子系统 builder 抽离（P4a 第四刀，组合根收口）

Status: implemented

## Problem

前三刀之后 `createLocalGateway.ts` 是 635 行，其中工厂函数本体仍占约 440 行。最大剩余块是**团队子系统**：durable 成员底座（`teams.db`）、队长审批转发、成员冷恢复扫描、stranded 任务回收、事件驱动调度器与启动扫描编排——约 190 行，夹在 gateway 创建与 `return` 之间，且含一个 758 字符的「启动扫描」IIFE。

这段代码是 P4a 四个 builder 里的 **team builder**（原计划写作 always-on/approval-store 一族），也是把组合根压进 `≤600` 验收线的主要对象。

## Decision

搬进 `src/cli/teamSubsystem.ts`，暴露 `buildTeamSubsystem(deps): TeamSubsystemRuntime`：

| deps（6 个） | 说明 |
|---|---|
| `pilotHome` / `env` | `defaultTeamDbPath(pilotHome, env)` |
| `gateway` | 事件广播（`emitForSession`）与 `wakeMember` 的宿主 |
| `fallbackProjectRoot` | 调度器扫描/黑板摘要根 |
| `sessionPresence` | `isCaptainOnline` 数据源 |
| `mailboxLeaseMs` | P1-5 邮箱租约宽限 |

返回 `{ db, scheduler, emitTeamEvent, workerRegistry, runMemberScan, runStrandedScan, startStartupScan }`。

**关键设计点：启动扫描不从 builder 内部自启。** 原文件里那段 IIFE（`teamDb.resetMemberStatuses()` → 重建挂起审批总线 → `runMemberScan()` → `runStrandedScan()`）写在 `registry.setTeamTools(...)` **之后**；顺序是刻意的——若扫描先于工具注入启动，被唤醒的成员会话会走 `resolve()` 建出不含 `team_*` 工具的 runtime。所以把它改成返回句柄 `startStartupScan()`，由工厂在原位置调用，时序逐字保持。

工厂保留的部分（这才是组合根该做的事）：`registry.setTeamTools` / `setMemberToolScopeResolver` / `setTeamDb` / `setKanbanBoardManager` 四处注入，以及 `startStartupScan()` 调用点、`dispose` 里的 `team.db.close()`、`return.teamSubsystem` 的句柄转出。

结果：`createLocalGateway.ts` **635 → 448 行**（P4a 验收线 `≤600` 达成，余量 152 行），新模块 259 行。

**改写方式**：与第三刀同一套 AST 脚本——定位区域 A（`const teamDb = …` 到 `runStrandedScan` 结束，8009 字符）与区域 B（启动扫描 IIFE，758 字符），按节点类型规划替换 span（捕获标识符 → `deps.x`、**简写属性展开**、`options.mailboxLeaseMs` 整链替换），再从后往前替换；区域 B 整体改写为 `const startStartupScan = (): Promise<void> => …`。工厂侧的 12 处引用改为 `team.<field>`（其中 3 处是 `return`/注入对象里的简写属性，需展开）。

## Alternatives considered

- **把 registry 的四处注入也搬进 builder（deps 里传 registry）** — 落选：那样 builder 就要依赖 `ProjectRuntimeRegistry` 类型，把"装配实现"和"往注册表挂载点"两个关注点重新混回一个模块；组合根保留注入反而是它最该承担的责任（谁被装配、装到哪，一眼可见）。
- **让 builder 内部自启扫描（把 IIFE 留在里面）** — 落选：会静默改变时序（扫描先于工具注入），而这类竞态只在"冷启动时正好有断点成员"的场景暴露，测试未必覆盖。改为显式 `startStartupScan()` 句柄后，顺序由调用点在源码里写明，也便于将来 M2 调度器复用。
- **把 team 段与 always-on/cron 段合成一个"后台子系统" builder** — 落选：两者依赖面几乎不重叠（always-on 走 gateway setter + discovery service，team 走 teams.db + 调度器锁），合并只会产出一个需要 10 字段 deps 的杂糅模块。
- **连 `cleanupOrphanToolResults` / `registry.runTaskResumeScan()` 一起搬**（它们夹在 team 段与注入之间） — 落选：前者是工具结果目录回收、后者是跨进程续算，都不属于团队子系统；搬走等于为了少改几行而给模块安错职责，还会打乱工厂里 fire-and-forget 副作用的相对顺序。
- **手改** — 落选：同第三刀的理由——简写属性、同名属性键、`deps.` 前缀三者的组合极易静默错改，AST 规划 span + 规范化对比才留得下可复核证据。

## Consequences

- `createLocalGateway.ts` 635 → **448 行**，达成 P4a 的 `≤600`；团队子系统的构造与启动编排获得独立模块边界。
- 行为不变的三重证据：① AST 规范化对比——区域 A（8009 字符）把 `deps.x` 归一后与基线打印结果完全相同（3438 字符对 3438 字符）；② 残余捕获扫描为零；③ `pnpm check` + `pnpm test` 全绿。
- 事件矩阵无漂移（重跑 `pnpm gen:event-matrix` 后 `docs/event-producer-consumer.md` 无 diff）。
- 顺带修正第三刀文档里的行数笔误（635 写成 634）。
- P4a 剩余：按 builder 拆 `ProjectRuntimeRegistry.ts`（1663 行；`prepareSessionRuntime` 537 / `resolve` 249 / `createAgentConfig` 127）——组合根目标已达成，这一刀起是类内拆分。
