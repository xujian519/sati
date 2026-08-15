---
name: patent-search-report
description: |
  专利检索报告模板（专利律师场景交付物）。将技术方案、检索策略、对比文件清单与
  初步新颖性/创造性评估渲染为正式检索报告，供可专利性分析、OA 答复、无效检索引用。
triggers:
  - "专利检索报告"
  - "检索报告"
  - "prior art search"
  - "patent search report"
template:
  kind: patent-document
  mode: report
  scenario: patent-search
  preview:
    type: html
    entry: assets/template.html
  exports: [html, pdf]
---

# 专利检索报告模板

将专利检索过程与结果渲染为**正式检索报告**，强调检索策略可追溯、对比文件可定位、结论可复核。

## 输入要求

渲染前必须已具备（缺任一项先补齐）：

1. 技术方案分解表（PFE 三元组）或权利要求特征表。
2. 检索策略记录：数据库、检索式、检索日期、检索人。
3. 对比文件清单（每篇含公开号/标题/公开日/来源/相关度/可引用段落）。
4. 与发明特征相关的初步比对结论（至少标注 X/Y/A 档相关度）。
5. 免责声明与密级（模板已内置，不可删除）。

## 工作流

1. 读 `references/conventions.md` 与 `references/citation-log.md`。
2. 复制 `assets/template.html` 为 `search-report.html`。
3. 填充：案件信息 → 检索策略 → 技术方案/权利要求特征 → 对比文件清单 → 特征-文件映射 → 初步结论 → 引用日志 → 假设与局限。
4. 相关度代码统一：`X`（可单独影响新颖性/创造性）、`Y`（可与 X 文件结合）、`A`（背景技术）、`P`（中间文件）、`E`（同族/冲突申请）。
5. 引证定位用 `D1 ¶0023` 格式；无法溯源的段落标注为待核实。
6. 删除模板占位，按 `references/checklist.md` 自查后定稿。

## 输出契约

```
文件：search-report.html（单文件、内联 CSS）
可选：search-report.pdf（A4 打印）
     search-report.md（源稿）
```

品牌变量由 `assets/templates/patent/tokens.css` 注入；agent 不修改样式。
