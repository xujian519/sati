# Agent Note: 附图对齐 deepseek-harness 批次 B-2（新图型与多面板渲染器）

Status: implemented

## Problem

批次 B-1（`docs/notes/implemented/2026-11-12-figure-dsh-alignment-batch-b1.md`）落地 9/10 项，
把两项需要**新写渲染器**的推迟到下一轮并登记为 `TD-PATENT-N39`：

- **新图型**：时序图（sequence）、电路图（circuit）、外观设计视图（appearance）、2D 剖视（cross-section）；
- **多面板** `panels`（FIG.1A / FIG.1B 这对部分视图，共享标号系列）。

B-1 的结论是「只扩枚举不实现渲染 = 接口欺骗」，所以本轮必须**真把渲染器写出来**，
再一次性扩枚举 + 扩入参 + **一次**重录。

DSH 的对应实现（语义参考，**不抄代码**）：
`packages/patent/patent-tools/src/figure/sequence-diagram.ts`（292 行）、
`circuit-diagram.ts`（749 行）、`appearance-view-sheet.ts`（368 行）、`section-diagram.ts`（918 行）。

## Decision

### B-2-1 落地三项：新图型 ×2 + 多面板 ×1

| 项 | 落地形态 | 位置 |
|---|---|---|
| **时序图** `kind: "sequence"` | 参与者生命线 + 消息（实线/虚线）+ 自消息回环；复用 `nodes`/`edges` | `src/patent/figuregen/sequence-diagram.ts` |
| **电路图** `kind: "circuit"` | 9 种 IEC 矩形符号元件 + 引线 + 连线；复用 `nodes`/`edges` | `src/patent/figuregen/circuit-diagram.ts` |
| **多面板** `panels` | 网格拼版（⌈√n⌉ 列）、各格共享标号系列、统一缩放系数 | `src/patent/figuregen/panel-sheet.ts` |

**三个关键设计决定**：

1. **新图型复用 `nodes`/`edges`，不新开数据结构**。
   时序图 = 参与者（节点）+ 消息（边）；电路图 = 元件（节点）+ 连线（边）。
   好处是 schema 只扩两个 enum 值（几十字符）而不是新增结构（几百字符），且**核验、标号
   归一、图面用语、附图说明、标号表这五条既有管线原样可用**。
   代价：表达能力受限（时序图无「生命线激活区间/alt 分段」，电路图无元件参数）——本轮接受。

2. **多面板是 `FigureSpec.panels`（可选字段），与 `kind` 正交**：`panels` 存在时它承载图面
   内容（顶层 `nodes`/`edges` 被忽略），`kind` 仍决定各面板内部的图型语义。

3. **摊平口径 helper（`figureNodes` / `figureEdges`）**：核验、标号归一、图面用语、附图说明、
   标号表**一律**经它取节点，否则面板里的标记会在核验侧「消失」——那就是「声明了却没核验」
   的假保证。本轮实测：改之前 `refs_in_figures` 会漏掉面板里的 20，改之后 V2 正确报出。

### B-2-2 渲染复核的图型豁免（降级但不静默）

时序图的消息箭头**必须**落在生命线上、电路图的连线**必须**落在元件引线端点、多面板的格内
图形**必然**与格边框相交 ⇒ RC4（相邻零件剖面线难以区分）与 RC6（图元互相重叠）在这些图型上
**恒为真**，是噪音不是缺陷。

处理：根元素写 `data-dsh-kind`（`chart`/`sequence`/`circuit`/`panels` 四类才写，**既有图型
的产物字节不变**，渲染不变式基线不漂），渲染复核据此**跳过** RC4/RC6 并**显式记一条
`not-measured`**（「没判」不呈现成「判过且无问题」，AGENTS 第 11 条）。

### B-2-3 graphviz 通路整体 fail-loud

生命线、元件符号、面板网格都不是 graphviz 的表达力 ⇒ 该通路画不出 ⇒ **整体拒绝**（在落盘
之前），而不是画一张错图。曲线图（chart）此前已是同一处理，本轮把闸门抽到
`patentFigureShared.ts` 的 `assertBuiltinRenderableFigures`（generate / check / project 共用口径）。

### B-2-4 核验侧的画幅必须与渲染同源

V7（画幅/字高判据）此前用 `layoutFigure` 的**分层布局**估画幅。新图型不用分层布局 ⇒ 那个
尺寸是另一张图的尺寸。改法：`check-context.ts` 的 `figureCanvasPx` 对新图型**直接调用同一个
渲染器**取画幅（核验与渲染同源）。

### B-2-5 预算：第二次上调 46 000 → 48 000（并给出还债条件）

契约面实测 45 720 → **47 752**（+4.5%），来自 2 个图型枚举 + 9 个电路元件形状 + `panels` 入参
（`panels` 的节点/边 schema 与顶层共用同一份定义 ⇒ 只展开一次）。

上限 40 000 → 46 000（B-1）→ **48 000**（本轮）。**连续两次上调**，故同时把
`TD-PATENT-N38` 升级为「下一轮必须执行」：把 patent 域的长描述下沉进 skill/references，
工具描述收成「做什么 + 关键约束」两行；**验收口径 = 总量回落且单工具描述不超 400**。
只做「压缩别人的工具描述来给自己的新功能腾预算」是动机可疑的做法，故不做。

### B-2-6 一处 init-time 循环依赖（已打断）

新渲染器 → `numeral-assign` → `check-context` → `render-svg`（为新图型算画幅）⇒ **六文件成环**，
`check:runtime-cycles` 门禁会红。解法：把词法判定（`stripRefMark` / `normalizeRefLabel`）下沉到
零依赖模块 `figuregen/ref-label.ts`，`check-context` 与 `numeral-assign` 都从那里取 ⇒ 断环。
（顺带：`renderShape` 从 `render-svg.ts` 提到 `render-utils.ts` 供多面板/内置渲染器共用 ——
形状口径漂一处，两处画出来的同一个形状就会不一样，而产物是逐字节比不出来的。）

### B-2-7 本轮**不做**的两项（仍记账）

- **2D 剖视（cross-section）**：需要**新数据结构**（2D 轮廓 + 剖切线 + 剖面填充 + 剖面线
  交替），不是「扩枚举」能覆盖的 ⇒ 留到下一轮。
- **外观设计视图（appearance）**：DSH 的 `appearance-view-sheet` 是**二维外观设计图**
  （简化轮廓 + 立体感线条），本仓的 CAD 通路是**三维 STEP 投影** —— 二者不是一回事，
  本仓**没有**外观设计二维视图 ⇒ DSH 在这一点上有真实增量 ⇒ 同样留到下一轮。

## Alternatives considered

- **给新图型各开一套结构（`participants` / `components` / `shapes`）** —— 否决。会让五条既有
  管线（核验、归一、文案、说明、标号表）各写一遍分支，漏一处就是「声明了却没核验」。
  复用 `nodes`/`edges` + 摊平 helper 是同一件事的两种成本。
- **只扩 `FigureKind` 枚举、渲染器下一轮再写** —— 否决。那正是 B-1 判定为「接口欺骗」的形态。
- **多面板用「一次调用出多幅图」代替** —— 部分采纳但**不替代**：`figure_family`（B-1）已能
  让同族多幅图共享连续号段，但那是**两幅图**，不是「一幅图两个面板」；本轮两者并存。
- **给新图型也写 `data-dsh-kind`** —— 只对四类写。写全了会让**所有**既有产物的字节变
  （渲染不变式基线的 sha256 全红）⇒ 不做。
- **把 RC4/RC6 直接关掉（而非记 not-measured）** —— 否决。关掉 = 「没判」看起来像「判过且
  无问题」（AGENTS 第 11 条）；记 `not-measured` 才能看出这块没量。
- **把上限继续提到 50 000** —— 否决。实测增幅只有 +4.5%，48 000 够用；把幅度控制在与实测
  增幅相称，而不是留无依据的空间。
- **抄 DSH 的四个渲染器实现** —— 否决。DSH 的安全门（DOCTYPE）、`semantic` 配色、
  `fit_to_page` 默认值等口径本仓不采用（见批次 A 的「不抄清单」）；本轮只借**语义**
  （时序图的参与者/消息、电路图的 IEC 矩形符号），实现与测试全部自写。

## Consequences

- **B-1 推迟的两项里落地了三项**（时序图、电路图、多面板）；2D 剖视与外观设计二维视图仍
  在 `TD-PATENT-N39`（下一轮，同样一次重录）。
- patent 域的图型枚举从 5 个变 7 个，节点形状从 8 个变 17 个；`FigureSpec` 多了 `panels`。
- **fixture 第二次重录**（本轮 schema 变更：2 个 kind + 9 个 shape + `panels` 入参）。
- 新增 5 个源文件 + 5 个测试文件（渲染器 3 + 词法 1 + 集成 1）；用例 41（渲染器 17/19/19）
  + 5（端到端接线）。
- 渲染复核对四类图型**不再量** RC4/RC6，并在报告里明写「本次未量测」。
- `patent` 域描述预算**连续两轮上调**（40 000 → 46 000 → 48 000）⇒ `TD-PATENT-N38`
  升级为下一轮必须执行的描述重排。

## Verification

- `pnpm check`：exit 0（含 `check:runtime-cycles`、`check:figure-render-baseline`、
  R-06 描述预算门禁、技术债棘轮、doc-claims）。
- `pnpm format:check`：绿（3 206 文件）；`pnpm build`：通过。
- `pnpm test`：**6 768 用例 / 6 763 通过 / 2 失败 / 3 跳过**。两处失败是**环境性**且与本轮
  改动无关：① `系统 Chrome 存在时可生成 PDF`（无头 Chrome 在本机沙箱不可用）；②
  `配置 downloadDir 含 ~/ 前缀`（沙箱禁止写工作区外的 `/Users/xujian/pdf-tilde-test`）。
- 重放门禁：`node --test dist/tests/test-support/llm-replay-real.spec.js` ⇒ `# pass 1`；
  `pnpm record:replay <dir>` ⇒ `fixture valid`。
- 本轮新增用例：`sequence-diagram.spec.ts`（17）、`circuit-diagram.spec.ts`（19）、
  `panel-sheet.spec.ts`（19）、`new-kinds.spec.ts`（5，端到端：出图 / 核验可见 / graphviz 拒绝）。
- 制图域回归：`dist/tests/patent/figuregen/*.spec.js` + `figure/*.spec.js` + `figure-gate` ⇒
  775 用例 / 774 通过 / 0 失败 / 1 跳过。
