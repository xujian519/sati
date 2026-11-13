# Agent Note: 附图核验的矢量量测输出（`measurements`）

Status: implemented

## Problem

`patent_figure_check`（本仓的附图核验工具）此前**只给判据结论**（findings：哪里不对），
**不给量到的数**。量测其实一直在跑：`svg_paths` 通路调 `checkFigureRendering`（RC 族复核）
时，画布尺寸、文字元素数、线宽分布、线段取向分布都已经算出来了，但只取了 `.findings`
就丢掉了其余。

丢掉的代价是具体的：模型拿到「RC2 净距不足」这类结论，仍然答不出「这张图画布多大、
线宽几毫米、最小字高几毫米」——而「线宽 0.2mm 算不算细」「字高 2mm 缩到三分之二还读不
读得出」正是审查员和代理人真正要问的问题。模型只能靠猜，或者反过来再调一次别的工具
去量。

deepseek-harness 的 `verify_patent_figure`（`packages/patent/patent-tools/src/tool/
verify-patent-figure.ts:62-88`）的输出里**有**这些数（`widthMm`/`heightMm`/`textCount`/
`minFontMm`/`strokeWidthMm[]`/`orientationDeg[]`）⇒ 差集明确。

## Decision

把量测值**并入既有核验工具的输出面**，不另起工具：

### 1. 输出新增 `measurements`（每幅被核验的 SVG 一条）

`patent_figure_check` 的 `outputSchema` 新增 `measurements`（可选字段 ⇒ 既有消费方不受
影响），条目形如：

```ts
{
  path: string;            // 产物路径
  figure_no?: number;      // 回读到图号时给
  width_mm?: number;       // 画布宽（毫米）；根元素未声明时缺省
  height_mm?: number;      // 画布高（毫米）；根元素未声明时缺省
  text_count: number;      // 文字元素数
  min_font_mm?: number;    // 实测最小字高（毫米）；无文字时缺省
  stroke_width_mm: { width_mm: number; count: number }[];        // 升序
  orientation_deg: { orientation_deg: number; count: number }[]; // 按线段数降序
}
```

字段**语义**对齐 DSH（`min_font_mm` 取**实测**最小字高、线宽升序、取向按线段数降序），
字段名随本仓输出契约用 snake_case（DSH 用 camelCase）。

### 2. 装配点只在 `svg_paths` 通路

结构化 `figures` 通路没有 SVG ⇒ `measurements` 为空数组，**不编造**。

### 3. 报告文本加「矢量量测」分面

每幅一行（画布 mm、文字数与最小字高、线宽分布、取向分布），插在报告的「依据」条款
之前。理由：模型读工具输出先读文本，量测值只在 `data` 里多半读不到。

### 4. 实测最小字高：单列一个纯量测导出

本仓 `RenderCheckReport.minFontMm` 是**判据下限回显**（调用方给了下限才回显），而 DSH
报告与 `verify_patent_figure` 输出里的 `minFontMm` 是**实测最小字高**——两者语义不同，
不可互相顶替。故在 `figuregen/render-check.ts` 补导出 `measureMinimumFontHeightMm()`
（字高口径与 RC7 同一套：文字占位框的高 `O→O+e2` 的模长，保留两位小数）。

### 5. 诚实语义（不编造量测值）

| 情形 | 处理 |
|---|---|
| 安全门拒绝 / SVG 不可解析 | **整次核验失败**（既有 fail-loud 语义，`invalid_tool_input`），错误消息写明原因 ⇒ 不产出半份量测值 |
| 根元素未声明画布尺寸 | `width_mm`/`height_mm` **缺省**（不填 0），报告写「根元素未声明画布尺寸」 |
| 图中无文字 | `text_count = 0`，`min_font_mm` 缺省 |
| 部分结构超出量测范围（CSS 类样式、`<use>`/`<image>` 引用等） | 量测值只覆盖**量到的**部分，缺口由既有 RC0「未量测」发现明示，分面行也标注 |
| 走了结构化 `figures` 通路 | `measurements` 为空数组，报告不出该分面 |

## Alternatives considered

- **另起一个工具**（DSH 的做法：`verify_patent_figure` 独立注册、独立调用、只报告
  不阻断）—— 否决。本仓的制图能力已经收在三个工具里（generate / check / project），
  再加一个「只量不判」的工具会让模型多一次调用、多一份入参契约（**新增 builtin 工具 ⇒
  llm-replay 请求键变化 ⇒ 必须重录 fixture**，见 AGENTS.md 第 6 条）。并入既有工具的
  输出面：**零 `inputSchema` 变更、零新增工具 ⇒ fixture 无需重录**，且量测与判据同源
  同一次遍历，结论与数不出两张皮。
- **把量测值塞进 `render_check` 条目（而不是另开 `measurements`）** —— 否决。
  `render_check` 的语义是「判据结论」，量测值是「量到的数」，混在一起会让既有按
  `render_check[].findings` 消费的代码误判；另开一个可选字段对既有消费方零影响。
- **改 `RenderCheckReport.minFontMm` 的语义**（下限回显 → 实测最小字高）—— 否决。
  那是复核报告的契约，改它会让既有判据相关的读法漂移；且本次只需一个实测值，单列
  一个纯量测导出即可（报告语义差异在模块注释里写明）。
- **把量测失败降级成「该幅跳过、其余幅照报」** —— 否决。那会让该幅的 RC 结论**静默
  缺席**，而 `ok` 仍按其余幅计算 ⇒ "看起来通过"而实际未核验（违反 AGENTS.md 第 11 条
  「降级但不静默」）。既有 fail-loud 语义（安全门/解析失败整次核验失败）保持不变。
- **用 DSH 的 camelCase 字段名** —— 否决。本仓输出契约以 snake_case 为主
  （`figure_no`/`placed_width_mm`/`numeral_map`…），改字段名要在 schema 与数据两侧同步，
  收益只是字面像 DSH。

## Consequences

- `patent_figure_check` 的输出多一个**可选**字段 `measurements`，报告多一段「矢量量测」
  分面；既有消费方（按 `ok`/`findings`/`render_check` 读的代码）不受影响。
- **零 `inputSchema` 变更、零新增 builtin 工具** ⇒ llm-replay fixture 无需重录
  （`toolSchemaDigest` 只取 `{name, inputSchema}`，见 `src/test-support/llm-replay/
  requestKey.ts:58`）。工具**顶层** `description` 补了量测输出的一句说明（顶层描述不入
  请求键）。
- ⚠️ **专利面描述预算（R-06，≤40k）本批已顶格**：本批之前 `patent` 域工具的
  `description + inputSchema` 合计**恰好 40 000**（门禁断言 `<= 40_000`），任何新增
  描述都会破门。本批为此把 `patent_figure_check` 的顶层描述**净压缩**（把
  "black-and-white" 写成 "b/w"、去掉重复的 "FigureSpec"、"a deterministic ok verdict"
  收成 "ok verdict"），把量测输出的那句塞进同等字数内 ⇒ 合计 39 991（余量 9 字）。
  **后续再加专利面描述前，先跑这条门禁**；确有必要时应整体重排该预算，而不是逐条挤。
- `figuregen/render-check.ts` 多一个导出 `measureMinimumFontHeightMm`（纯量测，不产
  发现）；代价是 SVG 多扫一遍（纯函数、结果确定）。
- `patent_figure_check.ts` 增至 725 行（单文件上限 800，未越线）。
- 与 DSH 的差异（写在模块注释里）：DSH 是**独立工具、只报告不阻断**；本仓是**并入既有
  核验工具的输出面**——好处是量测与判据同源、调用次数不增，代价是取数必须带
  `svg_paths` 走这条通路。

## Verification

- `pnpm exec tsc --noEmit`：本批文件零错误。
- 新增用例 `tests/patent/figuregen/measurement-output.spec.ts`（5 条）：量测值进输出与
  报告、结构化通路不给量测值、不可解析的 SVG 不编造量测值、画布未声明/无文字时对应量测
  值缺省、线宽升序与取向降序且两次核验顺序一致。
- 输出契约用真实校验器 `validateCanonicalOutput` 跑真实输出（字段漂移即红）。
- `pnpm exec eslint` / `pnpm exec biome check`：本批文件干净。
