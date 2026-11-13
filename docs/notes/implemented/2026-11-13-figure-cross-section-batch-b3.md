# Agent Note: 附图对齐 deepseek-harness 批次 B-3（二维剖视渲染器 + 一次判据缺陷修复）

Status: implemented

## Problem

批次 B-2 落地了时序图、电路图、多面板，把 `TD-PATENT-N39` 收敛到**只剩两项**：**2D 剖视**
（cross-section）与**外观设计二维视图**（appearance）。

2D 剖视与前两项不同：它**不能**复用 `nodes`/`edges` —— 断面轮廓是二维多边形、还要剖切线、
剖面填充与剖面线交替 ⇒ 需要**新数据结构 + 新渲染器**。

DSH 的对应实现（语义参考，**不抄代码**）：
`packages/patent/patent-tools/src/figure/section-diagram.ts`（918 行）。

## Decision

### B-3-1 数据结构：`FigureSpec.section`（归一化坐标 0..1）

```ts
type FigureSectionPart = {
  id: string; label?: string; ref?: number;
  outline: readonly (readonly [number, number])[];        // 断面轮廓（≥3 点，自动闭合）
  holes?: readonly (readonly (readonly [number, number])[])[]; // 孔：孔内不填剖面线
  no_hatch?: boolean;                                     // 只画轮廓不剖
};
type FigureSection = {
  parts: readonly FigureSectionPart[];
  cut?: readonly (readonly [number, number])[];           // 剖切线（点划线）
  hatch_spacing?: number; hatch_angle_deg?: number;
};
```

**为什么用归一化坐标而不是毫米**：调用方不必知道输出画布的像素尺寸（画布由渲染器按包围盒
自适应），核验侧也能独立算画幅。

**口径对齐 GB/T 4457.5《机械制图 剖面区域的表示法》**：断面区域内画**细实线**平行剖面线，
与水平成 45°，同一零件间距相等方向一致，**相邻零件方向相反**（否则相邻零件被读成一个整体）；
剖面线**不得妨碍**附图标记线与主线条的清楚识别（指南一部一章 4.3）⇒ 剖面线线宽比轮廓细一档。

### B-3-2 摊平口径：`figureNodes` 纳入断面零件

剖视图的「节点」在 `section.parts` 里 ⇒ `figureNodes` 增一条分支（section 优先于 panels 与
顶层 nodes），于是核验（V2/V3/V4/V22）、标号归一、图面用语、附图说明、标号表**五条既有管线
自动覆盖剖视图**。实测：剖视图里未在正文出现的标记 20 被 V2 正确报出（`refs_in_figures`
= [10, 20]）。

### B-3-3 修掉一处**既有判据缺陷**（本轮真实发现）

2D 剖视出图后，渲染复核报了一条 RC4：「相邻零件 #1（45°/间距 1.6mm）与 #2（45°/间距 1.6mm）
的剖面线方向仅差 0°」—— 而产物里明明是 45°/135° 交替（实测 45°×63、135°×44）。

定位（主代理与子代理**独立**得出同一结论）：`checkFigureRendering` 把**画布白底矩形**
（`<rect>` 填充、不描边、闭合）收进了「零件轮廓」列表 ⇒ 所有剖面线的中点都落在白底里 ⇒
白底拿到「众数方向 45°」，于是「白底 vs 零件 1（45°）」被判成方向相同。

修法（`render-check.ts`）：**只把承载墨迹的闭合轮廓当作零件轮廓**。

- 判据用「承载墨迹」（`shape.stroked || !shape.occludes`）而**不是**「是否描边」：既有 RC4/RC6
  用例里的轮廓是填充不描边的多边形，按描边过滤会把它们整体排除（实测回归 2 例变红）。
- 修完：剖视图经 `svg_paths` 通路核验 **ok: true、零缺陷**；制图域 682 用例零回归。

⚠️ 这个缺陷**一直存在**，只是此前没有任何图型带剖面线 ⇒ 触发不了。它不是新功能引入的，
但只有剖视落地才会显形 ⇒ 记在这里（缺陷先于功能存在，值此一笔）。

### B-3-4 预算：上限**不再上调**，靠全域描述瘦身腾空间

`section` 入参让契约面从 47 752 涨到 **49 260**（超 48 000）。这已是连续两轮上调 ⇒ 本轮
**不再上调上限**，改为做一次**全域描述瘦身**：

- 压了 **18 处**描述（12 个工具的顶层描述 + 6 处超长属性描述），共腾出约 **1 400 字符**；
- **保留全部边界/约束/口径句**（如 `patent_deadlines` 的三条送达口径、`patent_fees` 的
  减免比例与「未核验项阻断合计」），只删**介绍性**与**兄弟工具导航**（模型本来就能看到工具列表）；
- 结果：**47 934 / 48 000**（余 66）—— 上限不动，契约面反而比上一轮小。

⚠️ 余量只有 66 字符 ⇒ 下一轮新增能力前必须**先瘦身再扩展**，这条已写进 `TD-PATENT-N38`。

### B-3-5 重录纪律（我本轮踩了一次）

本轮共重录 **两次**：第一次录完又改了一句 `patent_workflow_run` 的属性描述 ⇒ 请求键变化 ⇒
重放门禁打红 ⇒ 只能再录一次。

**纪律（写进本 note）**：**重录必须发生在所有 `inputSchema` 改动之后**；录完只做不改 schema
的门禁（测试、文档、指标基线）。任何「录完再改描述」都会让重录白做一次。

## Alternatives considered

- **把断面轮廓塞进 `nodes`（用多边形形状 + 顶点字段）** —— 否决。会让 FigureNode 承担两种
  语义（文字框 vs 断面），且核验侧的「节点」与「零件」不再一一对应。
- **剖面线沿剖切线画短斜线（GB/T 字面意义的「剖面线」）而非区域内平行线（DSH 口径）** ——
  否决。DSH 走的是「剖面区域」口径（输入即断面轮廓、在其内填平行线），与 DSH 对齐更有价值；
  且沿剖切线画短线无法表达「同一零件内部间距相等」这条可核验特征。
- **给剖视图也豁免 RC4/RC6（像 sequence/circuit 那样记 not-measured）** —— 否决。剖面线
  与轮廓**按设计相接**但并不相交，判据本可以成立；真正的 bug 是画布白底被当成零件。豁免会把
  一个真缺陷藏起来（而 RC4 恰恰能查「相邻零件剖面线方向相同」这个 GB/T 要求）。
- **再上调上限到 50 000** —— 否决。连续上调会让门禁变成橡皮图章；改为真瘦身。
- **压缩与本功能无关的工具描述来腾预算** —— **部分采纳，且给了理由**：本轮压的是 12 个工具的
  顶层描述，**保留全部边界句**、只删介绍性文字与兄弟工具导航 ⇒ 对模型是**净收益**（更短且
  不丢语义），不是「降别的工具的质量换我的功能」。不做的是「删掉实质边界句」那类压缩。

## Consequences

- `TD-PATENT-N39` 只剩**外观设计二维视图**一项（DSH 的 `appearance-view-sheet` 是二维外观
  设计图，本仓只有三维 STEP 投影 —— 不是一回事，DSH 在这点有真实增量）。
- 修掉一处既有判据缺陷（画布白底被当零件）—— 该缺陷对所有带剖面线的图型都成立。
- patent 域描述预算**没有再涨**（47 934 / 48 000），但余量只剩 66 字符。
- fixture 本轮重录两次（最终版含 `cross-section` 图型 + `section` 入参 + 全部描述瘦身）。
- 新增 1 个源文件 + 2 个测试文件；用例 19（渲染器 14 + 端到端 5）。

## Verification

- `pnpm check`：exit 0（含 `check:runtime-cycles`、`check:figure-render-baseline`、
  R-06 描述预算门禁、技术债棘轮、doc-claims）。
- `pnpm format:check`：绿（3 209 文件）；`pnpm build`：通过。
- `pnpm test`：**6 787 用例 / 6 782 通过 / 2 失败 / 3 跳过**。两处失败是**环境性**且与本轮
  改动无关：① `系统 Chrome 存在时可生成 PDF`（无头 Chrome 在本机沙箱不可用）；②
  `配置 downloadDir 含 ~/ 前缀`（沙箱禁止写工作区外的 `/Users/xujian/pdf-tilde-test`）。
- 重放门禁：`node --test dist/tests/test-support/llm-replay-real.spec.js` ⇒ `# pass 1`；
  `pnpm record:replay <dir>` ⇒ `fixture valid`。
- 新增用例：`cross-section.spec.ts`（14，渲染器）、`new-section.spec.ts`（5，端到端：
  出图 / 相邻零件方向相反 / 核验可见 / graphviz 拒绝 / 非法轮廓入参报错）。
- 剖视图经 `patent_figure_check` 的 `svg_paths` 通路核验：**ok: true、零缺陷**。
- 制图域回归：682 用例 / 681 通过 / 0 失败 / 1 跳过。
