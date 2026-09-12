# Agent Note: ProjectRuntimeRegistry 独立成模块（P4a 第二刀）

Status: implemented

## Problem

P4a 第一刀已把 `createLocalGateway.ts` 的模块级 helper 按子系统外置（2730 → 2481 行），但该文件仍是"三件无关架构钉合"：CLI 引导工厂 + **1456 行的 `ProjectRuntimeRegistry` 类** + 少量自由函数。文件级 seam 不存在——读组合根必须先翻过整张类，改类也必然在同一文件里与工厂互相踩行号（第一刀里 `handleExtensionWatchEvent` 就被迫留在原文件，只因为它引用该类类型）。

按 builder 直接切分类方法（`prepareSessionRuntime` 537 行 / `createAgentConfig` 127 行）之前，需要先建立**文件级边界**：类与组合根分属两个模块，后续每刀才有稳定的落点。

## Decision

把 `class ProjectRuntimeRegistry` 连同其私有类型与仅类内使用的常量/logger **逐字迁出**到新模块 `src/cli/ProjectRuntimeRegistry.ts`：

| 迁移单元 | 说明 |
|---|---|
| `class ProjectRuntimeRegistry` | 59 207 字符主体，逐字节一致（仅新增 1 个 `export` 关键字） |
| `type ProjectRuntimeRegistryOptions` / `type ProjectRuntime` | 仅该类使用，随类走 |
| `TASK_RESUME_SCAN_DELAY_MS` / `ROUTER_EVENT_FLUSH_INTERVAL_MS` | 仅类内使用，随类走 |
| `patentOutputGateLogger` / `ruleOutputGateLogger` | 仅类内使用，随类走 |

结果：`createLocalGateway.ts` **2449 → 804 行**（−1645）；新模块 1664 行。

**组合根保留了 `handleExtensionWatchEvent`**（它引用类类型），现在通过 `import { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.js"` 解析——依赖方向变成单向 `createLocalGateway → ProjectRuntimeRegistry`，第一刀里那个"类型引用导致无法外置"的约束随之消解。

迁移方式不是手抄，而是 AST 脚本：用 TypeScript 编译器 API 解析基线文件，识别被搬运的节点、收集搬移文本里的标识符引用，再**反查原文件的 import 绑定**（保留 `import type` / 内联 `type` / `as` 别名 / default / namespace 五种形态）生成新模块的 import 块；同时按"剩余文本的实际使用集合"裁剪原文件的 import。唯一的人工改动是给类加 `export`。

## Alternatives considered

- **直接按 gateway / agent / tool / always-on 拆 4 个 builder（P4a 目标形态）** — 落选：类方法大量直读实例状态（`sessionMcpRuntimes` / `_sessionOverrides` / `_teamDb` / `policyDenyRules` / `runtimes` 缓存），在类仍与工厂同文件时动它们是"两个维度同时变"；先把类挪进独立文件，builder 化就有单一落点，每刀可独立验证。
- **手抄搬迁（复制粘贴 + 让 tsc 报错补 import）** — 落选：第一刀的教训是"逐字"必须机械可验。AST 方案产出可对照基线做逐字节断言（59 207 字符全等），手抄做不到；且手抄时 12 条被裁剪的 import 全靠肉眼，遗漏只在运行期暴露。
- **保留类在原文件、只把工厂函数挪出** — 落选：类引用工厂侧的 logger 与常量更多，反向更复杂；且类占文件 60%，挪类才是收益所在。
- **顺带把两个私有类型导出（供后续 builder 用）** — 落选：当前无外部使用者，提前导出等于凭空扩大契约面；需要时一行即可。
- **顺带在类内把 `prepareSessionRuntime`（537 行）分段** — 落选：同一 PR 做两件不同粒度的事会让"行为不变"的验证面翻倍；分段留给第三刀，届时类文件已独立。

## Consequences

- 组合根文件从 2449 → 804 行，**逼近 P4a 的 ≤600 目标**（余下主要是工厂编排与 extension-watch 回调）；类文件 1664 行获得独立边界。
- **事件矩阵已重生成**（`pnpm gen:event-matrix`，`docs/event-producer-consumer.md` 5 处 `file:line` 漂移随本 PR 提交）——AGENTS 铁律 5 与「关键环境事实」第 2 条。
- 验证证据：类主体与基线**逐字节一致**（59 207 字符，仅多 `export` 一个 token）；两个 logger / 两个类型 / 两个常量逐字一致；`pnpm check` 全绿；`pnpm test` 全绿（0 失败）。
- 两处行为不变的护栏：① `buildBrowserUseArgs` 的兼容再导出从"夹在 import 之间"移到 import 块末尾，`tests/gateway/browser-use-args.spec.ts` 仍从原文件导入（零测试改动）；② `handleExtensionWatchEvent` 的类型参数改用新模块导入的类，逻辑未动。
- P4a 剩余步骤：第三刀按 builder 拆 `ProjectRuntimeRegistry`（对象：`prepareSessionRuntime` 537 行、`createAgentConfig` 127 行、`resolve` 249 行），并收口组合根的 ≤600 行；已登记在 `docs/architecture-fix-plan.md`。
