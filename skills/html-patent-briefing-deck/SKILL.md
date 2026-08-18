---
name: html-patent-briefing-deck
description: 生成专利分析简报 HTML Deck，面向客户/内部评审，16:9 翻页，每页一屏。
mode: deck
scenario: patent
surface: 16:9
preview: example.html
design_system: sati-html
---

# HTML 专利简报 Deck 模板

将专利分析结论组织成 16:9 横向翻页的 HTML 简报，适合客户会议、内部评审与分享。

## 前置

- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/shared-design-directives.md`（即仓库根 `assets/prompts/html/shared-design-directives.md`）。
- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/html-delivery-checklist.md`。
- 可参考 `skills/frontend-slides/` 的视口适配规则。

## 布局

1. 封面页：案件/主题 + 客户 + 日期。
2. 技术方案页：背景、问题、方案要点。
3. 检索与对比文件页：对比文件列表、相关度、关键区别特征。
4. 权利要求策略页：独立权利要求要点、从属布局、风险。
5. 结论与建议页：结论、下一步、风险提示。

## 硬性规则

- 每页必须是 100vh / 100dvh，`overflow: hidden`，不允许页内滚动。
- 字号与间距使用 `clamp()`。
- 内容超出时拆页，不压缩用户信息。
- 支持键盘 ← / → 与导航点。
- 支持 `prefers-reduced-motion`。

## 输出

- 单文件 HTML，可直接打开演示。
- 使用真实专利/案件数据，禁止 lorem ipsum。
- 不引用外部图片，装饰用 CSS/SVG。
