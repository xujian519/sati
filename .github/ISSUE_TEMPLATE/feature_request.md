---
name: 功能提案 / 改进
about: 提出一个新功能或对现有能力的改进建议，用于评审讨论
title: "feat: "
labels: ["enhancement"]
assignees: ""
---

## 价值与动机

<!-- 这个功能解决什么问题、服务于谁，能给用户/项目带来什么价值 -->
<!-- 一句话说清即可，展开讨论放在下方方案部分 -->

## 现状与痛点

<!-- 现在缺什么、为什么现有方案不够用 -->

## 期望方案

<!-- 你期望的行为 / 交互 / 界面形态，尽量给出具体描述 -->

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

<!-- 以下改动会触发特殊门禁，务必如实勾选 -->

- [ ] 工具 `inputSchema`（含描述文本）→ 需重录 llm-replay fixture（`pnpm record:replay`）
- [ ] `AgentEvent` / gateway frames → 需重新生成事件矩阵（`pnpm gen:event-matrix`）
- [ ] 网关协议变更 → 需按 MAJOR/MINOR 版本化（`src/gateway/protocol/version.ts`）
- [ ] 新增用户可见文案 → 需提取到 `ui/src/i18n/locales/{en,zh-CN}/` 对应 namespace
- [ ] UI 渲染变更 → 需按 CONTRIBUTING.md 完成视觉验证（双主题 / 双语言 / 状态 / 响应式）
- [ ] 不涉及上述契约

## 备选方案

<!-- 可选：非平凡变更按 docs/notes/ 要求记录「## Alternatives considered」备选 -->

## 验收标准

<!-- 可选：明确可勾选的标准，帮助评审判断是否达成 -->
