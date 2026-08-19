---
name: html-social-card
description: 生成适合微信、知乎、社交平台分享的 HTML 卡片，固定尺寸 1600×900 或 1080×1920。
mode: social-card
scenario: personal
surface: 1600x900
preview: example.html
design_system: sati-html
---

# HTML 社交分享卡模板

将观点、知识、活动信息渲染为一张可直接分享的社交卡片。

## 前置

- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/shared-design-directives.md`（即仓库根 `assets/prompts/html/shared-design-directives.md`）。
- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/html-delivery-checklist.md`。
- 再读取本目录 `references/checklist.md`。

## 布局

1. 顶部：来源 / 作者标签。
2. 中部：主标题（1–2 行）+ 副标题或摘要。
3. 底部：数据/来源/CTA。
4. 视觉：卡片背景、几何装饰、大字号标题。

## 尺寸

- 默认 1600×900（横版）或 1080×1920（竖版）。
- 内容必须完整落在目标尺寸内，不能滚动。

## 输出

- 单文件 HTML，无外部图片依赖。
- 适合导出 PNG。
- 不使用 lorem ipsum / 占位文字。
