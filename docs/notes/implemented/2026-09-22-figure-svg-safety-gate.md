# Agent Note: 外部 SVG 读取安全门（figuregen/svg-safety）

Status: implemented

## Problem

`patent_figure_check` 的 `svg_paths` 分支与 `figure-gate` 的漂移检测都会把**外部** SVG 文件直接读盘后交给 `readback.parseFigureSvg` 做正则解析。`readback.ts` 自陈「外部工具产出的 SVG 不在此契约内」，但两处调用点既无大小上限，也不拒 DOCTYPE/ENTITY/CDATA——即"解析器声明了不负责，调用方也没有护栏"。注入形态（实体展开引子、超大文件）与"图被人手工改过"这个漂移检测本来就要处理的场景**是同一类输入**，而漂移检测的结论是"核验通过"，在输入不可信时给出假保证是这里最贵的一种失败。

## Decision

新增 `src/patent/figuregen/svg-safety.ts`：`assertSafeSvg(text, maxBytes = 2_000_000)` 按序做三件事——大小上限（`too_large`）、拒绝 DOCTYPE/ENTITY/CDATA 声明（`unsafe_svg`，大小写不敏感）、要求含 `<svg` 根（`missing_svg_root`），失败抛带 `code` 的 `SvgSafetyError`（不返回布尔，避免调用方静默丢弃）。

接线两处，各自映射为既有语义：
1. `patent_figure_check` 的 `svg_paths`：拒绝 → `SatiToolRuntimeError("invalid_tool_input")`（与既有读盘/解析失败同码）。
2. `figure-gate` 的 `detectFigureDrift`：拒绝 → 记一条 drift（非空即 `InterruptStageError` high，人工决策放行/重生成/退回）。

`readback.ts` 头注补"调用方须先过 `assertSafeSvg`"一行，把这条纪律写在会被读到的地方。

## Alternatives considered

- **把安全门放进 `parseFigureSvg` 内部** — 落选。解析器的职责是"解析本模块两类渲染器的输出"，塞进安全边界会让一个函数承担两件事；且 `render-graphviz` 的自产出自检会为此多走一遍无意义扫描。安全边界属于"这一次读盘是否跨了信任边界"的**调用点事实**，放在调用方才能让每一处跨边界读盘显式过一次门。
- **改用真实 XML 解析器（sax / @xmldom/xmldom）替代正则** — 落选。要新增依赖并改变既有解析语义（`readback` 的栈式 `<g>` 扫描是为两类渲染器输出量身写的），与本刀"加一道门"的目标不成比例；安全门与解析器解耦后，将来换解析器不必重做门。
- **白名单标签/属性（严格 schema 校验）** — 落选。两类渲染器的输出结构会随 Graphviz 版本漂移，白名单会把一次 `brew upgrade graphviz` 变成交付阻塞；只拒"本模块渲染器绝不产出"的构造（DOCTYPE/ENTITY/CDATA），收益/风险比明显更好。产物结构与语义仍由 `parseFigureSvg` 的既有契约把关。
- **只做大小上限，不拒声明** — 落选。ENTITY 声明是实体展开/外部引用的引子，拒绝成本近乎为零，没有理由不做。
- **工具层返回 warn 而不是抛错** — 落选。被注入的文本不能安全进入解析器，"核验通过"在这一输入上不成立；工具层报 warn 等于把不可信输入当成可核验输入。
- **顺带把安全门接到 `renderFiguresHtml` 的内嵌 SVG** — 未做。该路径内嵌的只有本模块渲染器当场产出的 SVG（不跨信任边界），没有需要防的输入。

## Consequences

- 外部 SVG 超过 2MB 或被检出声明即被拒；两类渲染器的正常产物有**防误伤断言**锁住（内置渲染器 + 真机 graphviz 产物都必过门）。
- 拒绝是**显式失败**，不是降级：工具抛 `invalid_tool_input`，附图门挂 HITL——不新增"静默跳过"路径。
- 本门**不防**"语义级"SVG 攻击面（`<script>`、外链资源）。当前交付链不执行外部 SVG（只解析），HTML 内嵌路径只嵌自产物；若将来引入"渲染用户提供的 SVG"，需要另立一道执行面护栏，本门不宣称覆盖。
- 新增 11 例测试（`tests/patent/figuregen/svg-safety.spec.ts` + `figure-gate.spec.ts` 的注入用例）。
