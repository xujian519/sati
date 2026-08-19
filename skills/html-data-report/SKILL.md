---
name: html-data-report
description: 把 CSV/Excel/JSON 等结构化数据渲染成美观、可交付的单文件可视化数据报告。适用于经营数据、专利数据、案件数据、检索统计等。
mode: data-report
scenario: finance
surface: long-page
preview: example.html
design_system: sati-html
---

# HTML 数据报告模板

将结构化数据转成自包含单文件 HTML 数据报告。风格参考 html-anything 的 `data-report` 结构，使用 Sati 自有设计约束。

## 前置

- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/shared-design-directives.md`（即仓库根 `assets/prompts/html/shared-design-directives.md`）。
- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/html-delivery-checklist.md`。
- 再读取本目录 `references/checklist.md`。

## 布局

1. 头部：报告标题 + 时间区间 + 数据来源说明。
2. KPI 卡片网格：3–5 个最重要指标，每个卡片显示数值 + 同比/环比 + 微型趋势线。
3. 主图表区：至少 2 个图表（柱状 / 折线 / 饼 / 散点），使用 Chart.js 或 ECharts。
   - **图表容器必须有固定高度**：外层 `<div style="position:relative;height:280px">`，迷你图约 40–60px。
   - `responsive: true, maintainAspectRatio: false` 时父容器高度缺失会导致浏览器卡死。
4. 数据表格：用户原始数据节选，使用 `<table>`，斑马纹、sticky header。
5. 洞察块：3–5 条文字洞察，基于真实数据，不用 emoji 堆砌。
6. 底部方法论/假设折叠区（`<details>`）。

## 数据要求

- **必须使用用户提供的真实数据**，禁止 lorem ipsum / 占位数字。
- 如果输入是 CSV/Excel/JSON，先解析，再选择 KPI 与图表。
- 数据不足时如实说明，不编造缺失值。

## 输出

- 单文件 HTML，`<!DOCTYPE html>` 开头，`</html>` 结尾。
- 不引用本地图片；图表用 Chart.js CDN 或内联 SVG。
- 中英文混排加盘古之白。
