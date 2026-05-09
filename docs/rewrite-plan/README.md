# 新项目产品与重写方案

本目录用于存放新项目相关文档，包括产品规格、能力边界、重写建议和总体方案。

## 文档结构

1. `[01-product-specification.md](./01-product-specification.md)`
  从产品角度定义新项目应提供的用户能力、运行时对象、事件规范和非功能要求。
2. `[02-rewrite-project-report.md](./02-rewrite-project-report.md)`
  给出新项目重写总方案、目标架构、模块职责、技术建议和风险判断。

## 与现状分析的关系

本目录中的方案以 `[../current-agent-loop-analysis/](../current-agent-loop-analysis/)` 的现状分析为依据，但不复述当前项目源码细节。

与 `pilot/config` 模块相关的细化设计见 `[../pilot-config/](../pilot-config/)`。

与 `model` 模块相关的细化设计见 `[../model/](../model/)`。