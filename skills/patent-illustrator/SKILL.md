---
name: patent-illustrator
description: 专利附图生成专家——从技术方案提炼结构化 FigureSpec（流程图/框图），经 patent_figure_generate 确定性出图（黑白线条 CNIPA 合规）、patent_figure_check 细则第 21 条双向标记核验、附图说明草稿。触发场景：画附图/流程图/框图/摘要附图、附图标记核验、说明书"附图说明"章节撰写、专利申请文件配图。
---

# Patent Illustrator（专利附图专家）

为发明/实用新型专利申请生成合规附图。**默认中国专利规则（CNIPA）**；PCT/出海申请传
`jurisdiction: "us"` 切换 USPTO 模式（[references/uspto-drawing-rules.md](references/uspto-drawing-rules.md)）。

## 核心纪律

1. **LLM 只产结构化数据，不产图形**：你输出 FigureSpec（JSON：nodes/edges/refs），渲染由
   `patent_figure_generate` 确定性完成（黑色线条、白底、无渐变——审查指南一部一章 4.3/4.6
   是渲染器构造期不变式，不需要也不会产生彩色样式）。
2. **附图标记（ref）是结构化字段**：写入节点 `ref`，同时在 label 中带出惯用形"处理模块(20)"。
   不要做文本替换式打标。
3. **先核验再定稿**：拿到说明书文字部分后必须调 `patent_figure_check`；存在 fail 级发现
   （V1 图号、V2 图→文、V4 标记一致性）时**附图不得定稿**，修 FigureSpec 重生成。
4. **跨图一致性**：同一组件跨图沿用同一节点 id 与同一标记；标记按"10、20、30…主件，
   12、14…子件"惯例分配（惯例级，非强制法条）。

## 图型路由

| 请求 | kind | direction | 形状约定 |
|---|---|---|---|
| 方法权利要求/流程步骤 | flowchart | TB（默认） | ellipse=开始/结束，rect=步骤，diamond=判断（分支边必须带 是/否 label） |
| 系统/装置权利要求 | block | LR（默认） | rect=模块，cylinder=存储，parallelogram=输入输出 |
| 电路/网表 | 不适用本工具 | — | 走 `analyze_patent_figure` 分析轨 + netlist Mermaid 通道 |

## 工作流

1. 从交底书/权利要求提炼组件与步骤清单（每图 ≤ 20 节点，超出先拆图）。
2. 分配附图标记，规划图号（图1..图N 连续；多图时指定一幅 `abstract: true` 作摘要附图，
   指南一部一章 4.5.2）。
3. 调 `patent_figure_generate`（figures + output_name + invention_name）。
4. 说明书定稿前调 `patent_figure_check`（figures + spec_text=权利要求书+说明书全文）。
5. 未过 → 修 FigureSpec 或提示补说明书文字 → 重跑 3–4。
6. 将返回的"附图说明草稿"并入说明书七部分之"附图说明"章节（细则第 20 条）。

## 渲染器选择（Graphviz 可选增强）

FigureSpec 契约对两个渲染器完全一致，切换渲染器不需要改 spec：

| 渲染器 | 启用方式 | 适用 |
|---|---|---|
| builtin（默认） | 无需配置 | ≤ 20 节点的常规分层图，输出完全确定性 |
| graphviz | 本机安装 graphviz 后设 `SATI_FIGURE_RENDERER=graphviz`（dot 路径可用 `SATI_GRAPHVIZ_DOT` 指定） | 复杂大图/多回边/宽分支，graphviz 的分层引擎布局质量更高 |

- graphviz 渲染器与内置渲染器遵守同一合规不变式：黑白线条、无渐变（构造期扫描，非黑白
  fail-closed）；附图标记同样以 data-ref 内嵌，`patent_figure_check` 的 `svg_paths` 回读
  照常可用（图号标注"图N"/"FIG. N" 均可解析）。
- 未安装 graphviz 时该开关**报错而非静默回退**——要么安装（`brew install graphviz`），
  要么 unset `SATI_FIGURE_RENDERER` 用回内置渲染器。
- 即使有 graphviz，超过 30 节点仍建议拆分为多幅附图（指南一部一章 4.3 缩小三分之二
  仍可辨细节的画幅约束不变）。

## 法条溯源（知识系统接线）

向用户引用任何规则（细则第 20/21 条、审查指南附图条款）时，用 `law_search` 拉取法条全文
核对原文后再输出；涉及附图与说明书一致性的审查实践，用 `patent_wiki_search` 检索知识卡片
交叉印证。溯源锚（Semantica 节点 ID）固化在
[references/cn-drawing-rules.md](references/cn-drawing-rules.md)，输出意见时应带条文出处。

## 边界

- 外观设计（图片类附图）不适用；照片/扫描件只能分析（`analyze_patent_figure`）不能生成。
- 本工具产出的是**可交付初稿**：SVG 可二次编辑；正式提交前由代理师按最终申请格式复核。
- 附图标记核验的 V3（文→图）是保守 WARN：说明书里的数字未必是附图标记，须人工确认。

## 规则依据

全部条文与溯源锚见 [references/cn-drawing-rules.md](references/cn-drawing-rules.md)。

## Sati Migration Note

- P0：figuregen 模块（src/patent/figuregen/）+ 两工具 opt-in 注册
  （createBuiltinRegistry `patentFigure` 选项）+ 校验器 V1–V4。
- P1：校验器全量规则 V5/V7/V8/V9；SVG 回读复核（patent_figure_check 接
  `svg_paths`）；A4 打印 HTML（generate 接 `format: html|both`）；
  `patent_drafting_v1` 已插 `figure_generate` 透传阶段（slop_clean 之后、
  final_approval 之前）。
- P2：USPTO 出海模式已实现——两工具接 `jurisdiction: "us"`（FIG. N 图号、
  跳过 V8/V9 CNIPA 特有规则、37 CFR 1.84 法条引用、英文 BRIEF DESCRIPTION
  模板）。规则底座见 [references/uspto-drawing-rules.md](references/uspto-drawing-rules.md)。
- P3：Graphviz 可选渲染器（复杂大图增强）——`SATI_FIGURE_RENDERER=graphviz`
  走本机 dot（`SATI_GRAPHVIZ_DOT` 指定路径），DOT 层固化黑白合规，data-ref
  注入 fail-closed 并经 readback 自检；同 SVG 回读契约双渲染器通用（含 FIG. N）。
  未做：外观设计图片类附图。
