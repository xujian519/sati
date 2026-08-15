---
name: patent-oa-response
description: |
  审查意见答复 / 意见陈述书模板（专利律师场景交付物）。针对专利审查意见通知书，
  将修改后的权利要求、逐条争辩意见、证据引用渲染为正式意见陈述书。
triggers:
  - "审查意见答复"
  - "OA 答复"
  - "意见陈述书"
  - "patent office action response"
template:
  kind: patent-document
  mode: response
  scenario: patent-office-action
  preview:
    type: html
    entry: assets/template.html
  exports: [html, pdf]
---

# 审查意见答复 / 意见陈述书模板

将审查意见答复过程与结论渲染为**正式意见陈述书**，强调修改对照清晰、争辩意见逐条对应、法条与证据引用规范。

## 输入要求

渲染前必须已具备：

1. 审查意见通知书原文（通知书编号、发文日、审查结论、引用的对比文件）。
2. 原始权利要求书与修改后的权利要求书。
3. 权利要求修改对照表（修改前 / 修改后 / 修改依据 / 解决的技术问题）。
4. 针对每条审查意见的争辩意见（法条依据 + 事实 + 证据 pin-cite）。
5. 证据清单（D1/D2、公知常识证据、教科书/工具书等）。
6. 免责声明与密级（模板已内置）。

## 工作流

1. 读 `references/conventions.md` 与 `references/citation-log.md`。
2. 复制 `assets/template.html` 为 `oa-response.html`。
3. 填充：案件信息 → 总体立场 → 修改说明 → 逐条争辩 → 证据清单 → 引用日志 → 结论请求。
4. 每条争辩意见按「审查意见要点 → 答复要点 → 事实/证据分析 → 法条适用 → 结论」五段式组织。
5. 修改后的权利要求用下划线或加粗标注修改处；删除线仅用于说明，不写入正式文件。
6. 删除占位文案，按 `references/checklist.md` 自查后定稿。

## 输出契约

```
文件：oa-response.html（单文件、内联 CSS）
可选：oa-response.pdf（A4 打印）
     oa-response.md（源稿）
```

品牌变量由 `assets/templates/patent/tokens.css` 注入；agent 不修改样式。
