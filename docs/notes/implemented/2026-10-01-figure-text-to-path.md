# Agent Note: 字体独立导出（SVG 文本转路径）

Status: implemented

## Problem

本仓生成的附图 SVG **不带 `font-family`**，中文标签的呈现完全取决于读者环境：打印店、审查员查看器、公文流转系统缺 CJK 字体时，图面上的"处理模块""待机"会变成豆腐块。这是**交付物层面**的缺陷，而且本仓所有流程门禁都检测不到——文件不报错、能打开、校验也过，就是读不出来。

对照仓 deepseek-harness 2026-09-28 用系统 Inkscape 的 `--export-text-to-path` 解决（见其 `2026-09-28-inkscape-text-to-path-figure-export.md`）。

## Decision

1. 新增 `src/patent/figuregen/inkscape-renderer.ts`：`resolveInkscapeCmd`（显式覆盖 → 平台候选 → PATH，**显式覆盖值不存在即抛错不回落**，与本仓 `resolveFreecadCmd` 同契约）、`exportSvgTextToPath`（转换 + 三道校验 + 原子换入）、失败分类与安装指引。
2. 门控 `SATI_FIGURE_TEXT_TO_PATH`（`1`/`true`/`on` 开，**默认关**）。**走环境变量而不是工具入参**：改 `inputSchema` 会让 llm-replay fixture 失配（本仓重放契约铁律），故不碰任何工具 schema。
3. 接入 `patent_figure_generate` 与 `patent_figure_project`，时机为**全部 SVG（图形 + 落版页）落盘之后、sidecar 落盘之前**——此后不再有模块解析这些文件的文本。两处都在**落盘之前**先探测可执行文件：开关开了却没有 Inkscape 时立刻 fail-loud，不留"图形已落盘但没转路径"的半成品目录。
4. **回读语义的配套改动**（这一步不做就会引入回归）：`parseFigureSvg` 的 `numbered`（是否带**可见**图号）明确「属性不算」，只认 `<text>图N</text>`。转路径把文字变成轮廓后 `numbered` 必然为 false，`figure-gate` 的图号观测会读成"均无图号"，让 V15「两幅以上须用阿拉伯数字顺序编号」**误报 fail**。因此：
   - sidecar 新增可选字段 `text_to_path`（v1 内扩展，无解析方校验，不升版本）；
   - `detectFigureDrift` 仅在 `text_to_path === true` **且** sidecar 该图有 `caption` 时，以生成期事实替代回读观测；**未转路径时绝不回落**（那种情况下"回读不到"正是图号被删的漂移信号，回落会把它蒙掉）。

## Alternatives considered

- **无条件转路径**——DSH 自己否决过：没有 Inkscape 的部署仍须能出图，且绘图员要在矢量编辑器里收尾时 `<text>` 版本是更好的产物。
- **转路径后把图号 `<text>` 补回去**（只转正文标签、图号留文本）——Inkscape 的 `--export-text-to-path` 是全局开关，做不到选择性；补回去又引入了依赖字体的文本（"图"字同样会变豆腐），等于把缺陷留在最显眼的位置。
- **给 SVG 内嵌字体或写 `font-family` 回退栈**——内嵌字体体积大且授权复杂；回退栈只解决"有字体但名字不同"，解决不了"根本没有 CJK 字体"。
- **不做回读回落，接受 V15 误报**——转路径的部署会让每一张多幅 CN 附图的定稿阶段都被挂在 HITL 上，等于让一个可选优化把主流程打瘸。
- **只在"交付导出副本"上转路径、主产物保持可回读**——产物契约会分裂成两套（sidecar 只描述一套），且 figure-gate 打的是主产物路径，等于核验的还是没转的那份。
- **让 `resolveInkscapeCmd` 在显式覆盖值不可用时回落自动探测**——会让"我配了但没用上"变成无声的事实；本仓 `resolveDotBinary` 在这点上是已知漂移，不复制它。

## Consequences

换来：开启后交付物不再依赖读者机器上的字体（对含中文的附图尤其关键）；缺 Inkscape 时错误发生在**写盘之前**且带安装指引；sidecar 记录了"产物已转路径"，使这条信息可审计、可被下游正确解释。

付出与边界：
- 依赖外部 GPL 二进制（约 645MB）；每图约 0.4s；文件体积约 10 倍（轮廓替代 `<text>`）；**文字不再可搜索、不可就地编辑**——绘图员若要改字得拿到未转路径的版本，故默认关；
- 转路径后"图号是否可见"不再能从文件里机器验证，只能信生成期 sidecar；报告与 sidecar 都保留这一来源标注；
- 本机与 CI 都没有真装 Inkscape，**真实 Inkscape 的产物特性未实测**（argv 形状与失败分类由假可执行脚本锁定）；`stderr 有实质输出即判失败`这条比 DSH 更严的策略在极端环境下可能需要按实测往噪声白名单加前缀。
