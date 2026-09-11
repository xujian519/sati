# Sati 技术债务活账本

> 定位：Sati 技术债务与异味代码的**唯一事实源**（活账单）。取代会过时的快照式报告（如 `docs/technical-debt-report.md`、`docs/code-refinement-report.md`）。
>
> 用法：审计时在 `backlog.md` 登记/更新条目；每季度（或大版本）跑 `node scripts/measure-techdebt.mjs --update docs/technical-debt/metrics.md` 刷新指标趋势；修复完更新条目状态与指标。

> **审计状态（2026-08-23）**：全仓库逐模块扫描完成（B1 agent/router/tool/gateway/session · B2 context/model/patent · B3 adapters/always-on/knowledge/mcp/rule/workflow · B4 小模块 · B5 ui/ui-server/tests+scripts/desktop · B6 横切收口）。`backlog.md` 共 **199 条**带证据条目，修复排期见 §29 横切收口 C 节。

## 目录

| 文件 | 内容 |
|---|---|
| `backlog.md` | 债务清单（活账本），按模块分节，每条含严重级/位置/影响/建议/状态 |
| `metrics.md` | 可复现指标基线与趋势（由 `scripts/measure-techdebt.mjs` 生成） |
| `next-batches-schedule.md` | 后续批次专项排期建议（阶段化顺序、爆炸半径、浏览器验证、硬截止） |
| `README.md` | 本文件：方法论、清分级规则、如何保持新鲜 |

## 审计方法论

**广度自动化 + 深度人工 双轨**。每类债务都必须给可复现命令与证据，不凭感觉下结论。

### 类别与检测手段

| 代码 | 类别 | 检测手段 |
|---|---|---|
| A | 体积/复杂度 | `wc -l` Top 文件；TS AST 单函数 > 阈值；平均行/函数 |
| B | 类型安全 | 类型位 `any`（TS AST）/ `@ts-expect-error` / `@ts-ignore` 按模块聚合 |
| C | 错误 & 可观测 | 裸 `console.*`、空 `catch {}`、无参 `catch {}`（区分总数与**无注释隐患类**）、`TODO` |
| D | 架构/分层 | `ui/server→src` 深层导入、`src→ui`、循环依赖、protocol/runtime/config 三层符合度 |
| E | 测试 | 模块测试分布、主链路文件无直接单测、伪测试（`readFileSync`+正则扫源码） |
| F | 死代码/重复 | codegraph 可达性找未引用导出、品牌残留、同能力多套实现 |
| G | 依赖/安全 | `pnpm audit`、override 冗余、版本并存 |
| H | 文档漂移 | CLAUDE.md 声明 vs 实际、i18n en/zh-CN key 对齐、注释引用已删代码 |
| I | 性能 | 巨型组件、未虚拟化列表、每轮重复构建/未缓存检索、UI chunk 体积 |

### 复现命令

```bash
# 全量指标（JSON）
node scripts/measure-techdebt.mjs --json

# 刷新指标文档（记录历史趋势）
node scripts/measure-techdebt.mjs --update docs/technical-debt/metrics.md

# 依赖安全（可选，需 registry 可达）
pnpm audit --registry https://registry.npmjs.org/

# 静态门禁
pnpm typecheck && pnpm lint && pnpm format:check
```

### 指标口径说明（重要）

> **2026-09-11（C42 终审）口径已对齐**：此前所有指标一律只扫 `src/`，与 `docs/code-refinement-plan.md` §六 基线表声明的 `src + ui/src` / `src + ui/server` 不一致——C40/C41 两张横切卡都不得不先自建扫描重建口径才能定目标（见 C41 note「遗留口径问题」）。现已按基线表对齐，`metrics.md` 顶部输出「指标口径」表，`--json` 亦可读出 `scopes` 字段。**跨 2026-09-11 的同比须按同一口径重算。**

- **`any` 指标已从裸正则改为 TS AST 精确统计**（`scanTypeEscapes`）：旧正则 `: any | as any | <any> | any[]` 两个方向都不准——**高估**（注释/字符串里的英文单词 "any"，如 `SnipEngine.ts:64` 的 "any tool_call"）且**低估**（泛型位 `Record<string, any>` 文本不含 `: any`，被漏掉）。现在只统计真正的类型位 `AnyKeyword` 节点 + `@ts-expect-error`/`@ts-ignore` 指令，`src + ui/src` 实测 **3 处**，与 C40 逐处 `SAFETY` 登记的保留清单完全一致（互为交叉验证）。真正的类型债仍是强转与断言（`as never`/`as unknown as X`/`as string[]`/`!`，见 `backlog.md` TD-TYPE-002）。
- **无参 `catch {`** 拆成两个数：**总计**（未绑定错误变量；仓内 try 体几乎全是 `JSON.parse`/`fs.*`/`new URL`，删 try 会改变行为，故该计数在行为不变前提下不可降）与 **无注释**（隐患类，唯二治理目标）。判定「有注释」认三种形态：catch 行内、catch 上一行、体内（独立注释行或代码行尾注释）。
- 旧版「静默吞错 catch（体仅注释/空白）」指标**已废弃**：它把**已在函数 JSDoc 说明意图的防御式**与真无说明的静默回退混计（C41 发现并修正）。无参 catch 的意图注释形态统一为「失败模式 → 回退语义」。
- **裸 `console.*` 仍是正则上界**：会把**注释掉的**调用计入（如 `ui/server/sessionManager.js` 5 处 `// console.error(...)`）；C39 刻意建立的两处收束入口（`ui/server/utils/consoleLogger.js`、`ui/src/utils/logging.ts`）已豁免。收束后 `src/` 真实裸调用 143 处全部按设计豁免（CLI 交互/二维码/`debug.ts`/telemetry 入口）。
- i18n / 测试覆盖 / 分层边界为精确值，可直接使用。

## 严重级定义

| 级别 | 含义 | 处置 |
|---|---|---|
| P0 | 堵塞：阻塞合入、可致错误决策或数据损坏 | 立即 |
| P1 | 高：主链路性能/可维护性明显受损 | 短期排期 |
| P2 | 中：局部可维护性/可观测性受损 | 按 Sprint 排期 |
| P3 | 低：风格/文档/次要卫生 | 顺手清理 |

## 工作量定义

`S` ≤ 半天 · `M` 1–2 天 · `L` > 2 天（专项，需单独排期）

## 状态机

`new` → `triaged`（已复核/分级）→ `in_progress` → `done` / `wontfix`

- `done`：附对应 commit/PR。
- `wontfix`：写明理由；若属设计使然（非缺陷），按 AGENTS.md 铁律 7 在 `docs/notes/` 记一条 decision note（含 `## Alternatives considered`）。

## 如何保持新鲜

1. 每季度或大版本重跑 `measure-techdebt.mjs --update` 更新趋势。
2. 新功能引入新债时顺手在 `backlog.md` 加一条（或触发一次测量对比）。
3. 修复项标注 `done` + commit/PR；指标随脚本复核回落。

## 边界与约束（审计时遵守）

- **只读登记**：审计只登记、不修改源码；避免破坏 llm-replay fixture（任何工具 inputSchema 改动含描述都会使 replay fixture 失配）。
- **内部文案**：新用户可见文案必须提取到 `ui/src/i18n/locales/{en,zh-CN}/`（AGENTS.md 铁律 4）；审计只登记缺失，不擅自补译文。
- **安全项**：既有设计（令牌比较非常时、WS 无 Origin 校验等）只登记风险与决策，不改行为。
