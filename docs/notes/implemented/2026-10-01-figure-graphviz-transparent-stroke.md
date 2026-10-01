# Agent Note: graphviz `stroke="transparent"` 归一化为 `none`（跨 dot 版本的黑白守卫兼容）

Status: implemented

## Problem

`renderFigureSvgWithGraphviz` 的加工链在注入 `data-ref` 之前跑黑白守卫 `assertBlackWhite`：所有 `fill` / `stroke` / `color` 取值只允许 `none` / `#000000` / `#FFFFFF`（《专利审查指南》一部一章 4.3 / 4.6）。归一化函数 `normalizeColors` 只把关键字色名 `black` / `white` 换成十六进制，`transparent` 原样穿过 ⇒ 被守卫判成「非黑白颜色」并 fail-closed。

谁会撞上：**graphviz ≤ 2.44 的部署**。该版本会给整图背景框输出

```
<polygon fill="white" stroke="transparent" points="-4,4 -4,-403 220,-403 220,4 -4,4"/>
```

（graphviz issue #1863，报告者用 2.44.1；Ubuntu 22.04 自带的 2.42.2 同样如此）。`transparent` 在 SVG 1.1 里并不是合法的涂料值——上游认为这个多边形本就不该被生成。后果是**该环境下 graphviz 附图通路整体不可用**（在渲染阶段 fail-closed），而不是降级出一个次品。

为什么长期没被发现：本机 homebrew 的 dot 是 16.1.0，不输出该值；CI 原先不装 graphviz，那几条真机用例整组 skip，日志读起来仍是绿的。本批次给 CI 装上 apt 版 graphviz（2.42.2）后，5 条真机用例首次真正执行并全部失败，才把它顶到台面上。

## Decision

在 `normalizeColors` 里把属性形态的 `fill|stroke|color="transparent"` 改写成 `none`，**不动守卫本身**。

两条独立收益：

1. **语义等价，且比留着更安全**：`transparent` 是「无涂料」，与 `none` 等价；但它不是 SVG 1.1 的合法值，不认它的渲染器会回退成**黑色描边**——交付图上凭空多出一圈黑框（上游 issue 最初正是这么被报出来的）。改写成 `none` 消除该风险。
2. **产物与 dot 版本解耦**：同一份 DOT 在 2.42 与 16.1 下产出同一份 SVG。否则同一案件的附图会随渲染机器的 dot 版本漂移，而附图是**交付介质**（其 sha256 被 sidecar 与标注链路引用）。

守卫保持严格：`transparent` 归一化后不再出现，「只允许 none / #000000 / #FFFFFF」这条不变式一字未改，仍会拦住真实彩色（例如 graphviz cluster 默认的 `lightgrey`）。归一化只覆盖属性形态——dot 的颜色都走属性；若将来某个版本改用内联 `style`，守卫会 fail-closed 报出来，而不是静默放过。

## Alternatives considered

- **把 `transparent` 加进守卫白名单**（与 `none` 并列）——改动最小，但会把非法值**留在交付物里**：不认该关键字的渲染器回退成黑描边，等于把上游 bug 转嫁给读者；且同一案件的产物随 dot 版本漂移。
- **CI 改装新版 graphviz（源码编译或第三方源）绕开差异**——把真实用户环境（Ubuntu LTS 自带 2.42）的兼容性问题从 CI 里藏起来；本批次装 graphviz 的初衷恰恰是让「无信号」不再冒充「通过」。
- **CI 不装 graphviz、维持 skip**——回到「跳过被读成通过」，与 `AGENTS.md` 铁律 11（降级但不静默）直接冲突。
- **按背景多边形的形状（`points="-4,4 …"`）特判**——把上游的临时产物形态写进本仓契约，换个 dot 版本形状一变就再次 fail-closed。
- **改用 WASM 后端（viz-js）取代子进程 dot，从根上回避版本差异**——后端选择是既有能力（`dot` 后端可配），但会替部署决定依赖形态，且 WASM 后端有 64 000 字符规模上限（见 P0-6），不能作为通用替代。

## Consequences

换来：graphviz ≤ 2.44 的部署（含 Ubuntu 22.04 默认包）不再在渲染阶段整条 fail-closed；交付产物不因 dot 版本而异；CI 首次真跑那 5 条真机用例，把该差异变成常驻回归面。

付出与边界：

- 本机没有旧版 dot，**该归一化的真机验证只发生在 CI**（apt 2.42.2）；本地用上游 issue #1863 的原始产物片段做钉子用例（`tests/patent/figuregen/dot.spec.ts`）。
- 归一化是按属性形态做的正则替换；若某 dot 版本改用内联 `style="stroke:transparent"`，会走守卫 fail-closed（响亮失败，不是静默放过）。
- **未实测**：2.42 与 16.1 之间是否还存在其它产物差异——本批次只修了 CI 已暴露的这一条。
