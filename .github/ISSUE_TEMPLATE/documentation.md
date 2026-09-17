---
name: 文档问题
about: 报告文档缺失、过时、与实现不符，或规范自身漂移
title: "docs: "
labels: ["documentation"]
assignees: ""
---

## 问题描述

<!-- 哪份文档出了什么问题：缺失 / 过时 / 与实现不符 / 自相矛盾。
     若「文档说的」与「代码做的」不一致，请两处都给位置，便于判定改哪边 -->

## 位置

<!-- 文件路径 + 章节/行号，或链接。多处漂移请逐条列出 -->

## 复现步骤

<!-- 可选，但「可复现」的文档问题最容易核实。例：
     1. 读 docs/xxx.md §8
     2. 跑 `gh label list --limit 100 | wc -l` 并逐条对照 .github/labels.yml
     预期：两边一致；实际：§8 把已完成的步骤标成未完成 -->

## 预期行为

<!-- 文档应当怎么写（与什么保持一致） -->

## 实际行为

<!-- 现在是怎么写的、为什么误导；说清代价：谁会被它带错、要额外做什么核实 -->

## 影响 scope

<!-- 勾选受影响模块（列表与 scope:* 标签一一对应），如不确定可不选 -->

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
- [ ] desktop
- [ ] 其他: <!-- 填写 -->

## 额外信息

<!-- 修复建议、相关的决策记录（docs/notes/）、是否属「文档滞后」而非「实现有误」 -->

<!-- 注：本模板刻意不含「契约影响」节——文档议题本身不改变工具 inputSchema /
     事件面 / 网关协议。若某项文档改动**同时**要动这些契约（如重录 llm-replay
     fixture），请改用 feature_request 或 tech_debt 模板登记，让契约节被如实勾选。 -->
