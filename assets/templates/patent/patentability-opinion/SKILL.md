---
name: patentability-opinion
description: |
  可专利性分析意见书模板（专利律师场景交付物）。把新颖性/创造性/授权要件分析渲染为正式律师文书：
  结论摘要前置 + 逐特征比对表（pin-cite + 置信度）+ 引用日志 + 免责声明，A4 打印适配。
  当 brief 提及"可专利性分析意见""授权前景分析""新颖性/创造性评估报告"且需要文档交付物时使用。
triggers:
  - "可专利性分析"
  - "授权前景"
  - "专利性意见"
  - "patentability opinion"
template:
  kind: patent-document
  mode: opinion
  scenario: patentability-analysis
  preview:
    type: html
    entry: assets/template.html
  exports: [html, pdf]
---

# 可专利性分析意见书模板

将已完成的专利性分析（新颖性/创造性/客体/充分公开/清楚/单一性）渲染为**正式律师文书**。

## 输入要求

渲染前必须已具备（缺任一项先补齐再渲染，禁止用占位符凑数）：

1. 技术方案解析：特征分解表（PFE 三元组，见 `assets/prompts/patent/cap02-technical-analysis.md`）
2. 检索结果与对比文件清单（每篇含公开号/标题/公开日/来源/相关度/可引用段落，见 `assets/workflows/patent/` 检索阶段产出）
3. 逐特征比对结论（含 pin-cite 定位与 verified 状态，见 `src/patent/claim-chart/` 产物）
4. 各项授权要件结论 + 置信度
5. 免责声明与密级（模板已内置，不可删除）

## 工作流

1. 读 `references/conventions.md`（版式惯例）与 `references/citation-log.md`（引用日志规范）。
2. 复制 `assets/template.html` 为输出文件 `patentability-opinion.html`。
3. 按结构填充：案件信息 → 结论摘要（表 1）→ 方案解析（表 2）→ 逐特征比对（表 3）→ 创造性三步法 → 其他要件（表 4）→ 证据清单（表 5）→ 引用日志（表 6）→ 假设与局限。
4. 引用定位一律用 `D1 ¶0023` 格式，**禁止凭记忆写公开号/段号**；比对行复用 claim-chart 的 pin-cite 校验结果。
5. 无法溯源的断言：降级为 `模型推断` 或 `假设`（斜体），不写确定性结论。
6. 删除模板占位（"________"、"（特征描述）"等），说明性括号文字转为脚注或删除。
7. 按 `references/checklist.md` 逐项自查，P0 全过后定稿。

## 输出契约

```
文件：patentability-opinion.html（单文件、内联 CSS）
可选：patentability-opinion.pdf（A4 打印，见 conventions.md §7 导出脚本）
     patentability-opinion.md（源稿，供留档/二次编辑）
```

HTML 中 `:root` 变量由 `assets/templates/patent/tokens.css` 中的 `--sati-doc-*` 变量回退注入。品牌覆盖走 `products/<标识>/brand/theme.json` 或渲染管线参数，**agent 不直接修改 CSS**。

## 相关

- 版本历史与各版本 diff：随文书版本行记录；本模板是 v1 骨架。
- 铺开计划：确认本模板风格后，扩展到 `search-report`（检索报告）、`oa-response`（意见陈述书）、`claims-spec`（权利要求书/说明书）等模板。
