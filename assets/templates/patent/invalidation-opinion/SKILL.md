---
name: patent-invalidity-opinion
description: |
  专利无效宣告意见 / 无效请求书模板（专利律师场景交付物）。将专利无效分析、对比文件、
  无效理由与逐权利要求结论渲染为正式无效宣告请求书或无效意见。
triggers:
  - "无效宣告"
  - "专利无效"
  - "无效请求书"
  - "invalidity opinion"
  - "patent invalidation"
template:
  kind: patent-document
  mode: opinion
  scenario: patent-invalidation
  preview:
    type: html
    entry: assets/template.html
  exports: [html, pdf]
---

# 专利无效宣告意见 / 无效请求书模板

将专利无效分析过程与结论渲染为**正式无效宣告请求书或内部无效意见**，强调无效法条依据、对比文件公开范围、逐权利要求对比。

## 输入要求

渲染前必须已具备：

1. 涉案专利全文（权利要求书、说明书、授权公告文本）。
2. 涉案专利法律状态（授权公告号、授权日、专利权人、请求人）。
3. 对比文件清单（每篇含公开号/标题/公开日/与涉案专利的时间关系）。
4. 涉案权利要求分解表（特征编号、技术特征、技术效果）。
5. 无效理由体系（A22.2 新颖性 / A22.3 创造性 / A2/A25 客体 / A26.3 充分公开 / A26.4 清楚支持 / A33 修改超范围等）。
6. 免责声明与密级（模板已内置）。

## 工作流

1. 读 `references/conventions.md` 与 `references/citation-log.md`。
2. 复制 `assets/template.html` 为 `invalidation-opinion.html`。
3. 填充：案件信息 → 总体立场 → 涉案专利权利要求分析 → 证据清单 → 无效理由 → 逐权利要求分析 → 引用日志 → 结论与请求。
4. 无效理由按法条组织，每个理由下列出：事实认定 → 证据分析 → 法条适用 → 结论。
5. 对比文件公开日必须早于涉案专利优先权日/申请日；中间文件、冲突申请单独标注。
6. 删除占位文案，按 `references/checklist.md` 自查后定稿。

## 输出契约

```
文件：invalidation-opinion.html（单文件、内联 CSS）
可选：invalidation-opinion.pdf（A4 打印）
     invalidation-opinion.md（源稿）
```

品牌变量由 `assets/templates/patent/tokens.css` 注入；agent 不修改样式。
