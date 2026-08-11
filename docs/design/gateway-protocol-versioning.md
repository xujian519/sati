# Gateway 协议版本化与 ui/server 边界检查 — 落地草案

- 状态：**Part A 已实施**（2026-08-05，协议 1.1 上线：`version.ts` 维护变更表 + hello MAJOR 协商 `isProtocolCompatible` + 新增可选 discovery-plan 方法；2026-08-11 协议 1.2 追加 output-gate HITL approval 方法）；**Part B 进行中**（S1 冻结增量已落地：`ui/eslint.config.js` 配置 `import-x/no-restricted-paths` 白名单；S2 逐个收敛、S3 归零、S4 最终态待排期）
- 日期：2026-08-05
- 关联：`docs/design/gateway-discovery-plans.md`（首个按本规范实施的协议扩展）
- 约束来源：`CLAUDE.md`"网关协议：前后端通过 gateway WebSocket 帧通信（WsRequestFrame/WsResponseFrame），改协议需版本化"

---

## 实施状态速览（2026-08 对照代码）

| 条目 | 状态 | 代码位置 |
|------|------|---------|
| 版本常量 + 变更表 | ✅ 已实施 | `src/gateway/protocol/version.ts`（`SATI_GATEWAY_PROTOCOL_VERSION = "1.1"`，变更表注释 1.0 → 1.1） |
| MAJOR 握手协商（`protocol_mismatch`） | ✅ 已实施 | `src/gateway/server/GatewayWsConnection.ts` + `isProtocolCompatible`（Web 镜像 `SATI_GATEWAY_PROTOCOL_VERSION_WEB = "1.0"`，同 MAJOR 可连） |
| 可选方法 feature-detect（`not_configured`） | ✅ 已实施 | `GatewayWsConnection.ts` always_on_* / skill_* 分支 |
| Part B S1 冻结增量（ESLint 白名单） | ✅ 已落地 | `ui/eslint.config.js` `import-x/no-restricted-paths` |
| Part B S2–S4 收敛归零 | ⏳ 待排期 | `ui/server` 仍存在对 `src/` 的深层导入 |

## Part A：Gateway 协议版本化

### A1. 现状与问题

- `src/gateway/protocol/version.ts` 仅一行 `export const SATI_GATEWAY_PROTOCOL_VERSION = "1.0"`，无版本语义、无变更记录。
- `WsHelloFrame` 携带客户端 `protocolVersion`，`WsHelloOk` 返回服务端 `protocolVersion`，但**握手后没有任何版本协商/拒绝逻辑**（见 `GatewayWsConnection.ts` hello 处理）。
- 新增方法（如 skill_*、always_on_*）无版本登记，靠"可选方法 + not_configured"特性检测兜底——实践好，但无文档沉淀。
- 改动散落：`frames.ts`（方法名）、`types.ts`（输入/输出/接口）、`InProcessGateway.ts`、`RemoteGateway.ts`、`GatewayWsConnection.ts` 五处需同步，无 checklist 易漏。

### A2. 版本语义（采用 MAJOR.MINOR）

| 段 | 触发条件 | 示例 |
|---|---|---|
| MAJOR | 帧结构变化；既有方法语义不兼容；移除/重命名方法；事件帧字段破坏性变更 | 1.x → 2.0 |
| MINOR | 新增可选方法；新增事件类型；既有方法放宽输入（仅加可选字段）；错误码新增 | 1.0 → 1.1 |

规则：
1. **方法向后兼容**：新增方法一律声明为可选（`?`），客户端 feature-detect；服务端对未实现方法返回 `{ code: "not_configured" }`（已实践，见 `GatewayWsConnection.ts` skill_*/always_on_* 分支）。
2. **握手协商**：
   - 客户端 MAJOR == 服务端 MAJOR → 允许连接（MINOR 差异仅表示能力差异，可选方法按需探测）；
   - 客户端 MAJOR != 服务端 MAJOR → `hello_ok` 拒绝并返回明确错误码 `protocol_mismatch`（服务端可附带 `serverVersion` 供升级提示）。当前实现无此分支，需在 P1 补。
3. **变更流程**（新增/修改协议方法必经）：
   - 更新 `WsGatewayMethod`（frames.ts）→ 更新输入/输出类型 + `Gateway` 接口（types.ts）→ 实现 InProcessGateway → 封装 RemoteGateway → 分发 GatewayWsConnection → **bump MINOR**（version.ts 附注释：变更内容 + 日期 + 关联 PR）→ CHANGELOG 记录。
4. **版本记录**：version.ts 顶部维护一张简短变更表（版本号 / 内容 / 日期），替代散落的 git log 记忆。

### A3. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `src/gateway/protocol/version.ts` | 版本常量 + 变更表注释 + 新增 `MIN_GATEWAY_PROTOCOL_VERSION`（供协商比较） |
| `src/gateway/server/GatewayWsConnection.ts` | hello 分支：MAJOR 不匹配时拒绝（`protocol_mismatch`），补测试 |
| `src/gateway/protocol/index.ts` | 导出版本与协商辅助函数（`isProtocolCompatible`） |
| `tests/gateway/`（新增 `protocol-versioning.spec.ts`） | 版本比较；hello 协商分支；可选方法 feature-detect 语义 |
| `scripts/`（可选） | `check-protocol-version.mjs`：检测 protocol/ 目录变更时提示检查版本 bump（CI 软提示，不强制） |

### A4. 验收

- 新协议方法上线必须伴随 MINOR bump + 变更表条目（人工 checklist，后续可脚本化）；
- hello 协商测试覆盖 mismatch 拒绝路径。

---

## Part B：ui/server 边界检查

### B1. 现状与问题

- `ui/server/`（95 个文件手写 JS）**深层 import `src/` 内部实现** ≥10 处（已核实）：`discovery-plans.js:20-27`（DiscoveryPlanService/WorkspaceApply/DiscoveryStateStore）、`projects.js:26`（legacySessionPresentation）、`projects.js`（cron 类型）等。
- 违反 `CLAUDE.md`"`ui/` 通过 gateway API / WebSocket 通信，不得直接导入 `src/`"。
- 现状无任何机制阻止新增此类导入，债务只增不减；且 `src/index.ts` barrel **不存在**，无法用"只许走 barrel"的规则。

### B2. 目标与路线

**最终态**：`ui/server` 零 `src/` 导入（静态服务 + 认证 + 极薄转发），业务全部经 gateway 协议。

**过渡路线**（每阶段可独立落地）：

| 阶段 | 动作 | 检查手段 |
|---|---|---|
| **S1 冻结增量（立即）** | ESLint 配置 `no-restricted-paths`：禁止 `ui/server` → `src/` 任意文件，**白名单 = 现存 10 个导入文件** | `ui pnpm lint` 拦截新增违规 |
| **S2 逐个收敛** | 每个深层导入改为经 `src/` barrel 导出（随 gateway 化/工厂化推进，如 service-factory.ts、barrel 补导出）；收敛一个从白名单摘除一个 | lint + `grep -rn '\.\./\.\./src/' ui/server` 计数递减 |
| **S3 归零** | discovery 链路（见 gateway-discovery-plans.md）P3 退役后，白名单清空 | lint 规则升级为"禁一切 `src/` 导入" |
| **S4 最终态** | `ui/server` 收敛为静态服务；CLAUDE.md 边界声明与实际一致 | 全量回归 |

### B3. 落地配置（S1 具体做法）

`ui/eslint.config.js` 增补（项目已依赖 `eslint-plugin-import-x`）：

```js
{
  files: ["server/**/*.js", "server/**/*.mjs"],
  rules: {
    "import-x/no-restricted-paths": ["error", {
      zones: [{
        target: "./server",
        from: "../src",            // ui/server 禁止导入 ../../src/*
        except: [/* S1 白名单，如 "../../src/always-on/web/DiscoveryPlanService.js" */],
      }],
    }],
  },
}
```

注意：现有违规文件需先用 `// eslint-disable` 或**先纳入白名单**再逐步摘除，避免 S1 即全红。推荐：S1 用白名单模式落地，同时新增违规直接报错。

> 备选（不推荐为主力）：CI 脚本 `scripts/check-ui-server-boundary.mjs` 用 grep 校验 import 路径，作为 lint 的兜底与计数报表（S2 阶段做趋势统计）。

### B4. 前置条件

1. **建 `src/index.ts` barrel**（独立工作项）：26 个顶层模块当前仅 7 个符合分层规范；不要求一步到位——barrel 先覆盖 ui/server 实际消费的 API（always-on/web、web/server、cron/protocol、pilot 等），其余模块后续补充。**barrel 是"只许走 barrel"规则的最终形态**，S1 阶段可暂用白名单替代。
2. **CLAUDE.md 边界条款更新**：明确"禁止 ui/server 直接导入 src/ 内部文件；允许经 src/index.ts（barrel）或白名单过渡项"，与实现一致。

### B5. 验收

- S1：`cd ui && pnpm lint` 通过，且新增 `ui/server → src/` 导入被拦截；
- S2：`grep -rn '\.\./\.\./src/' ui/server` 计数逐步下降并有趋势记录；
- S3/S4：计数归零，lint 规则收紧为无白名单；`pnpm test` 全绿。

---

## 风险与注意事项

1. **S1 白名单是临时豁免**，需在代码中保留"待收敛"注释（`// TODO(server-boundary): migrate to gateway`），配合 S2 计数防止白名单永久化。
2. **barrel 建立与 ui/server 收敛互相依赖**：若 barrel 迟迟不建，"只许走 barrel"无法落地——建议把 `src/index.ts` 初版（覆盖 ui/server 消费面）列为独立小任务先行。
3. **协议 MINOR bump 不应阻塞发布**：可选方法向后兼容，1.0 客户端连 1.1 服务端必须正常工作；`protocol_mismatch` 只对 MAJOR 生效，避免误伤。
4. **本草案与 discovery 实施计划的联动**：discovery 计划 P0（service-factory）+ P3（退役中转）直接贡献 B2 的 S2/S3 收敛计数，两文档应同步评审、同步排期。
