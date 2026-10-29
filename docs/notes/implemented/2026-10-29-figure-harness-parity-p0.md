# Agent Note: 附图工具对齐 deepseek-harness（P0：渲染门禁 / RC6–RC7 / 部署字号 / 跨调用占用 / 结构上限）

Status: implemented

## Problem

`src/patent/figuregen` 与 `/Users/xujian/projects/deepseek-harness` 的制图工具在五处能力上存在差距，
每处都会让"看起来生成成功"的交付实际不合规：

1. **图面缺陷无自动出口**：`checkFigureRendering`（RC1–RC5）只在 `figure-gate` 交付门跑，
   生成期 `patent_figure_generate` 不跑——标号贴线、文字被线贯穿要等到交付门才暴露，
   而此时模型早已离开生成上下文。
2. **RC 规则覆盖不全**：harness 有「图元互相重叠」「字高低于下限」判据，本仓缺失。
3. **字号口径散在四处**：内置 14px、Graphviz 12pt、CAD 3.0/3.5mm、落版 `sourceCharMm`
   各自硬编码，客户要整体调大字号时没有单一入口，改一处就会让 V7 与渲染说的不是同一件事。
4. **分次生成无跨调用视图**：同一案卷目录下每次调用只见到本次附图，图号重复、
   同一附图标记指向不同部件都不会被发现。
5. **超大图无入参护栏**：`nodes + edges` 无上限，自动布局会把一张 300 节点的图压到
   字高不可辨（V7 必然不过），但渲染仍然"成功"。

## Decision

P0 五项全部走**环境变量与内部规则**，不动 `inputSchema`（避免 llm-replay fixture 重录）：

1. **生成期跑渲染复核**：`patent_figure_generate` 在落盘前对每张 SVG 跑 `checkFigureRendering`，
   经 `toRenderCheckFindings` 并入返回的 `check.findings`（与结构规则同一份报告、同一份 sidecar）。
   档位由 `SATI_FIGURE_RENDER_GATE=off|warn|fail` 决定，缺省 `warn`；`off` 时仍写一条
   `RC0` info 明示"未量测 ≠ 通过"（AGENTS 第 11 条）；`fail` 在**产物与 sidecar 全部落盘后**
   抛错（产物可审计），`warn` 只报告。
2. **新增 RC6 `element-overlap`、RC7 `font-below-minimum`**：前者量闭合轮廓包围盒两轴交叠
   （排除严格包含、同 `data-dsh-hatch-group`、两侧都无描边），后者按 `minFontMm` 逐**文字元素**
   量字高（下限由法域档案 `minCharHeight` ÷ `uniformFigureZoom` 折算到源图坐标）。
   两条都定 `warn`：新增规则会经既有 `detectFigureDrift` 链自动进入交付门，定 `fail`
   会误伤存量交付。规则号映射仍单点在 `render-check-rules.ts`。
3. **`SATI_FIGURE_FONT_MM` 部署级字号**（毫米，主字号）：内置按 CSS 换算成 px、
   Graphviz 按 72/25.4 换算成 pt、CAD 标号直取该值；`sourceCharHeightMm` 对内置/Graphviz
   按 `EDGE_FONT_RATIO=12/14` 折算到"图内最小字"。未设 env 时各通路字面值不变，输出逐字节一致。
4. **跨调用一致性以 sidecar 为单一事实源**：每次生成读同目录**全部** `*-figures.json`
   （排除同名 `output_name`，避免重生成判自己），核对图号占用（重复时给 `V1` warn）与
   附图标记指向冲突（报告行 `[WARN]`），并列出已占用标号。
5. **结构元素上限 200**：`assertFigurePayloads` 在入参处拒绝 `nodes + edges > 200`，
   与 harness 的 `STRUCTURAL_MAX_ITEMS` 同值。

## Alternatives considered

- **RC7 用 harness 的 `figure-hierarchy`（声明的图内层级 vs 权利要求归属表述一致性）** —
  该判据需要 FigureSpec 之外的显式层级输入，属 schema 变更（须重录 fixture），P0 不做；
  规则号 RC8 已在 `render-check-rules.ts` 注释中预留，留待 P1 带 schema 一起落地。
  本次先把 `font-below-minimum` 占 RC7——它是纯量测、不需要新输入，收益立刻可拿。
- **"自动跨调用续号"（读旧 sidecar 自动分配下一个图号/标号）** — 在本仓语义下不安全：
  `FigureNode.label` 已承载**可见标号文本**（如「处理模块(20)」）且渲染器逐字画 label，
  自动填 `ref` 不产生可见标号、改 label 又等于静默篡改专利文本。故改为"核对并报告占用"，
  由模型/代理师决定如何续号；真正的自动分配留待 P1（需要 label 与标号分离的 schema）。
- **把门禁档位做成 `inputSchema` 选项** — 任何 `inputSchema` 变更（含描述文本）都会使
  llm-replay fixture 失配（AGENTS 第 6 条），而这三档是部署/运维决策而非单次调用决策，
  放环境变量与 `SATI_FIGURE_RENDERER` 一致。
- **RC6/RC7 定 `fail`** — 存量交付里"图形压叠""边标签偏小"很可能已存在；新增 fail 规则
  会让 `figure-gate` 对历史案卷整体翻红，阻断与本次改动无关的交付。先 `warn` 收集实测，
  后续按命中率再议升级。
- **让 `metrics.ts` 直接 import `page-contract.ts` 复用毫米换算** — 会形成
  `page-contract → ... → metrics` 的环；改为在 `metrics.ts` 内保留两个本地换算常量
  （CSS px 与 pt，均为定义常量）。
- **`FigureCheckRuleId` 只留给 V 族、RC 族另立类型** — 生成期与门禁都把两类发现混排进
  同一份 `check.findings`，分类型会逼出一层无信息的适配；改为同一联合类型，映射仍单点。

## Consequences

- 生成期与交付门现在**用同一套 RC 规则、同一份规则号映射**；`off`/`warn`/`fail` 三档
  在报告里可区分，`off` 不会伪装成通过。
- 存量行为不变：未设 `SATI_FIGURE_FONT_MM` 时布局、渲染、DOT 输出逐字节一致；
  `SATI_FIGURE_RENDER_GATE` 缺省 `warn`，不阻断既有流程。
- 成本：每次生成多跑一遍矢量量测（纯文本解析，无外部依赖）；目录里此前若有损坏的
  sidecar，跨调用核对会**带文件名报错**而不是静默跳过（这是有意的 fail-loud）。
- 已知边界：RC6 只看闭合轮廓包围盒，斜置轮廓的交叠会被包围盒放大；
  RC7 的字高按占位框实测，与 V7 的渲染器常数估算是两套互补口径，两者同时存在不是重复。
