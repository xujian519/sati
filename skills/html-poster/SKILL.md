---
name: html-poster
description: 生成单页海报 HTML，适用于发布会、培训、成果展示、活动宣传。固定尺寸 1080×1920 或 A4。
mode: poster
scenario: design
surface: 1080x1920
preview: example.html
design_system: sati-html
---

# HTML 单页海报模板

将活动/成果/培训信息渲染为一张可直接展示或导出的单页海报。

## 前置

- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/shared-design-directives.md`（即仓库根 `assets/prompts/html/shared-design-directives.md`）。
- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/html-delivery-checklist.md`。
- 再读取本目录 `references/checklist.md`。

## 布局

1. 顶部：活动/主题标签 + 超大标题。
2. 中部：核心信息（时间、地点、主办方、报名方式）或成果要点。
3. 视觉：使用大字号衬线/黑体对比、几何背景、编号区块。
4. 底部：CTA / 二维码占位（用 CSS 色块或 SVG 绘制，不引外链图片）。

## 尺寸

- 默认 1080×1920（竖版）或 A4（横版/竖版均可）。
- 内容必须完整落在目标尺寸内，不能滚动。
- 字体与间距使用 `clamp()` 或固定 px 均可，但需保证目标尺寸下无溢出。

## 输出

- 单文件 HTML，无外部图片依赖。
- 色彩克制，主色 + 中性色 + ≤1 强调色。
- 不使用 lorem ipsum / 占位文字。
