# Agent Note: 附图图号条件化 + 画幅随编号变化（含 data-figure-no 契约）

Status: implemented

## Problem

`render-svg.ts` 与 `dot.ts` 对**每一幅**图无条件硬写图号（`图N` / `FIG. N`），全库没有"本案附图总幅数"概念。这在美国是明文缺陷：37 CFR 1.84(u)(1)「Where only a single view is used … it must not be numbered and the abbreviation "FIG." must not appear.」（PCT 指南 IP 5.141 同旨）。同时画幅里始终留着 40px 的图号标注带——不编号的图不该留这条空白带。

## Decision

1. **判据进档案、实现只一处**：`shouldRenderCaption(profile, figureCount)` + `figureCaption(profile, figureNo, figureCount)` 在 `office-profile.ts`；渲染（`render-svg`/`dot`/`cad`）与核验（`check.ts` 的 V7 纸面尺寸）共用同一判据——两处各自解释规则会立刻漂移成"核验量的是另一张图"。
2. **各法域取值**：cnipa `captionOnlyWhenMultiple: false`（**单幅保留"图1"**——指南一部一章 4.3 只把编号义务系于"总数在两幅以上"，未禁止单幅编号，且附图说明会引用"图1"）；pct/uspto `true`（单幅不得编号）。
3. **画幅随编号变化**：`layoutFigure(spec, { caption })` 只在需要编号时计入 `CAPTION_H = 40`；`buildFigureDot` 不编号时不输出 `label`/`labelloc`（而不是画空 label 占位）。
4. **新增机读图号契约 `data-figure-no`**（根元素）：图号可见性条件化后，`parseFigureSvg` 若只认图尾 `<text>图N</text>` 就会在"单幅 pct/us"上抛错，进而让 `figure-gate` 的漂移检测与 `patent_figure_check` 的 `svg_paths` 全线失效。故：内置渲染器与 graphviz 路径（`withFigureNumberAttribute`）都在根元素写图号；`parseFigureSvg` **先读属性、再回落图尾标注**（旧产物与历史案卷照常可读），并新增 `numbered`（是否带**可见**图号）供 V15/V16 判"可见形态"。
5. **附图说明与图号同源**：`brief.ts` 的图号引用改用 `figureCaption`，单幅在 pct/us 无图号时正文改用"附图/The figure"称代——否则图与说明自相矛盾。
6. **V15/V16 需要"可观测的交付形态"才判**：`checkFigures` 新增 `numberedFigureNos`（交付 SVG 的回读观测）与 `figureCount`；只有给了观测才判编号义务——结构化 FigureSpec 里没有"是否带图号"这一信息，对看不见的东西判违规属错误归因。

## Alternatives considered

- **CN 也改成"单幅不编号"** — 落选。4.3 的文义是"两幅以上**应当**编号"，不是"单幅**不得**编号"；而且 CN 的附图说明（`brief.ts`）会写"图1为……"，去掉图号会让图文对不上。这也把改动面收在 pct/us，既有 CN 快照与基准零变动。
- **总幅数不引入参数，按 `figures.length` 判** — 落选（部分落选）：缺省仍按 `figures.length`，但分次出图与 `patent_figure_project`（一次只投一幅）无法自行得知总数，故补 `figure_count` 入参。
- **保留"总是画图号"，只让核验器报 V16** — 落选。那等于产品默认产出违反 1.84(u)(1) 的图并要求用户手工删；规则与渲染必须同向。
- **不引入 `data-figure-no`，让 `parseFigureSvg` 在缺标注时用"文件里没有图号"来表示** — 落选。图号回读是漂移检测的锚（sidecar 的 figure_no 必须能与文件对拍），没有机读来源就只能靠文件名猜。
- **把 `data-figure-no` 放在 `postProcessGraphvizSvg` 里注入** — 落选（改动落点问题）：该函数是"加工外部 dot 输出"的通用函数，图号是渲染器（知道 spec）的事实；放在 `renderFigureSvgWithGraphviz` 里注入使 `postProcessGraphvizSvg` 的签名与既有测试面不受影响。
- **画幅不变（保留标注带的空白）** — 落选。V7 量的是纸面尺寸，"不编号的图留着标注带"会让核验判据与实际排版不一致（多算 10.6mm 高）。

## Consequences

- pct/us 单幅的产物：无可见图号、画幅少 40px（约 10.6mm）；`patent_figure_check` 的图号观测会显示"均无图号标注"，这是合规形态而非缺陷。
- 图号回读有两条路（属性优先、文本回落），旧产物与历史案卷仍可解析；`numbered` 与 `figureNo` 分离，使"可见形态"与"机器契约"不再互相绑定。
- 受影响的既有断言已同批更新：`dot.spec`（US 真机集成改为多幅断言 FIG. + 单幅断言无 FIG.）、`us-mode.spec`（改为三法域 × 图幅数矩阵）、`cad.spec`（同上）。CN 快照与生成侧基准的 CN 用例数值未变。
- 未做：`FIG. 1A` 式部分视图的多面板编号（新入参契约，按方案 §8 单独立项）。
