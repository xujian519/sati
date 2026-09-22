# Agent Note: Graphviz WASM 渲染后端（figuregen/render-viz-wasm）

Status: implemented

## Problem

`renderFigureSvgWithGraphviz` 把 Graphviz 布局绑死在系统 `dot` 二进制上：`resolveDotBinary()` 缺 dot 即 fail-closed，工具层只提示 `brew install graphviz`。于是"用 graphviz 布局画复杂大图"这个增强能力，在**没有系统 graphviz 的机器**（尤其桌面端分发——用户不会去 `brew install`）上直接不可用。而 Graphviz 有官方 WASM 构建（`@viz-js/viz`，wasm 内嵌在 `dist/viz.js`），可以把布局能力打包进应用本身。

难点不在"调 WASM"，而在 Sati 的**加工链**（剥离头部 / 颜色归一化 / 黑白不变式扫描 / `data-ref` 注入 / readback 自检）是否对另一套后端产出同样成立——WASM 引擎版本与系统 dot 不必一致，输出形态可能漂移。

## Decision

1. `render-graphviz.ts` 抽出 `DotRunner` 接缝：`(dot, signal?) => Promise<string>`（返回 SVG 文本）；`createSubprocessDotRunner(dotPath, timeoutMs?)` 是默认后端（`dot -Tsvg`：DOT→stdin、SVG→stdout）。`renderFigureSvgWithGraphviz(spec, { runner?, dotPath?, jurisdiction?, timeoutMs? })`：给了 `runner` 就用它、**不再要求 dot 二进制**；加工链一行未动，两种后端共用同一份 `postProcessGraphvizSvg` + readback 自检。
2. 新增 `render-viz-wasm.ts`：`createWasmDotRunner({ loadViz? })` 惰性 `import("@viz-js/viz")`（不进启动路径）、实例成功创建后缓存、**失败不缓存**（瞬时失败下次仍可重试）、渲染错误原样上抛、已 abort 的 signal 立即拒绝且不触发加载。失败文案引导 `SATI_FIGURE_RENDERER=builtin` 或 `brew install graphviz`。
3. `SATI_FIGURE_RENDERER` 值域加 `graphviz-wasm`。工具层 `graphviz-wasm` 分支**不解析 dot 二进制**；WASM 加载失败 fail-loud，**绝不静默回退** builtin。**默认仍是 `builtin`**。
4. 依赖：根 `package.json` `dependencies` 加 `"@viz-js/viz": "^3.29.0"`（与 deepseek-harness pin 对齐；本机解析到 3.30.0）。

### 写码前 spike（真实 @viz-js/viz 渲染 `buildFigureDot` 产出，graphviz 运行时 16.0.0）

- **颜色写法**：输出 `fill="#ffffff"` / `stroke="#000000"` / `stroke="none"`——**已是小写 hex**，既不是 `black`/`white` 关键字、也不是 `rgb()`。`assertBlackWhite`（只认 `none`/`#000000`/`#ffffff`）与 `normalizeColors` 均无需改动，**未放宽 `assertBlackWhite`**（也无需扩 `normalizeColors` 支持 `rgb()`，因为没有 rgb 输出）。原始片段：`<ellipse fill="#ffffff" stroke="#000000" cx="42.16" cy="-202.2" .../>`、`<polygon fill="#000000" stroke="#000000" points="45.66,-158.74 .../>`。
- **title / 节点分组**：输出含 `<title>`，节点分组为 `<g id="node2" class="node">` 且首子元素即 `<title>step</title>`——与 `postProcessGraphvizSvg` 的 title 定位、`parseFigureSvg` 的 `class="node"` 识别**完全兼容**。一处与系统 dot 的差异：WASM 的 `graph0` 分组**没有** `<title>图1</title>`，但加工链只按节点 title 定位、图号 caption 走图尾 `<text>图1</text>`，无影响。
- **viewBox**：`<svg width="92pt" height="228pt" viewBox="0.00 0.00 92.00 228.00" ...>`，`parseCanvasSize` 正常解析。
- 结论：三项全部符合既有加工链契约，**未新增任何 fail-loud 限制**，加工链一行未改。

### 桌面端打包 spike：桌面端能否加载 @viz-js/viz 的 WASM？

**结论：能，无需改 `electron-builder.yml`。**

依据（file:line）：

- **后端不在 asar**：`apps/desktop/electron-builder.yml:97-100` 的 asar `files` 只含 desktop 自己的 `dist/**`、`onboarding/**`、`splash/**`、`node_modules/yaml/**`、`package.json`——与本工具链无关。
- **后端从解包目录运行**：`apps/desktop/scripts/lib/packaged-runtime.sh:59-61` 把 `resources/sati-main-bundle.tar` 解到 `$SANDBOX/sati-main`，再以 `resources/node-bin/node` 启动 `dist/src/cli/sati.js`（`packaged-runtime.sh:169-176`）。
- **该 tar 含整个 node_modules 且无 wasm/viz 排除**：`apps/desktop/scripts/release.sh:552-568` 的 `PDM_ITEMS` 含 `node_modules/`，排除清单在 `release.sh:450-522`，**未见 `*.wasm` 或 `@viz-js*` 排除**；Windows 侧 `apps/desktop/scripts/build-win.bat:341-419` 同口径。
- **WASM 不是独立 `.wasm` 文件**：`@viz-js/viz` 把 wasm 以 JS 字符串内嵌在 `dist/viz.js`（`findWasmBinary()` → `binaryDecode('…')`，无 fetch/readFile `.wasm` 路径）——所以"asarUnpack `*.wasm`"这类顾虑天然不存在。

**实测 vs 推断**：

- **实测**（本机跑过）：wasm 内嵌形态（`file`/`grep` on `dist/viz.js`）；**解包往返**——按 pnpm symlink 布局搭 `sati-main/node_modules/@viz-js/viz -> ../.pnpm/...` → 按 `release.sh` 口径 `tar cf` → `tar xf` 到新目录 → **从解包目录 `import("@viz-js/viz")` 成功实例化并 `renderString` 出 SVG**。
- **配置推断**（未跑真实 DMG/L2）：asar 内容与后端无关、`release.sh`/`build-win.bat` 的 tar 口径含 node_modules 且无相关排除、Windows `relink-pnpm-win.mjs` 重链机制。以上读自 file:line，未做端到端 DMG 验证。

同源旁证：仓库已分发纯 WASM 依赖 `mupdf@1.28`（`apps/desktop/scripts/check-native-win.mjs:13` 记其 `dist/*.wasm`），说明 WASM 打包链路在桌面端已是既有能力。

## Alternatives considered

- **改默认渲染器为 graphviz / graphviz-wasm** — 落选（**为何不改默认**）。内置 `render-svg` 与 graphviz 两路产出的 SVG **结构不同**（内置分组 id 形如 `n-<nodeId>`；graphviz 走 `<g class="node">` + `<title>`，画幅/排版也不同）。改默认会让**全部既有附图快照与产物字节全量变更**，并把"默认路径"从一个无外部依赖的确定性渲染器，换成依赖系统二进制或 WASM 实例化成功的路径——把可用性风险放到默认路径上。graphviz 系后端的定位就是**可选增强**，默认必须保持 `builtin`。
- **graphviz-wasm 加载失败时静默回退 builtin** — 落选。用户设 `SATI_FIGURE_RENDERER=graphviz-wasm` 表达的是"要 graphviz 布局"的意图；静默回退会交付一个**形态不同**的图却让调用方以为走了 graphviz（sidecar 的 `renderer` 字段也会说谎），静默背离意图比显式失败更贵。
- **把 WASM 引到启动路径（顶层 import）** — 落选。1.2MB 实例化期 WASM，绝大多数会话用不到；顶层 import 让每个进程启动都背这个开销，还可能在无 wasm 能力的运行时上启动即崩。惰性 `import()` 只在 `graphviz-wasm` 分支首次渲染时付出。
- **失败也缓存实例 Promise** — 落选。把首次瞬时失败（临时 IO/内存紧张）钉死成"此后所有渲染都失败"，用户只能重启进程。失败不缓存的代价是极端情况下多一次重试，收益是自愈。
- **为 WASM 分叉加工链（扩 `normalizeColors` 支持 `rgb()` / 调定位策略）** — 未触发。spike 实测 WASM 输出与系统 dot 同形（hex 颜色、`class="node"`、`<title>`、`viewBox`），无需分叉；若未来 viz 升级引入 `rgb()` 输出，再扩 `normalizeColors`（**仍不许放宽 `assertBlackWhite`**，黑白不变式是合规底线）。
- **桌面端改 `asarUnpack`/`files` 让 asar 内可加载 wasm** — 不需要。后端不在 asar 内（解包目录运行），且 wasm 内嵌在 `.js` 里；改配置是无目标的变更。
- **`graphviz-wasm` 也支持 `SATI_GRAPHVIZ_DOT` 兜底** — 落选。会让语义含混（用户到底选了 WASM 还是系统 dot），两条后端各有独立取值更清晰。

## Consequences

- 无系统 graphviz 的机器（含桌面端分发）可用 `SATI_FIGURE_RENDERER=graphviz-wasm` 走 graphviz 布局，无需 `brew install`。默认行为与全部既有快照**零变更**。
- `renderFigureSvgWithGraphviz` 的 `runner` 接缝把"渲染后端"与"加工链"解耦：将来换/加后端（如远程渲染服务）只实现 `DotRunner`，加工链与 fail-closed 自检复用。
- `@viz-js/viz` 进入根 `dependencies`，随 `sati-main-bundle.tar` 分发；不进启动路径，只在选中该后端时载入。
- 新增测试 8 例：`tests/patent/figuregen/render-viz-wasm.spec.ts`（替身 loader 五例 + 加工链注入一例 + 唯一真跑 WASM 一例），`tests/patent/figuregen/tools-graphviz.spec.ts` 加无系统 dot 的工具层一例。
- 桌面端结论是**配置推断 + 解包结构实测**，未跑完整 DMG；真实 DMG 上的 WASM 加载未验证（见上"实测 vs 推断"）。
