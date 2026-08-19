---
name: html-finance-report
description: 生成季度财报 / 经营分析报告 HTML，含 Masthead、KPI、图表、P&L 表与展望。
mode: data-report
scenario: finance
surface: long-page
preview: example.html
design_system: sati-html
---

# HTML 财务 / 经营报告模板

将财务或经营数据渲染成专业、可打印的单文件 HTML 报告。

## 前置

- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/shared-design-directives.md`（即仓库根 `assets/prompts/html/shared-design-directives.md`）。
- 先读取 `{{SKILL_ROOT_SHELL}}/../../assets/prompts/html/html-delivery-checklist.md`。
- 再读取本目录 `references/checklist.md`。

## 布局

1. Masthead：公司/部门 + 季度 + 报告标题。
2. Hero KPI：4 个核心指标（营收、毛利、现金、客户数等）。
3. 图表：收入趋势、支出/烧钱趋势（Chart.js 或 ECharts，容器固定高度）。
4. P&L 概要表：收入、成本、费用、净利润，使用真实数字。
5. Top-line highlights：3–5 条重点结论。
6. Outlook：下季度展望。
7. 方法论折叠区：数据口径与假设。

## 输出

- 单文件 HTML，可打印 A4。
- 数字必须来自用户输入，禁止编造。
- 图表容器必须有固定高度。
