---
name: 技术债务（Tech Debt）
about: 登记"值得改但不紧急"的已知问题，必须写明触发还债条件，避免变成死 issue
title: "tech-debt: "
labels: ["tech-debt"]
assignees: ""
---

## 一句话债务

<!-- 一句话说清这是个什么债、为什么值得记 -->

## 背景（为什么这是债）

<!-- 现在哪里不舒服、为什么不尽快改。避免"违反了某规范"式空话，
     说清实际代价：难改？慢？易错？拖累哪个模块？ -->

## 位置 / 最小示例

<!-- 文件路径、函数名或最小代码示例，供后来人快速定位 -->

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

## 契约影响（重要）

<!-- 以下改动会触发特殊门禁，务必如实勾选 -->

- [ ] 工具 `inputSchema`（含描述文本）→ 需重录 llm-replay fixture（`pnpm record:replay`）
- [ ] `AgentEvent` / gateway frames → 需重新生成事件矩阵（`pnpm gen:event-matrix`）
- [ ] 网关协议变更 → 需按 MAJOR/MINOR 版本化（`src/gateway/protocol/version.ts`）
- [ ] 新增用户可见文案 → 需提取到 `ui/src/i18n/locales/{en,zh-CN}/` 对应 namespace
- [ ] UI 渲染变更 → 需按 CONTRIBUTING.md 完成视觉验证（双主题 / 双语言 / 状态 / 响应式）
- [ ] 不涉及上述契约

## 风险与影响（不还会在哪爆雷）

<!-- 明确列出不还的潜在后果，帮助排优先级 -->

## 触发还债条件（必填）

<!-- 关键：写明"什么时候还"，否则这张票会腐烂。示例：
     - 下次改 <模块> 时顺带还清（路过就修，boy-scout rule）
     - 达到 N 处调用点时再重构
     - 随下个里程碑 <版本/M1/M2> 一并清
     - 每季度 <工具> 评估若仍超阈值则立即还
-->

## 关联决策记录

<!-- 若涉及"明知该做但现在不做"的主动权衡，链接 docs/notes/ 对应 note -->

## 备注

<!-- 其他补充 -->
