# Discovery 链路 Gateway 化 — 实施计划

- 状态：**已实施**（2026-08-05 随协议 1.1 落地：`always_on_list_plans` / `always_on_read_report` / `always_on_list_cycles` / `always_on_archive_cycle` / `always_on_apply_cycle` 五个可选方法已上线，见 `src/gateway/protocol/version.ts` 变更表）
- 日期：2026-08-05
- 关联：`docs/design/gateway-protocol-versioning.md`（协议版本化与边界检查草案）
- 原则：**端 → gateway 协议 → 业务服务**，消除 ui/server 中转与重复实现

---

## 实施状态速览（2026-08 对照代码）

| 条目 | 状态 |
|------|------|
| 协议 MINOR bump 1.0 → 1.1 + 变更表 | ✅ 已实施（`src/gateway/protocol/version.ts`） |
| 五个可选 discovery 方法（入参/出参类型） | ✅ 已实施（`src/gateway/protocol/types.ts`） |
| InProcessGateway / RemoteGateway / GatewayWsConnection 分发 | ✅ 已实施 |
| 前端直连 gateway（P2b 直连聊天双轨） | ✅ 已实施（`docs/design/gateway-chat-direct-connect.md` P2b-0） |
| `ui/server` discovery 业务完全退役 | ⏳ 部分：REST 薄适配仍保留（S2/S3 收敛排期中，见 gateway-protocol-versioning Part B） |

---

## 1. 背景与目标

当前 discovery plan 的列表 / 报告 / 工作周期 / 应用编排，前端经 REST 到达 `ui/server`，再经 thin adapter（`ui/server/discovery-plans.js`）**深层 import `src/`** 完成业务调用：

```
AlwaysOnDashboard.tsx / RunDetail.tsx
  → ui/src/utils/api.js  (REST: /api/projects/:name/discovery-plans | .../work-cycles | .../execute | .../apply | .../archive)
  → ui/server/routes/projects.js
  → ui/server/discovery-plans.js   ← thin adapter（DI 装配，deep import src/）
  → src/always-on/web/DiscoveryPlanService.ts / WorkspaceApply.ts / DiscoveryStateStore.ts
```

与此同时，gateway 协议已具备 `always_on_apply` / `always_on_rerun_plan` 两个方法（federation 链路：`GatewayWsConnection` case → `Gateway` 接口 → `InProcessGateway` → `AlwaysOnManager` / `createApplyHandler`）。

**目标**：把 discovery 的读路径（列表/报告/周期）与应用编排路径（apply 三步）整体收敛为 gateway 协议方法，前端直连 gateway，`ui/server` 不再承载 discovery 业务。这也是架构总报告中优化①（双后端收敛）的试点——该链路的 thin adapter 已把装配与业务分离，迁移成本最低、示范价值最大。

---

## 2. 现状核对（代码级，2026-08-05 已核实）

| 能力 | REST 端点（api.js / routes/projects.js） | 业务实现 |
|---|---|---|
| 计划列表 | `GET /:name/discovery-plans` | `DiscoveryPlanService.getPlansOverview` |
| 计划重跑 | `POST /:name/discovery-plans/:id/execute` | `gateway.alwaysOnRerunPlan`（已 gateway 化） |
| 报告读取 | `GET /:name/discovery-plans/:id/report` | `DiscoveryPlanService.readReport` |
| 周期列表 | `GET /:name/work-cycles` | `DiscoveryPlanService.getCyclesOverview` |
| 周期归档 | `POST /:name/work-cycles/:id/archive` | `DiscoveryPlanService.archiveCycle` |
| 周期应用 | `POST /:name/work-cycles/:id/apply` | `DiscoveryPlanService.applyCycle`（queue → apply → finalize 全状态机已收编进 service；`always_on_apply_cycle` 协议方法委托） |

> 注：原「计划上下文」能力（`GET /:name/discovery-context` / `buildDiscoveryContext`）已随 2026-08-05 重构删除——其唯一消费方 `handleGetProjectDiscoveryContext` 被移除，核心不再导出该模块。

已具备的协议方法：`always_on_apply`（`AlwaysOnApplyInput`：projectKey/workCycleId/projectName）、`always_on_rerun_plan`（`AlwaysOnRerunPlanInput`：projectKey/planId/projectName），类型在 `src/gateway/protocol/types.ts:375-397`，分发在 `GatewayWsConnection.ts:257-265`，封装在 `RemoteGateway.ts:210-215`。

测试现状：`tests/always-on/web/DiscoveryPlanService.spec.ts` 已补齐（24 用例：归一化 / overview 排序与 session 推导 / report 推断 / archive / queueCycleApply / updateCycleExecution）。`GatewayWsConnection` 的 always_on 分发无测试。

---

## 3. 协议改动清单

### 3.1 新增方法（全部可选、向后兼容，协议 MINOR bump 1.0 → 1.1）

| 方法 | 入参 | 出参 | 对应业务 |
|---|---|---|---|
| `always_on_list_plans` | `{ projectName: string }` | `{ plans: WebPlanOverview[] }` | `getPlansOverview` |
| `always_on_read_report` | `{ projectName: string; planId: string }` | `{ content: string }` | `readReport` |
| `always_on_list_cycles` | `{ projectName: string }` | `{ cycles: WebCycleRecord[] }` | `getCyclesOverview` |
| `always_on_archive_cycle` | `{ projectName: string; cycleId: string }` | `{ archived: boolean }` | `archiveCycle` |
| `always_on_apply_cycle` | `{ projectName: string; workCycleId: string }` | `{ cycle; sessionKey?: string; error? }` | apply 三步编排（见 3.2） |

> 说明：`discovery-context` 暂不纳入本期（聚合成本高、收益低），REST 保留；`always_on_rerun_plan` / `always_on_apply` 保留不动，其中 `always_on_apply` 仍被 `always_on_apply_cycle` 内部复用。

### 3.2 编排逻辑迁移（核心设计决策）

现状 `applyWorkCycle` 的三步编排在 `ui/server/discovery-plans.js:111-148`。**迁移到网关侧**，封装为 `always_on_apply_cycle`，UI 不再承担状态机：

```ts
// src/gateway/client/InProcessGateway.ts（新增）
async alwaysOnApplyCycle(input: AlwaysOnApplyCycleInput): Promise<AlwaysOnApplyCycleResult> {
  const service = this.options.discoveryPlanService;
  if (!service || !this.options.alwaysOnApply) {
    return { cycle: null, error: { code: "not_configured", message: "Always-On apply is not configured." } };
  }
  const { cycle, projectRoot, executionToken } = await service.queueCycleApply(
    input.projectName, input.workCycleId,
  );
  const applyResult = await this.options.alwaysOnApply({
    projectKey: projectRoot, workCycleId: input.workCycleId, projectName: input.projectName,
  });
  if (applyResult.error) {
    await service.updateCycleExecution(input.projectName, input.workCycleId, {
      status: "failed", executionToken,
    });
    return { cycle, error: applyResult.error };
  }
  const finalResult = await service.updateCycleExecution(input.projectName, input.workCycleId, {
    status: "completed", executionSessionId: applyResult.sessionKey, executionToken,
  });
  return { cycle: finalResult.cycle, sessionKey: applyResult.sessionKey };
}
```

### 3.3 协议类型定义（`src/gateway/protocol/types.ts`）

```ts
export type AlwaysOnListPlansInput = { projectName: string };
export type AlwaysOnListPlansResult = { plans: WebPlanOverview[] };   // 复用 always-on/web 的 WebPlanRecord 派生类型

export type AlwaysOnReadReportInput = { projectName: string; planId: string };
export type AlwaysOnReadReportResult = { content: string };

export type AlwaysOnListCyclesInput = { projectName: string };
export type AlwaysOnListCyclesResult = { cycles: WebCycleRecord[] };

export type AlwaysOnArchiveCycleInput = { projectName: string; cycleId: string };
export type AlwaysOnArchiveCycleResult = { archived: boolean };

export type AlwaysOnApplyCycleInput = { projectName: string; workCycleId: string };
export type AlwaysOnApplyCycleResult = {
  cycle: WebCycleRecord | null;
  sessionKey?: string;
  error?: { code: string; message: string };
};

// Gateway 接口新增（可选，feature-detect 风格，同 skill*/alwaysOn*）
alwaysOnListPlans?(input: AlwaysOnListPlansInput): Promise<AlwaysOnListPlansResult>;
alwaysOnReadReport?(input: AlwaysOnReadReportInput): Promise<AlwaysOnReadReportResult>;
alwaysOnListCycles?(input: AlwaysOnListCyclesInput): Promise<AlwaysOnListCyclesResult>;
alwaysOnArchiveCycle?(input: AlwaysOnArchiveCycleInput): Promise<AlwaysOnArchiveCycleResult>;
alwaysOnApplyCycle?(input: AlwaysOnApplyCycleInput): Promise<AlwaysOnApplyCycleResult>;
```

### 3.4 文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/gateway/protocol/types.ts` | 新增 3.3 全部类型 + Gateway 接口 5 个可选方法 |
| `src/gateway/protocol/frames.ts` | `WsGatewayMethod` 追加 5 个方法名 |
| `src/gateway/protocol/version.ts` | `SATI_GATEWAY_PROTOCOL_VERSION` → `"1.1"`（附变更注释） |
| `src/gateway/client/InProcessGateway.ts` | 5 个方法实现 + `setAlwaysOnListPlans` 等注入（options 增加 `discoveryPlanService?` 与各 handler）；apply_cycle 编排见 3.2 |
| `src/gateway/client/RemoteGateway.ts` | 5 个 `client.request(...)` 封装 |
| `src/gateway/server/GatewayWsConnection.ts` | 5 个 case 分发，未配置返回 `not_configured`（对齐 `always_on_apply` 写法 L257-265） |
| `src/always-on/web/service-factory.ts`（新增） | 把 `ui/server/discovery-plans.js:33-62` 的 DI 装配迁移为 TS 工厂 `createDiscoveryPlanService(pilotHome, io?)`，含 run-history/run-logs/pilotPaths 等 JS 依赖的类型化接口收口 |
| `src/cli/createLocalGateway.ts` | 组装 factory，注入 InProcessGateway（含 apply handler 复用） |
| `src/gateway/index.ts` | barrel 导出新类型 |
| `src/always-on/index.ts` | 导出 factory 与 WebPlanOverview 类型 |
| 前端（P2）：`ui/src/utils/api.js` + `AlwaysOnDashboard.tsx` / `RunDetail.tsx` | 数据源切换为 gateway 方法（若前端 ws 客户端 `src/web/client/GatewayBrowserClient.ts` 可被组件直接使用则直连，否则新增 `gatewayRequest` 帮助函数） |
| 退役（P3）：`ui/server/discovery-plans.js`、`routes/projects.js` 对应 handler | 删除或降级为 410 |

---

## 4. 分阶段实施

| Phase | 内容 | 交付 | 验证 |
|---|---|---|---|
| **P0** ✅ 已完成（2026-08-05） | `service-factory.ts` 迁移 DI 装配 + WebPlanOverview 类型导出 | TS 工厂取代 JS 装配 | 既有 24 用例不回归 + `tsc --noEmit` |
| **P1** ✅ 已完成（2026-08-05） | 协议类型 / frames / version 1.1 / Gateway 接口 / InProcessGateway / RemoteGateway / WsConnection 分发 + 单测 | 5 个方法端到端可调 | 新增 `tests/gateway/discovery-protocol.spec.ts`（帧往返 + not_configured） |
| **P2** ✅ 已完成（2026-08-05，直接切换） | 前端数据源切换（直接切换，无灰度） | 前端 REST 不变；ui/server 改为 gateway 代理，discovery 业务收敛到核心 | 47 用例全绿 + `tsc --noEmit` + biome/eslint 通过 |
| **P3** ✅ 已完成（2026-08-05） | 退役 discovery-context 端点与剩余直连，ui/server 收敛 | discovery 链路零 ui/server 直连依赖（`discovery-plans.js` / `routes/projects.js` 均无 `src/` import） | 47 用例全绿 + biome/node --check 通过 |

依赖关系：P1 依赖 P0；P2 依赖 P1；P3 依赖 P2。建议顺序 P0 → P1 → P2 → P3。

---

## 5. 测试计划

| 测试文件 | 覆盖 |
|---|---|
| `tests/always-on/web/DiscoveryPlanService.spec.ts`（已交付） | 24 用例：归一化 / overview / report / archive / queue / update |
| `tests/gateway/discovery-protocol.spec.ts`（P1 新增） | 帧方法名白名单；InProcessGateway 对 5 个方法的注入与 not_configured 兜底；apply_cycle 编排（queue→apply→finalize、apply 失败回滚 status=failed）；RemoteGateway 请求封装 |
| `tests/gateway/GatewayWsConnection.spec.ts`（P1 补充） | 5 个 case 分发到 gateway 方法 |

验收命令（串行，避免测试基建竞态）：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && cd ui && pnpm test`。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| InProcessGateway 注入 `DiscoveryPlanService` 引入 ui/server 未有的依赖（run-history/run-logs/pilotPaths 均为 JS） | P0 的 factory 把这批 JS 依赖类型化收口（定义最小接口 + adapter），不要求 JS 层先迁移 |
| 前端 ws 直连能力不足（认证/重连/事件流） | P2 先走"api.js 新增 gateway 方法包装"双轨，成熟后再移除 REST；不阻塞 P1 |
| apply 编排迁移改变失败语义 | 测试覆盖 apply 失败回滚路径；错误码沿用 `not_configured` / 业务错误码 |
| `always_on_apply` 已有 RemoteGateway 调用方（cli/tui） | 仅新增方法，不动既有语义；`always_on_apply_cycle` 是组合入口 |
| 协议版本 1.0 客户端连 1.1 服务端 | 可选方法 + feature-detect（见版本化草案），无需强制升级 |

---

## 7. 不做（本期明确排除）

- ~~`discovery-context` 聚合的 gateway 化~~ —— P3 已确认该端点前端无调用（死代码），已直接退役删除，无需 gateway 化
- `always_on_rerun_plan` 语义调整
- ui/server 其他领域（projects/memory/cron）的 gateway 化——本计划仅试点 discovery 链路
- 前端 ws 客户端基建重构（GatewayBrowserClient 改造）——P2 视需要单独立项

---

## 8. 后续工作项清单（2026-08-05 归档）

### 已完成

| # | 工作项 | 状态 | 备注 |
|---|---|---|---|
| ② | run-logs 收敛 | ✅ | 审计发现 `ui/server/services/always-on-run-logs.js` 与 `always-on-run-history.js` 在 P2 代理化后已无任何调用方，**直接删除**（非迁移）；`discoveryIo.ts` 内联实现成为唯一实现 |
| ③ | 边界检查 S1 | ✅ | `ui/eslint.config.js` 启用 `import-x/no-restricted-paths`；完整盘点（含三层相对路径）共 **17 处 / 8 文件** 进入白名单；规则已实证拦截新增违规（捕获了 routes/memory.js 的三层路径 import）；顺手清理 skills.js 无用 disable 指令 |

### ① 浏览器直连 gateway（进行中：已选路线 A，P0 完成）

**决策（2026-08-05）**：采用**路线 A（激活 Web 协议层）**——理由：复用既有 `GatewayBrowserClient`，不引入平行客户端实现，维护成本最低。

**已核实事实**：
- `GatewayBrowserClient`（`src/web/client/`，Web 协议 `WebGatewayMethod`）**原无服务端**——`rename_session` / `delete_session` 等 Web 特有方法在 `GatewayWsConnection` 中无 case，属未激活备件；
- gateway 端点：`ws://127.0.0.1:19789/ws`（Node 协议）；认证 token：`~/.sati/server-token`（ui/server 进程可读并下发）；
- 前端无法直接 import `src/`（CLAUDE.md 边界 + ui 独立 package）。

**P0 已完成（2026-08-05）**：
- 协议协商：`version.ts` 新增 `isProtocolCompatible`（MAJOR 匹配），`GatewayWsConnection.handleHello` 改用之——Web 客户端 1.0 与 Node 客户端 1.1 同 MAJOR 可连接（`tests/gateway/protocol-versioning.spec.ts` 7 用例）；
- 前端接入：`@sati/web-client` vite alias + tsconfig paths（唯一豁免，CLAUDE.md 已注明）；`GatewayBrowserClient` 经 alias 可用（`ui/src/utils/gatewayClient.test.ts` 2 用例验证握手/请求往返）；
- token 通道：`sati-bridge.js` 导出 `readGatewayToken`，`/api/auth/gateway-token` 端点颁发 `~/.sati/server-token`。

**P1 已完成（2026-08-05）——只读方法试点迁移**：
- Web 协议镜像同步：`src/web/client/protocol.ts` 的 `WebGatewayMethod` 追加 5 个 `always_on_*` 方法 + 宽松 DTO（`WebAlwaysOnWebPlan` / `WebAlwaysOnCycle` 等），`index.ts` 导出类型；
- 前端 ws 请求层：`ui/src/utils/api.js` 新增 `getGatewayClient` 单例（`/api/auth/gateway-token` 领 token → `GatewayBrowserClient` 连接）、`resolveProjectKeyByName`（`list_projects` 显示名 → `fullPath` 映射，解决 core io 显示名解析缺口）、`resetGatewayClient`；
- 试点方法 `gatewayListPlans`：ws 直连 `always_on_list_plans`，**失败自动降级 REST**（双轨）；`RunDetail.tsx` 的 plans 加载已切换；
- 测试：`ui/src/utils/gatewayListPlans.test.ts` 7 用例（映射 + ws 成功路径 + token 404 降级 + 方法 error 降级）、`gatewayClient.test.ts` 2 用例；ui 全量 459/459、后端 54/54 通过。

**剩余阶段（P2–P3）**：
- P2：聊天链路迁移（`submit_turn` 流式事件，风险最高，需事件订阅 + 重连语义）；
- P3：REST 端点按方法逐批退役，`ui/server` 收敛为静态服务 + 认证；`@sati/web-client` 白名单豁免随 REST 退役而收口。

**与边界检查（③）的联动**：浏览器直连落地后，`ui/server` 对 `src/` 的 17 处白名单 import 可随 REST 退役逐项摘除，最终白名单归零（S3）。
