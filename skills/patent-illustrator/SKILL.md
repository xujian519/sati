---
name: patent-illustrator
description: 专利附图生成专家——从技术方案提炼结构化 FigureSpec（流程图/框图），经 patent_figure_generate 确定性出图（黑白线条 CNIPA 合规）、patent_figure_check 细则第 21 条双向标记核验、附图说明草稿。触发场景：画附图/流程图/框图/摘要附图、附图标记核验、说明书"附图说明"章节撰写、专利申请文件配图。
---

# Patent Illustrator（专利附图专家）

为发明/实用新型专利申请生成合规附图。**默认中国专利规则（CNIPA）**；出海申请按目标受理局
传 `jurisdiction`：`"us"`=USPTO（[references/uspto-drawing-rules.md](references/uspto-drawing-rules.md)）、
`"pct"`=PCT 国际申请（[references/pct-drawing-rules.md](references/pct-drawing-rules.md)）。

**纸面常数、图号写法与页码体例按法域档案取**（`src/patent/figuregen/office-profile.ts`，每个数值
都注明条文出处）：CN 用纸 A4、页边距 上25/左25/右15/下15mm、无附图专有字高条文（用实践下限
2.0mm）；PCT 页边距 上2.5/左2.5/右1.5/下1.0cm、字高 ≥0.32cm；US 页边距 上/左 ≥1 inch、右 ≥5/8 inch、
下 ≥1.0cm、字高 ≥0.32cm。

## 核心纪律

1. **LLM 只产结构化数据，不产图形**：你输出 FigureSpec（JSON：nodes/edges/refs），渲染由
   `patent_figure_generate` 确定性完成（黑色线条、白底、无渐变——审查指南一部一章 4.3/4.6
   是渲染器构造期不变式，不需要也不会产生彩色样式）。
2. **附图标记（ref）是结构化字段**：写入节点 `ref`，同时在 label 中带出标记。不要做文本替换式打标。
   ⚠️ **label 的写法按法域**：CN 惯用形是「处理模块(20)」（括号括住标记）；**PCT/US 不得用括号**
   （PCT Rule 11.13(e)、37 CFR 1.84(p)(1)：「Brackets … must not be used in association with numbers
   and letters」），应写「处理模块 20」或「处理模块20」。核验器的 V14 会在 pct/us 下报出括号形态
   （warn）——它不是误报，而是改写 label 的信号。
3. **先核验再定稿**：拿到说明书文字部分后必须调 `patent_figure_check`；存在 fail 级发现
   （V1 图号、V2 图→文、V4 标记一致性）时**附图不得定稿**，修 FigureSpec 重生成。
4. **跨图一致性**：同一组件跨图沿用同一节点 id 与同一标记；标记按"10、20、30…主件，
   12、14…子件"惯例分配（惯例级，非强制法条）。

## 图号的条件性（易错点）

图号**不是**总是出现：它由"本案附图总幅数 + 法域"共同决定，判据在法域档案里。

| 情形 | cnipa | pct / uspto |
|---|---|---|
| 本案只有一幅附图 | 标注"图1"（指南一部一章 4.3 把编号义务系于"两幅以上"，未禁止单幅编号） | **不得编号、不得出现 "Fig."/"FIG."**（PCT 指南 IP 5.141、37 CFR 1.84(u)(1)） |
| 两幅以上 | 每幅标注"图N"，标在图形正下方 | 每幅标注"Fig. N"/"FIG. N" |

跨次调用生成附图、或只核验其中一幅时，必须用 `figure_count` 声明本案总幅数，否则工具只能
按本次调用推断（`patent_figure_project` 一次只投一幅，尤其需要声明）。

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
4. 说明书定稿前调 `patent_figure_check`（figures + spec_text=权利要求书+说明书全文）；
   分次出图时同时传 `figure_count`。
5. 未过 → 修 FigureSpec 或提示补说明书文字 → 重跑 3–4。
6. 需要整页提交件时在 `patent_figure_generate` 传 `fit_to_page: true`：额外产出
   `<name>-figN-page.svg`（图形落版到 A4 版心、页码在版心上沿；图号仍画在图形下方）。
7. 将返回的"附图说明草稿"并入说明书七部分之"附图说明"章节（细则第 20 条）。

## 渲染器选择（Graphviz 可选增强）

FigureSpec 契约对两个渲染器完全一致，切换渲染器不需要改 spec：

| 渲染器 | 启用方式 | 适用 |
|---|---|---|
| builtin（默认） | 无需配置 | ≤ 20 节点的常规分层图，输出完全确定性 |
| graphviz | 本机安装 graphviz 后设 `SATI_FIGURE_RENDERER=graphviz`（dot 路径可用 `SATI_GRAPHVIZ_DOT` 指定） | 复杂大图/多回边/宽分支 |
| graphviz-wasm | 设 `SATI_FIGURE_RENDERER=graphviz-wasm`（打包 WASM 引擎，**无需**本机安装 graphviz） | 同上，但机器上没有 graphviz（含桌面端分发场景） |

**何时该改走 `graphviz-wasm`（2026-09-22 实测判据）**：两套布局器在 21 个基准用例上的缺陷计数
打平（文字交叠/标签穿线/边穿节点均为 0），差别集中在**落在纸面上的字高**——graphviz 的源字号
是 14pt（4.94mm）而内置渲染器是 14px（3.70mm），同画幅缩放后前者字高一律更大（例：16 步流程图
2.03mm vs 3.13mm，CN 实践下限 2.0mm）。故：**当内置渲染器缩放后的打印字高不足法域下限的 1.2 倍、
或画幅需缩到 2/3 以下时，改用 `graphviz-wasm`**；常规图保持默认（默认渲染器是唯一确定性、
不依赖第三方版本的路径，也是 CI 覆盖最厚的一侧）。`patent_figure_check` 的 V7 会报出打印字高，
照它判断即可。对比脚本 `scripts/figure-benchmark/renderer-compare.ts` 可复算这些数字。

- graphviz 渲染器与内置渲染器遵守同一合规不变式：黑白线条、无渐变（构造期扫描，非黑白
  fail-closed）；附图标记同样以 data-ref 内嵌，`patent_figure_check` 的 `svg_paths` 回读
  照常可用（图号标注"图N"/"FIG. N" 均可解析）。
- 未安装 graphviz 时 `graphviz` 开关**报错而非静默回退**——要么安装（`brew install graphviz`）、
  要么改用 `graphviz-wasm`（无系统依赖）、要么 unset 用回内置渲染器。
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

## 现状（截至 2026-09-22）

- **模块与工具**：figuregen（`src/patent/figuregen/`）；`patent_figure_generate` /
  `patent_figure_check` / `patent_figure_project` 三个工具**默认注册**
  （createBuiltinRegistry 的 `patentFigure: false` 可排除）。
- **核验规则**：V1–V5、V7–V17（V6 为渲染器构造期不变式）。V12–V14 判图面用语、
  V15/V16 判图号义务（需已交付 SVG 的回读观测）、V17 判多页附图的页码声明。
- **工作流门禁**：`patent_drafting_v1` 的 `figure_generate` 阶段挂 `figure-gate` 原子
  （fail 级挂 HITL），不再依赖主代理是否记得调用核验工具。
- **法域**：cn（默认）/ us / pct，纸面常数与编号体例来自法域档案；EPO 未列（一手文本未核验）。
- **渲染器**：builtin（默认）/ graphviz（本机 dot）/ graphviz-wasm（打包 WASM）。
- **产物**：`<name>-figN.svg` + sidecar（`<name>-figures.json`）+ 可选 A4 打印 HTML
  （`format: html|both`）+ 可选落版页（`fit_to_page: true`）。
- **未做**：外观设计（图片类附图）、图中引线标号、多面板（FIG. 1A/1B）、彩色附图模式。
