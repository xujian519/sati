# Agent Note: 矢量源渲染复核（RC 规则族）的移植与接线

Status: implemented

## Problem

本仓的附图核验有两族规则，但都吃不到"画出来是什么样"：`V*` 吃 `FigureSpec`（结构数据，判不了几何关系），`PX*` 吃**栅格**像素（要栅格图，且只判黑白性/线宽/DPI）。于是「矢量源上的几何事实」是真空白——文字是否被线条贯穿、文字与图线净距是否够、点划线是否被同位置实线覆盖、相邻零件剖面线是否可区分、内容是否越出画布，这五类只有在渲染结果上才显现的缺陷，此前没有任何机器判据（只能靠人看一眼图）。

对照仓 deepseek-harness 2026-09-28 起有 `figure/render-check.ts`（1520 行）+ `verify_patent_figure` 工具做这件事。差异分析与选型见 `docs/research/patent-figure-dsh-delta-2026-10.md` §4 P0-1。

## Decision

1. 移植三个纯函数模块到 `src/patent/figuregen/`：`glyph-box.ts`（字形占位框与贯穿判定）、`svg-viewport.ts`（用户单位 → 毫米、viewBox/`preserveAspectRatio`）、`render-check.ts`（五类缺陷 + `not-measured` 诚实清单）。安全门复用本仓既有的 `svg-safety.ts`。**判定逻辑与阈值逐行沿用**，数值处注明「沿用 deepseek-harness 的默认值，非本仓条文核验过的法条数值」。
2. 规则号**自成一族 `RC*`**，与 `V*`（吃 FigureSpec）和 `PX*`（吃栅格像素）分列——三族输入域不同，混进 `FigureCheckRuleId` 会让「注册表覆盖全部 V 规则号」这类不变量测试失去意义。级别按「读不出来」与「不够清楚」划线：`RC1` 文字被线条贯穿、`RC5` 内容越出画布 = **fail**；`RC2` 净距不足、`RC3` 点划线被覆盖、`RC4` 剖面线难区分 = warn；`RC0` 未量测 = info（是"这份报告没覆盖哪些结构"的清单，不是缺陷）。
3. 接入 `patent_figure_check` 的 `svg_paths` 通路（**零 schema 变更**：只加报告段与 `data.render_check`，不动 `inputSchema`）。`RC1`/`RC5` 与结构规则、像素门禁**同权**参与 `ok` 判定。
4. **一处对移植逻辑的适配**：本仓内置渲染器把边标签直接放在连线中点上，用 `stroke="#FFFFFF" stroke-width="4" paint-order="stroke"` 在字外围形成白圈把线视觉断开（`render-svg.ts` 的标签契约）。几何上线条确实穿过文字框——实测本仓**每一张带边标签的 flowchart/state 图**都会被报成贯穿。DSH 用 `data-dsh-role` 标注引线来豁免，本仓无对应标注，故按样式特征识别（`paint-order` 含 stroke **且**描边为白色）并在贯穿与净距两处跳过。不豁免的情形（无 `paint-order`、描边彩色/未声明）照常判定。

## Alternatives considered

- **改 `render-svg.ts` 给边标签加 `data-role` 标注，复刻 DSH 的豁免**——要改渲染产物；本仓产物已入库并被 sidecar/漂移检测/回放路径消费，为一条检测适配去动产物契约不划算，且按样式特征识别在语义上同样准确。
- **把 `text-crossed-by-line` 一律降为 warn**——对本仓产物（普遍有 halo）确实不会误报，但对**真正**的贯穿缺陷（外部图、人工改坏的图）也失去了阻断力；几何特征识别能两者兼顾。
- **把 `RC*` 并进 `FigureCheckRuleId`**——会被 `check-rules.spec.ts` 的「注册表覆盖全部规则号」不变量要求补齐规则实现，而 RC 的输入域（已交付 SVG）与注册表（FigureSpec → findings）根本不同。
- **放宽 `parseFigureSvg` 以让外部 SVG 也走 `svg_paths` 通路**——`parseFigureSvg` 的严格性（要求图号、拒非本工具产物）正是漂移检测的基础；外部 SVG 的几何复核应另立入口（新增工具属批次 B，会改工具面 ⇒ 需 fixture 重录）。
- **按 subagent 的初判去"修" `stroke-dasharray` 的单位换算**——**核实后否定**：`dashPatternUser` 按 SVG 规范返回**用户单位**，全链路只在 `scanSvg` 里乘一次累计缩放（用户单位 → 毫米），换算正确。同一个 `"8 2 0.4 2"` 在无单位（CSS px，1px≈0.2646mm）文档里长划 2.12mm、在 `width="200mm"` 文档里长划 8mm——这是换算链生效的证据。用例已改成同时钉住两侧的差异，而不是钉住一个不存在的 bug。

## Consequences

换来：五类渲染事实第一次有了机器判据，且**不需要栅格化器**（量测在矢量源上做，线段位置/线宽/字号即渲染输入）；`RC1`/`RC5` 会真正中断流程；`RC0` 让"未发现问题"与"未量测"可区分（报告里没有 `not-measured` 时，未发现问题才等于逐类量测过）。

付出与边界：
- 判据阈值沿用 DSH 默认值，**未经本仓条文核验**，故只作为工程判据、不作合规依据；
- `svg_paths` 通路只接受**本仓产出的** SVG（`parseFigureSvg` 要求图号），所以渲染复核当前服务的是交付前自检与**渲染器回归护栏**，不是外部图核验——这条边界已钉成显式用例；
- halo 豁免会让"标签压线但靠白边挖空"的图不被报为贯穿；这是有意的（本仓的标签契约如此），但它也意味着**该写法的可读性依赖白边宽度**，检测不管这一层。
