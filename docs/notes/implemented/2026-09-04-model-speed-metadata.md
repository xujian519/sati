# Agent Note: 模型速度档元数据（speed tier）

Status: implemented

## Problem

`resolveModelInfo` 能力解析只有工具/流式/多模态维度，无速度档信息。智能路由（`src/router/`）与 UI 模型选择缺少"交互延迟敏感 vs 推理增强"的静态参考维度，无法按场景偏好选型（如交互问答偏好 fast、深度分析偏好 deep）。移植自 PilotDeck `desktop-v2026.09.02` #524（`speedMapping.ts`）。

## Decision

三档静态元数据（非实测吞吐）：`fast`（交互延迟敏感）/ `balanced`（均衡）/ `deep`（推理增强、质量优先）。

- `src/model/protocol/capabilities.ts`：导出 `ModelSpeed` 类型；
- `src/model/catalog/speedMapping.ts`：`inferModelSpeed(modelId, entrySpeed?)`——catalog 条目显式 `speed` 优先，否则命名规则推断（deep 优先于 fast：`o\d/max/pro/opus/reasoning|reasoner/thinking/-r\d/ultra` → deep；`mini/flash/lite/turbo/haiku/highspeed/-air/flashx/instant/nano` → fast；其余 balanced）。品牌名误伤已处理：`(?<!mini)max` 与 `mini(?!max)` 排除 MiniMax 两段；
- `CatalogModelEntry.speed?`：显式覆盖入口（不规则命名模型用，当前无需覆盖条目）；
- `resolveModelInfo`：`ResolvedModelInfo` 新增必填 `speed`，三层解析（config/catalog/default）统一经 `catalogModelSpeed`（catalog 显式 > 规则）或裸 `inferModelSpeed` 透出——speed 是模型固有属性，与配置声明无关。

内置 65 模型分档结果：fast 26（haiku/mini/flash/turbo/lite/highspeed/air/flashx 系）、balanced 35（sonnet/标准旗舰/plus/MiniMax 基础系）、deep 24（opus/o 系/max/pro/reasoner/r1 系）。

**消费方（路由 speed-aware 打分、模型池 UI 展示）本 PR 不接线**：元数据先行落地，路由消费待场景打分设计（见 Alternatives）。

## Alternatives considered

- **catalog 65 个模型逐条手写 speed 字段** — 落选：评审负担大、新模型必漏；规则 + 覆盖表（上游同方案）覆盖全部且维护成本 O(1)。
- **实测 tokens/s 数据入 catalog** — 落选：静态资产放实测值必然过期；三档语义（选型参考）比精确值更稳，实测留遥测层。
- **speed 并入 ModelCapabilities** — 落选：capabilities 是协议能力（可被 config 局部覆盖合并），speed 是 catalog 静态维度、无合并语义；并排导出避免污染 merge 逻辑。
- **本 PR 一并接线路由 speed-aware 场景打分** — 落选：路由打分权重是产品决策（交互场景偏好 fast 的权重多少），需独立设计 + 回归；元数据先行让后续接线是纯增量。
