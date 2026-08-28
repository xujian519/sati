# Agent Note: 专利附图生成底座（figuregen 模块 + 两工具 opt-in + CNIPA 规则底座）

Status: implemented（P0 + P1 + P2 USPTO 模式 + P3 Graphviz 可选渲染器；仅剩外观设计图片类附图未做）

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
  技能。41 个新单测（校验器表驱动、布局/渲染不变式与确定性快照、SVG 回读、A4 HTML、
  工具层落盘/fail-closed）。
- P1 追加：校验器全量规则 V5 禁注释 / V7 画幅可辨 / V8 摘要附图 / V9 实用新型必须有
  附图；`patent_figure_check` 接 `svg_paths` 回读已交付 SVG（readback.ts，仅解析本模块
  渲染器输出）；`patent_figure_generate` 接 `format: html|both` 产 A4 打印版式
  单文件 HTML（PDF 走既有 Chromium 打印管线）；`patent_drafting_v1` 在 slop_clean 与
  final_approval 之间插入 `figure_generate` 无原子透传阶段；compliance.yaml 增
  PAT-FIG-001 附图标记一致性自检规则（structural_analysis，rule_check A 链）。
- P3 追加：**Graphviz 可选渲染器**（复杂大图增强）落地。`src/patent/figuregen/dot.ts`
  FigureSpec → DOT（确定性纯函数，黑白十六进制在 DOT 层固化）+ `render-graphviz.ts`
  本机 `dot -Tsvg`（spawn stdin/stdout，30s 超时）+ 交付前加工：剥离 XML 头与含版本号
  的生成器注释、颜色关键字归一化并做黑白不变式扫描（fail-closed）、按节点 id 向
  graphviz 分组注入 data-ref（title 定位 + 结构守卫，注入后 readback 回读自检 figure_no
  与全部 ref）。dot 定位 `SATI_GRAPHVIZ_DOT` 优先、PATH 兜底；渲染选择走
  `SATI_FIGURE_RENDERER=graphviz` 环境变量（工具层执行期读取），缺失 fail-closed
  报错不静默回退。readback 扩展为双渲染器契约（class="node" 分组 + title 取回原 id +
  图尾 "图N"/"FIG. N" 取最后标注——顺带修复 US 模式 SVG 此前无法回读的缺口），
  深度追踪扫描防 graph0 嵌套误吞；html 接 renderedSvgs 预渲染注入。工具 schema 零变更，
  llm-replay fixture 无需重录。

## Alternatives considered

- **引入对方 Graphviz 代码/依赖** — Python 不可复用；Graphviz 系统依赖加重桌面分发（对方自带
  installer 恰证其为痛点），彩色样式默认不合规。留 renderer 策略接口，P2 可作可选增强，弃。
  （P3 修订：策略接口兑现为可选渲染器——graphviz 仍不捆绑不分发，仅本机安装后经环境变量
  启用；彩色样式问题以 DOT 层黑白十六进制 + 渲染后不变式扫描双重封死。）
- **P3 渲染器选择的暴露面：inputSchema `renderer` 选项 vs 环境变量** — schema 选项对 LLM
  可见、可逐次调用选择，但默认注册工具的 inputSchema 参与 llm-replay 请求键
  （requestKey.ts：tools[].inputSchema 全量入键），任何 schema 文本变更都打红
  deepseek-v4-flash-basic fixture 并须重录（一次真实 API 调用）。渲染器本质是
  **机器能力**（本机装没装 graphviz）而非逐次调用意图，环境变量（`SATI_FIGURE_RENDERER`，
  `SATI_TRANSCRIPT_SINGLE_WRITE` 先例）零 fixture 影响、零 API 依赖，且 fail-closed
  语义（装了才开）与机器能力模型一致，取环境变量。若未来确需 LLM 逐次选择（如同机
  混用两渲染器对比成图），走 schema 选项 + fixture 重录同批做。
- **graphviz 缺失时静默回退内置渲染器** — 违背 fail-closed 哲学：用户显式指定渲染器
  却被静默换掉，成图布局不可预期地变化（两渲染器分层结果不同）。缺失即报错并给出
  安装指引/unset 提示，弃静默回退。
- **Mermaid 文本渲染**（netlist-viz 先例）— 仓库无 mermaid 渲染依赖，HTML 单文件无外部资产
  约束下无法自渲染；电学网表继续走既有 Mermaid 通道，两轨并存，弃。
- **LLM 手写 SVG**（diagram-maker 路线）— 不可机器校验、黑白合规无法构造期保证，与 Sati
  确定性门禁哲学相悖，弃。
- **工具默认注册 + manifest 立即插阶段** — llm-replay fixture 的 record key 绑定工具 schema
  全集与请求序列：默认注册/改 `patentDraftingManifest` 会打红全部 patent 回路 fixture，重录需
  API key。故两工具走 **opt-in**（`createBuiltinRegistry` 的 `patentFigure` 选项，documentStyle
  先例）；manifest 挂 `figure_generate` 阶段与 fixture 重录**同批**做（P0.5/P1），弃立即挂接。
  （P1 修订：核实 drafting fixture 实际未录制、其测试 skip，basic fixture 是纯问答任务且
  workflow 工具描述为硬编码字符串——manifest 插阶段不动请求键，遂落地；工具默认注册仍会改
  变工具集摘要，opt-in 维持。）
- **compliance.yaml 增 PAT-FIG-001 附图标记一致性 YAML 规则** — 规则引擎的 structural_analysis
  是"缺失即违规"语义、无前置触发条件：入共享 patent scope 后 rule_check 对任意非附图文本都会
  报违规（`rule-check.spec` 干净文本用例即红）。附图核验的确定性本体已在 `patent_figure_check`
  工具内，YAML 规则只会重复且误报，弃（已回退）。若未来引擎支持 precondition/trigger 语义可
  再评估。

## Consequences

换来：撰写链路补上附图交付物；合规（黑白、双向标记一致）从"提示词自律"升级为"构造期不变式 +
机器门禁"；规则每条带知识图谱溯源锚（念念有据）。付出：布局器 P0 只覆盖 ≤20 节点简单分层
（P3 起 graphviz 可选渲染器承接复杂大图，但需本机安装 graphviz、桌面分发不捆绑；内置渲染器
仍是默认，未装 graphviz 的机器行为不变）；两工具 opt-in 期间默认会话不可见（工作流 figure_generate
阶段在未启用时会说明跳过）；细则 21 条第 3 款禁注释与指南
一部一章 4.3"缩小到三分之二"条款已经官方公布文本核验（2026-08-28，CNIPA 公布文本，见
cn-drawing-rules.md）；A4 打印边距（25/15mm）为实践惯例标注，USPTO 边距（上/左 2.5cm、
右/下 1.5cm）以 eCFR 现行文本为准。P3 的 graphviz 交付物在同一机器/同一 graphviz 版本下
逐字节确定（版本号注释已剥离），跨 graphviz 版本布局可能有差异——正式提交前由代理师复核。
