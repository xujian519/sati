---
name: html-meeting-notes
description: 生成现代会议纪要 / 决策日志 HTML，包含议程、决议、行动项与下次会议。
mode: office
scenario: operation
surface: long-page
preview: example.html
design_system: sati-html
---

# HTML 会议纪要模板

将会议记录转成清晰、可执行、适合分享的单文件 HTML。

## 前置

- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/shared-design-directives.md`（即仓库根 `assets/prompts/html/shared-design-directives.md`）。
- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/html-delivery-checklist.md`。
- 再读取本目录 `references/checklist.md`。

## 布局

1. 标题栏：会议名称 + 时间 + 参会人。
2. 议程清单：勾选/优先级列表。
3. 决议区块：圆角卡片，每条决议一行结论 + 背景。
4. 行动项表格：Owner / Due / Status。
5. 下次会议：时间 + 议题 + 负责人。

## 输出

- 单文件 HTML，可双击打开。
- 使用真实会议信息，禁止 lorem ipsum / 占位文案。
- 行动项状态用文字 + 颜色，不只依赖颜色。
