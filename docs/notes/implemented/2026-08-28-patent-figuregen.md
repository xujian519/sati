# Agent Note: 专利附图生成底座（figuregen 模块 + 两工具 opt-in + CNIPA 规则底座）

Status: implemented

## Problem

`patent_drafting_v1` 已产出权利要求书与说明书（含"附图说明"文字章节），但**画不出附图本体**——
方法流程图/系统框图是发明（实用新型必配）申请文件的组成部分，这是真实交付缺口。外部参考
RobThePCGuy/Claude-Patent-Creator（MIT）提供了"结构化出图 + 附图标记核验"的可借鉴思路，但其
实现是 Python/Graphviz 包装（Sati 无 Python 运行时），且 USPTO 37 CFR 1.84 中心、核验仅是
agent 提示词自律。

## Decision

- 新增 `src/patent/figuregen/` 纯函数模块：FigureSpec 契约（LLM 只产结构化数据）、确定性分层
  布局（最长路径分层，回边跳过）、黑白合规 SVG 渲染（构造期不变式：仅 `#000000`/`#FFFFFF`、
  无渐变，指南一部一章 4.3/4.6）、附图说明草稿（细则第 20 条第(四)项）。
- 附图标记（ref）为**结构化字段**，生成期写入 SVG `data-ref` 属性与 label 惯用形，不做文本
  后处理；核验器可独立回读。
- 新增确定性校验器（细则 2023 第 21 条）：V1 图号连续 / V2 图→文（fail）/ V3 文→图（保守
  warn）/ V4 一标记一组件（fail）；规则底座与 Semantica（8001 知识图谱）溯源锚固化于
  `skills/patent-illustrator/references/cn-drawing-rules.md`。
- 新增 `patent_figure_generate` / `patent_figure_check` 两工具 + `skills/patent-illustrator`
  技能。28 个新单测（校验器表驱动、布局/渲染不变式与确定性快照、工具层落盘/fail-closed）。

## Alternatives considered

- **引入对方 Graphviz 代码/依赖** — Python 不可复用；Graphviz 系统依赖加重桌面分发（对方自带
  installer 恰证其为痛点），彩色样式默认不合规。留 renderer 策略接口，P2 可作可选增强，弃。
- **Mermaid 文本渲染**（netlist-viz 先例）— 仓库无 mermaid 渲染依赖，HTML 单文件无外部资产
  约束下无法自渲染；电学网表继续走既有 Mermaid 通道，两轨并存，弃。
- **LLM 手写 SVG**（diagram-maker 路线）— 不可机器校验、黑白合规无法构造期保证，与 Sati
  确定性门禁哲学相悖，弃。
- **工具默认注册 + manifest 立即插阶段** — llm-replay fixture 的 record key 绑定工具 schema
  全集与请求序列：默认注册/改 `patentDraftingManifest` 会打红全部 patent 回路 fixture，重录需
  API key。故两工具走 **opt-in**（`createBuiltinRegistry` 的 `patentFigure` 选项，documentStyle
  先例）；manifest 挂 `figure_generate` 阶段与 fixture 重录**同批**做（P0.5/P1），弃立即挂接。

## Consequences

换来：撰写链路补上附图交付物；合规（黑白、双向标记一致）从"提示词自律"升级为"构造期不变式 +
机器门禁"；规则每条带知识图谱溯源锚（念念有据）。付出：布局器 P0 只覆盖 ≤20 节点简单分层
（复杂大图需 P2 Graphviz 增强）；两工具 opt-in 期间默认会话不可见；V5/V7/V8/V9 及 SVG 回读
复核留 P1；`[待核对]` 条款（细则 21 尾款禁注释、缩小三分之二）待官方全文校对。
