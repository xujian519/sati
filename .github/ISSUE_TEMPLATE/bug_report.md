---
name: Bug 报告
about: 报告一个可复现的问题，帮助我们定位并修复
title: "bug: "
labels: ["bug"]
assignees: ""
---

## 问题描述

<!-- 简洁清晰地说明你看到的现象与预期行为 -->

## 复现步骤

1. 步骤一
2. 步骤二
3. 步骤三

## 预期行为

<!-- 你期望发生什么 -->

## 实际行为

<!-- 实际发生了什么，可附报错原文 -->

## 影响 scope

<!-- 勾选受影响模块（与提交 scope 对齐），如不确定可不选 -->

- [ ] agent
- [ ] ui
- [ ] gateway
- [ ] memory
- [ ] router
- [ ] cli
- [ ] mcp
- [ ] always-on
- [ ] tool
- [ ] knowledge
- [ ] patent
- [ ] model
- [ ] literature
- [ ] cron
- [ ] rule
- [ ] 其他: <!-- 填写 -->

## 契约影响（重要）

<!-- 以下改动会触发特殊门禁，务必如实勾选，否则 CI 会在合并前失败 -->

- [ ] 工具 `inputSchema`（含描述文本）→ 需重录 llm-replay fixture（`pnpm record:replay`）
- [ ] `AgentEvent` / gateway frames → 需重新生成事件矩阵（`pnpm gen:event-matrix` 使 `check:event-matrix` 保持 green）
- [ ] 网关协议变更 → 需按 MAJOR/MINOR 版本化（`src/gateway/protocol/version.ts`）
- [ ] 不涉及上述契约

## 环境

- 版本 / 分支: <!-- 如 0.1.0 / main -->
- Node.js: <!-- 22.x -->
- pnpm: <!-- 10.x -->
- OS: <!-- macOS / Windows / Linux -->

## 日志 / 截图

<!-- 粘贴相关日志或截图；UI 问题建议附上主题、语言、视口信息 -->

## 额外信息

<!-- 任何有助于定位的信息 -->
