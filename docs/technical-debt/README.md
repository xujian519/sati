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
| B | 类型安全 | `any` / `@ts-expect-error` / `@ts-ignore` 按模块聚合 |
| C | 错误 & 可观测 | 裸 `console.*`、空/无参 `catch {}`、静默吞错、`TODO` |
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

- **`any` 指标是裸正则的**上界**，非准确值**：`measure-techdebt.mjs` 用 `: any | as any | <any> | any[]` 匹配，会把注释/字符串里的英文单词 "any"（如 `SnipEngine.ts:64` 的 "any tool_call"）计入。2026-08-23 人工复核（B1+B2 六个模块）确认**全源码真实 `any` 逃逸 = 0**；真正的类型债是强转与断言（`as never`/`as unknown as X`/`as string[]`/`!`，见 `backlog.md` TD-TYPE-002）。
- **静默吞错 catch** 与 **无参 catch** 是两回事：前者=体仅注释/空白（真实隐患，151 处），后者=未绑定错误变量（395 处，部分有注释属防御式）。`metrics.md` 都单独列出。
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
