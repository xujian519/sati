# Agent Note: 附图 P0 —— 标号字框、引线止点、标记取值与门禁消费面

Status: implemented

## Problem

专利附图链路的四个面存在会直接误导交付的缺陷（2026-10-26 深度研究报告的 P0 项）：

1. **标号字框与复核侧不一致**：引线择位用 `measureTextWidth`（数字 0.5em、基线上 1.0em/下 0.2em），
   复核侧 `glyphBox` 用 0.6em/0.75em/0.12em。择位按较紧的框躲、复核按较宽的框判，工具自己画的
   合规标号会被报成「文字被线条贯穿」（3 位标号横引必现）或「净距不足」（1/2/3 位竖引系统性
   1.1mm）。引线止点又按「基线后退间隙」估算，而基线在字框内偏下，斜向/横引会贴着字底走。
2. **标记取值与编号前缀**：`ref` 的 inputSchema 只有 `type: integer`，0/-5/1000 都能过既有规则；
   V2 的文本匹配把「图20」「步骤20」「第20项」里的数字当成标记 20 的提及，漏报真实的图文不一致。
3. **图号注记不是避让障碍**：CAD 标号可以落在图下方「图N」上，而检查器没有对应规则，两张文字
   都读不出。
4. **V7 量的是重排结果，不是交付文件**：graphviz 14pt、CAD 投影画幅都与内置布局不同，会出现
   「实际放得下、V7 判超框」（9 步 graphviz 实测 228.6mm vs 重排 268mm）。
5. **门禁只消费 V 规则**：`figure-gate` 不跑 RC（文字贯穿/越界）也不读 sidecar 里的 C 发现，
   RC1/C9 这类「交付出去就读不出」的缺陷只要不进按需核验报告就能放行。

## Decision

- **字框单点**：`labelBoxOf` 直接委托 `glyphBox`；CAD 的预留带也用 `textWidthMm`。引线止点改为
  「射线与占位框的首个进入点再退 `gapMm`」：`boxEntryAlongRay` 解进入距离，`leaderOf` 据此收边，
  不再按基线估算。
- **CAD 引线标角色**：CAD 渲染器给引线写 `data-dsh-role="leader"`（与内置通路共用
  `render-utils.ts` 的常量），复核侧的净距判据据此跳过工具自己的引线。
- **V22 + 共享词法**：新增 V22（非正整数 fail、超过三位数 warn）；`textMentionsRef`、V3 的括号
  抽取、V11 与说明书侧抽取共用 `numeral.ts` 的 `hasNumeralPrefix`（回看窗口取足 24 字符，
  单字编号词要求左侧边界，避免 `密封条（20）` 这类元件名被误排除）。入参层拒绝非正整数
  （不改 inputSchema，报错带 V22）。
- **图号注记**：CAD 择位把注记框加入障碍；新增 C12 报告钉死偏移/旧产物造成的压盖。
- **V7 实测优先**：`checkFigures` 新增 `measuredPaperSizes` 与 `sourceCharHeightMm`；生成期在渲染后
  量交付 SVG，门禁在回读时量每张交付 SVG 的根元素（`measureSvgPaperSize`），字高由
  `sourceCharHeightMm(renderer)` 单点给出；量不到显式宽高时回落布局重排，并在报告与
  `figure-check.json` 里标为「未实测」。
- **门禁消费 RC/C**：`figure-gate` 对每张交付 SVG 跑 `checkFigureRendering`，并把 sidecar 的
  `geometry.findings` 一并计入 fail 判定、报告与 `figure-check.json`；`inputs_hash` 并入渲染器名、
  矢量图内容哈希与 C 结论（RC/C 结论由这些输入决定，否则改 sidecar 就能翻结论而哈希不变）。

## Alternatives considered

- **保留两套字框、只调引线间隙** — 落选。间隙是标量，改它只能把一处误报换成另一处；横引的贯穿
  来自宽度差（0.5em vs 0.6em）、竖引的净距来自升降差（1.0/0.2 vs 0.75/0.12），必须统一模型。
- **引线止点仍按「基线 − gap」** — 落选。基线不在字框中心：横引会从字的下缘起步，斜引会穿进
  框内，复核侧继续报贯穿。按射线求框边界是唯一与复核同口径的解法。
- **给 V7 按渲染器硬编码画幅/字号** — 落选。graphviz 的画幅取决于图拓扑与 dot 版本，再写一套
  估算器就是第三份真相；直接量交付 SVG 的根元素尺寸没有估算误差。
- **`skipLayoutRules` 跳过 graphviz/CAD 的 V7** — 落选。跳过会把「没量」呈现成「通过」；实测后
  照判才能既消掉假失败、又保留超框/字高告警。
- **RC 映射在工具与门禁各写一份** — 落选。同一张图在两个入口会得到不同规则号/级别；改为
  `render-check-rules.ts` 单点导出。
- **门禁只把 RC/C 写进报告、不参与阻断** — 落选。这正是本次要修的「门禁假通过」；RC1/C9 与
  V2 同属「交付物读不出」，必须同权。

## Consequences

- 工具入参结构未变（`inputSchema` 零改动），llm-replay fixture 不需重录。
- 引线可见长度会随标号宽度缩短（3 位横引最短约 1.8mm）；标号落位与旧坐标不再逐位一致，
  相关单测改为断言几何性质（止点不进入字框、轴向间隙 = `gapMm`）。
- `figure-check.json` v1 追加可选 `render_check` 与 `paper_size_unmeasured`；`inputs_hash` 对纯矢量
  案件也随 SVG 内容变化，审计语义更强（旧结论的哈希不再复现，但契约版本与读取方不变）。
- 曲线图的刻度值/图例间隙由 4px 提到 6px（≈1.59mm），以满足 RC2 的 1.5mm 净距；CAD 图号注记
  基线由「纸面下缘 −2mm」下移到 −1.2mm。两处都是为了让渲染器产物自己通过复核，否则门禁会
  对每张曲线图稳定报 6–9 条 warn。白色填充（无描边）不再计作图线，画布边框不再被当成贯穿文字
  的线条。
- 生成期核验从「渲染前」移到「渲染后」：V7 用的是真实画幅；渲染失败时不再产出核验快照
  （失败路径本来就不落 sidecar）。
- CAD 标号会避开图号注记带，可落位空间略减；无标注/无图号的图幅与旧行为逐位一致。

## Review follow-up: three deferred items (2026-10-26)

首轮评审把三项判为「不影响主干、留待后续」，本 PR 一并收口：

- **跨层计数去重**：`figure-gate` 新增 `gate-reconcile.ts`。同一图上 `C9`（标号越出图幅）与
  `RC5`（墨迹越出画布）、`C11`（标号退化无引线）与 `RC1`（文字被贯穿）是同一次缺陷的两层
  证据，报告计数按图合并（取两侧较小值，避免吞掉额外缺陷）。阻断仍用 `rawFail`，原始发现
  逐条留在报告与 `figure-check.json`，合并理由单列「跨层重复观测」一节。
- **CAD 标号字号按法域**：新增 `cad/ref-font.ts`，CNIPA 沿用 3.0mm，有 3.2mm 法定下限的
  PCT/US 取 3.5mm（与图号注记同号，留 0.3mm 打印余量）。渲染、`sourceCharHeightMm`（V7
  判据）与落版页装配共用 `cadRefFontMm(jurisdiction)`；`sourceCharHeightMm` 增加可选辖区
  参数，生成期与门禁都传案卷辖区。
- **`render-check.ts` 拆分**：1639 行按职责拆为 `render-check-types`（公共/内部类型）、
  `render-check-scan`（SVG 遍历/量测）、`render-check-geometry`（线段/包围盒/可见性）、
  `render-check-findings`（五类判据）；`render-check.ts` 保留公共类型再导出与总装入口。
  四个实现文件均 <800 行，架构基线的 file-size 豁免随之删除。

### Alternatives considered (follow-up)

- **按规则号直接相减** — 落选。`RC1` 可能有多条（不同文字），直接减去 `C11` 会把无关的贯穿
  缺陷吞掉；按图取两侧较小值只合并可对应的部分。
- **只改报告文案、保留相加** — 落选。数字仍是虚高，审计时无法区分「一个越界的两种证据」与
  「两次独立越界」；原始和与去重值同时留痕才两者都不丢。
- **所有法域统一 3.5mm** — 落选。CNIPA 无附图专有字高条文，3.0mm 是既有交付口径；无依据地
  放大标号会压缩可落位空间，改变既有 CAD 图的版式。
- **继续给 1600 行文件开基线豁免** — 落选。豁免只该冻结存量；拆分后四个模块各司其职，
  后续改判据不必在 1600 行里定位，也避免「新增 5 行就再追认一次基线」。
