# Router 模块文档

本目录用于管理 PilotDeck 中 `router` 模块相关文档。`router` 在新项目中暂未独立成模块，但旧项目 `third-party/claude-code-main` 已经把它作为完整子系统沉淀（CCR — Claude Code Router）。本文档集对照旧实现，给出新项目的产品定义、重写方案和测试方案。

## 文档结构

1. `[01-product-specification.md](./01-product-specification.md)`
  对照旧项目 CCR 模块，从产品视角定义 router 子系统的能力边界、运行对象、配置结构和事件规范，类似 PRD / 功能文档。
2. `[02-rewrite-plan.md](./02-rewrite-plan.md)`
  结合产品规格和新项目 `src/` 现状，给出 PilotDeck `router` 模块的重写方案：目标架构、模块切分、与 `model` / `agent` / `pilot/config` / `gateway` 的集成方式、命名迁移、阶段计划与风险点。
3. `[03-testing-guide.md](./03-testing-guide.md)`
  定义 PilotDeck `router` 单元测试、运行时测试和双边 parity 测试如何编写：测试目录、命名、fake transport / fake judge 用法，以及如何在相同输入下让旧 CCR 实现和新 PilotDeck `router` 实现产出可比对的结果。

## 阅读顺序

1. 先阅读 `[01-product-specification.md](./01-product-specification.md)`，理解 router 的产品能力、配置形态、路由场景和与 model 模块的边界。
2. 再阅读 `[02-rewrite-plan.md](./02-rewrite-plan.md)`，对照 `src/model/` / `src/agent/` / `src/pilot/config/` / `src/gateway/` 的当前实现，理解 router 在 PilotDeck 中应该落到哪些目录、暴露哪些接口。
3. 最后阅读 `[03-testing-guide.md](./03-testing-guide.md)`，理解 router 测试如何分层、如何写 parity scenario、如何同时驱动旧项目和新项目验证一致性。

## 与其他模块的关系

- `[../model/](../model/)`：router 在请求送出前可能会改写 `req.body.model`，但实际把请求送到上游 provider 的部分应当复用 `src/model/` 的 protocol、capabilities 和 transport，而不是再实现一套 fetch / SSE 解析。
- `[../pilot-config/](../pilot-config/)`：router 的多 provider、tier 路由、fallback、token 统计等配置必须收敛到 `~/.pilotdeck/pilotdeck.yaml` 的 `model` 段或新增 `router` 段，由 `pilot/config` 模块统一加载和热重载。
- `[../rewrite-plan/](../rewrite-plan/)`：router 是 PilotDeck 整体重写方案的一部分，但因为旧项目把它当成独立子系统（带 Fastify server、CLI、build 脚本、preset marketplace 等），单独成册便于专项跟进。
- `[../pilotdeck-adapter-refactor-development-guide.md](../pilotdeck-adapter-refactor-development-guide.md)`：旧项目允许通过 HTTP server 形态把 router 暴露给外部 Claude Code CLI，新项目第一版以 in-process 形式接入 `agent` / `gateway`，对外 HTTP 兼容形态作为可选 adapter。

## 目录原则

- 只描述 router 模块本身，不复述 model / agent / context / tool 的协议细节。
- 旧项目 CCR 的能力以“产品行为基线”形式整理，不要求新项目逐文件复制。
- 双边 parity 测试只为了证明新实现和旧实现在相同输入下行为一致，不把旧源码作为新项目运行时依赖。
