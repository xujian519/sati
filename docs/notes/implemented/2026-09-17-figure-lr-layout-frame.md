# Agent Note: LR 布局的画幅与步进按方向取轴（修 block 附图被画幅裁掉）

Status: implemented

## Problem

`layoutFigure`（`src/patent/figuregen/layout.ts`）的**落点与画幅不同源**：节点坐标按 `direction`
分轴摆放（LR: x 逐层递增、y 层内堆叠），但画幅外延 `contentW`/`contentH` 与副轴步进一律按
TB 语义计算（沿轴=节点宽、层间步进=层高），于是 LR 图落点溢出 viewBox 被裁掉：

```
3 节点 LR 方框图：画幅 172×359，节点最右 348（+ 节点宽 102）→ 超出画幅
栅格化实测：第 1 个节点完整、第 2 个节点被右边界切断、第 3 个节点与全部边线不可见
```

影响面不小：`defaultDirection(kind)` 对 `kind: "block"`（装置框图，专利附图常见类型）返回
`"LR"`，即**未显式指定方向的方框图全部走这条错误路径**；同层多节点还会因副轴按层高（而非
层内最宽节点）步进而互相重叠。此外 V7 的 paper-fit 判据（`check.ts`）取的就是这个画幅，
故 block 图此前是**用错误画幅在判超框**（漏报超宽）。

## Decision

画幅外延与副轴步进按方向取轴，TB 分支逐位不变（无收益的渲染漂移不做）：

| 量 | TB | LR |
|---|---|---|
| 层内外延 | 层内横向并排：Σ 节点宽 + `SIB_GAP` | 层内纵向堆叠：Σ 节点高 + `SIB_GAP` |
| 画幅宽 | max(层内外延) | Σ(层内最宽节点) + `LAYER_GAP` × 间隔 |
| 画幅高 | Σ 层高 + `LAYER_GAP` × 间隔 | max(层内外延) |
| 沿轴步进（落点） | 节点宽 + `SIB_GAP` | 节点高 + `SIB_GAP` |
| 副轴步进（落点） | 层高 + `LAYER_GAP` | 层内最宽节点 + `LAYER_GAP` |

## Alternatives considered

- **取消 LR（一律按 TB 渲染）** — 落选：LR 是系统框图的版式惯例（`defaultDirection("block")`
  即 `"LR"`），且 `direction` 是 `FigureSpec` 的公开字段；取消等于用改契约来回避布局缺陷。
- **先算 TB 布局再整体转置（swap x/y 与画幅宽高）** — 落选：节点盒不是正方形，转置会把
  `148×45` 的标签盒变成 `45×148`，文字换行与盒宽全部失配（字宽已按字符类别度量，不能靠
  转置蒙对）。
- **只修画幅、不修副轴步进** — 落选：同层节点仍会重叠（副轴按"层高"而非"层内最宽节点"
  步进），画面错乱从"被裁掉"变成"叠在一起"，问题没解决。
- **顺手重写布局器（统一一个方向无关算法）** — 落选：TB 是主路径且当前正确，重写会带来
  无收益的渲染漂移、快照更新与 V7 数值波动；只做"按方向取轴"的最小修正更容易复核。
- **让 LR 的层内节点垂直居中** — 落选：与 TB 的层内左对齐不对称，且会引入新的浮点位置
  差异；保持"沿轴自 MARGIN 起依次排布"的一致语义。

## Consequences

**换来**：LR/block 附图完整落在画幅内（无裁剪、同层无重叠）；V7 的 paper-fit 判据对 block 图
首次基于真实画幅；生成侧基准新增 LR 用例（3 节点落在可印区、6 节点超宽的对照）。

**付出**：

- LR 图外观变化：画幅由"窄而高"变为"宽而扁"，历史 block 附图的 SVG/HTML 尺寸都会变
  （HTML 版式按新的纸面宽度算统一缩放系数，A4 稿的缩放/字高随之变化）。
- 打印字高的判定随之变化：此前 LR 图按错误画幅算出的缩放系数偏小/偏大，V7 font_size 的
  报与不报会翻转（现按真实画幅计算；`block-latin-long` 用例即报出 1.78mm 的 warn）。
- 无兼容开关：错误画幅下的产物（裁剪图）没有保留价值，故不做"旧行为开关"。

## 相关

- 代码：`src/patent/figuregen/layout.ts`（画幅外延 + 副轴步进）
- 测试：`tests/patent/figuregen/render.spec.ts`（LR 画幅覆盖全部节点 + 同层不重叠的防回退断言）、
  `tests/scripts/figure-benchmark/gen-compliance.spec.ts`（LR 用例落进可印区的语义锚点）
- 基准：`scripts/figure-benchmark/gen-cases.ts`（`block-lr-3node` / `block-lr-wide`）
