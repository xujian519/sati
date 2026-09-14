# Agent Note: AgentLoop 巨型文件拆解收口（issue #147 结清）

Status: implemented

## Problem

issue #147 登记的是"`AgentLoop.ts` 与 `createLocalGateway.ts` 是 src 最大的两个文件，认知负载高"：前者是 Agent 主循环（触发还债时 2433 行），后者是大型组合根（2730 行）。二者都不是"某一段写得差"，而是**多子系统长在一个文件里**——拆下去必然会问"拆到哪一步算完"，没有这一步的判断标准，就会在"再拆一刀看起来更整齐"与"过度切分反而更难读"之间反复。

## Decision

**本 issue 就此结清**，两侧的收口判据与最终体量：

| 文件 | 起始 | 收口 | 判据 |
|---|---|---|---|
| `src/cli/createLocalGateway.ts` | 2730 | **448** | 早前的组合根拆分已达 P4a 的 ≤600 验收线（十刀：helper 外置 / registry 独立 / gateway builder / team builder 等） |
| `src/cli/ProjectRuntimeRegistry.ts` | 1663 | **642** | 六段类内拆分全部落地，随组合根一起收口 |
| `src/agent/loop/AgentLoop.ts` | 2433 | **1133**（−53%） | **不再有 200+ 行的私有子系统方法**，剩余内容全部是"主循环阶段编排 + 其编排用辅助" |

2026-09-14 当日四刀（第 5–8 刀）完成的最后一批外迁：

| 刀 | 外迁内容 | 目标模块 |
|---|---|---|
| 5 | turn 出口与中止捕获、共享恢复策略 | `turnExit.ts`（185）· `recoveryStrategies.ts`（225） |
| 6 | `handleModelError` 恢复链（9 步骤 + 调度口，TD-AGENT-101） | `modelErrorRecovery.ts`（592） |
| 7 | `assembleAndRecover` + `repairTextExtractedToolNames`（TD-AGENT-103） | `responseAssembly.ts`（394） |
| 8 | 请求装配与压缩执行器 | `modelRequest.ts`（287）· `compactionExecutor.ts`（143） |

**停在 1133 行是设计使然**：剩下的 AgentLoop 内容是一台"阶段编排器"——`run()` 骨架（76 行）+ 9 个阶段方法（最大 `handleNoToolCalls` 188 / `executeToolCalls` 179 / `prepareModelCall` 116）+ 编排用私有辅助（续跑、熔断、收尾、权限与模式覆写）。把它们再切出去不是"搬家"而是"改流程"：阶段方法共享 `TurnRuntimeState`、按固定顺序交接 `TurnStep*` 结论，切开会把顺序契约从"读一个类"变成"跨文件追调用链"，正是拆解要消除的那类成本。

剩余未做的 P4c（渠道类切分：`WeComChannel.ts` 1761 / `weixin` 1492 / `feishu` 1333）**不属于本 issue 的债务**：那是渠道适配层的脚手架重复，与"Agent 主循环 / 网关组合根"无关，其方向由 issue #149（渠道公共 helper 去重）承担，登记在 `docs/technical-debt/next-batches-schedule.md` §3 机会型清单。

## Alternatives considered

- **继续拆阶段方法**（把 `handleNoToolCalls` / `executeToolCalls` 也搬成独立模块） — 落选：这些方法是"编排"而非"子系统"，其依赖是整台循环（配置、工具运行时、事件发射、状态容器），外迁需要一袋几乎与 AgentLoop 同宽的依赖；收益是行数，成本是顺序契约变隐式。
- **给 AgentLoop 定一条硬行数线（如 ≤800）** — 落选：行数不是这里的认知负载指标。八刀之后剩下的每一行都在"一轮 turn 的控制流"这一条主线上；为达标而切分会复刻拆解本身要消灭的问题（读者要跨文件才能拼出一轮 turn 的形状）。
- **本 issue 保持 OPEN、把 P4c 挂在名下** — 落选：P4c 的债务主体是渠道类，与 #147 的文件族无关；挂在 #147 下会让"这个 issue 到底在等什么"继续模糊。P4c 的入口在排期表 §3 与 #149。
- **顺手把 TD-SIZE-001 也结清** — 落选：该条还挂着 `SkillsV2.tsx` 2503 · `sati-bridge.js` 2055 · `routes/taskmaster.js` 1888 · `PdfDocumentPreview.tsx` 1861 · `WeComChannel.ts` 1761，属另一批文件族，保持 partial。

## Consequences

- 一个"两文件巨型"的 issue 以可验证的判据收口：组合根达 ≤600 验收线，主循环降到"只有编排"且无 200+ 行私有方法。
- AgentLoop 的行为边界由模块结构固定：turn 出口（`turnExit`）、模型错误恢复链（`modelErrorRecovery`）、响应装配与异常处置（`responseAssembly`）、请求装配（`modelRequest`）、压缩执行（`compactionExecutor`）各有归属与直测；`StageOutcome`/`unhandled` 成为两条链共用的结论词汇。
- 拆解期间新增行为基线 82 条（`turnExit` 11 · `recoveryStrategies` 9 · `modelErrorRecovery` 22 · `responseAssembly` 22 · `modelRequest` 8 · `compactionExecutor` 10）；`tests/agent/**` 现为 432 用例、全量 4312 用例。
- 代价已记录：`AgentLoop` 仍是 loop 目录最大的单文件（1133 行），TD-SIZE-001 保持 partial；若将来 `handleNoToolCalls` / `executeToolCalls` 内部再长出独立子系统（如新的工具结果后处理管线），按同样判据（"有独立依赖面与可命名职责"）可再起一刀。
