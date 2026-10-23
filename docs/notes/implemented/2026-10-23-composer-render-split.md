# Agent Note: ComposerV2 派生状态与渲染区块拆分（sweep B2.2）

Status: implemented

## Problem

`ui/src/components/chat-v2/ComposerV2.tsx` 在 sweep 基线（`ea8029ff3`）上是 **1188 行**，其中 `ComposerV2` 函数 **741 行**（判据 ≤400），且**此前没有任何测试**。函数里同时塞着四类互不相干的职责：

- 19 条派生语句（禁用态、发送按钮标题、上下文用量、思考模式有效值、三个菜单的选中项文案）；
- 上下文用量纯逻辑（`getContextStatus`、固定开销拆分、百分比/格式化和 tone 映射）；
- 两个选项表与一个阻断工具集合（权限模式、运行模式、`BLOCKING_PERMISSION_TOOLS`）；
- 7 个可独立成块的 JSX 区块（运行模式菜单、权限菜单、思考菜单、上下文按钮与气泡、busy-send 提示、提交/中止按钮）。

行数棘轮把它列为 ≥800 行文件豁免（BF-17）。计划 B2.2 的目标是：token budget 展示块 → `ContextWindowIndicator`，派生状态 → `useComposerDerivedState`，函数 ≤400。

## Decision

**状态与 effect 留在父级，只搬"纯派生 + 纯展示"。** 父组件保留 `useTranslation`、四个 `useState`（三个菜单 + 上下文气泡）、`permissionSelectorDisabled`、plan 模式的 `useEffect`、banner 条件、附件/表单/textarea/拖拽层与内联中止按钮；其余按关注点外置：

| 新文件 | 行数 | 内容 |
|---|---|---|
| `contextStatus.ts` | 154 | `ContextStatus` 类型、tone 样式表、`readNumber`/`formatTokenCount`/`formatContextPercentLabel`/`resolveContextTone`/`splitFixedOverhead`/`getContextStatus` |
| `composerOptions.ts` | 66 | `PermissionModeOption`/`RunModeOption` 类型、两张选项表、`BLOCKING_PERMISSION_TOOLS` |
| `useComposerDerivedState.ts` | 145 | `resolveSendTitle` + 19 条派生语句（hook 内**零 hook 调用**，`t` 改为入参，返回父级用到的 15 个值） |
| `ContextStatusPopover.tsx` | 81 | 原同文件具名导出的气泡组件（逐 token 搬迁） |
| `ContextWindowIndicator.tsx` | 46 | 上下文按钮（原按钮 div，不含气泡） |
| `ComposerRunModeSelector.tsx` | 142 | 运行模式菜单 |
| `ComposerPermissionSelector.tsx` | 137 | 权限模式菜单 |
| `ComposerThinkingSelector.tsx` | 109 | 思考强度菜单 |
| `ComposerBusySendNotice.tsx` | 58 | busy-send 提示（返回 fragment，DOM 不变） |
| `ComposerSubmitButton.tsx` | 50 | 发送/中止按钮 |

**结果：`ComposerV2` 741 → 387 行（≤400），文件 1188 → 508 行（≤800，豁免移除），最大新函数 123 行。**

三条保持行为不变的取舍：

1. **气泡不放进 `ContextWindowIndicator`。** 气泡是 `absolute right-0 bottom-full`，定位基准是工具栏容器；塞进 46px 宽的 indicator 会多一层 `relative` 容器并改变裁剪/定位，DOM 也不再逐字节一致。它继续作为工具栏的直接子节点，位置和注释原样保留。
2. **组件不包 wrapper。** 所有新组件直接返回原 JSX 根节点；busy-send 返回 fragment。任何为了让边界"更好看"而加的 div 都会改变 DOM，直接破坏 A/B 指纹。
3. **菜单状态留在父级。** 子组件只收 `isXxxMenuOpen` + `setIsXxxMenuOpen`，不在组件内部建 state；这样父级 effect（切到 plan 关权限菜单）和渲染顺序完全不变。

## Alternatives considered

- **把所有 state 一起搬进 `useComposerState`** —— 落选。四个菜单 state 被父级 effect、工具栏与三个组件共用；搬走会新增一层受控 props 与 setter 依赖，收益只是父函数少几行，却把 hook 顺序和 effect 依赖搞复杂。本次只搬无状态的派生。
- **抽一个 `ComposerToolbar` 承载全部工具栏** —— 落选。工具栏里权限选择器带 plan 禁用逻辑、上下文气泡是浮层、busy 提示是条件 fragment，合成一个组件只会得到第二个 400+ 行文件，边界反而更糊；六个小组件各管一件事更好审。
- **把 `getContextStatus` 留在 `ComposerV2` 里只搬 JSX** —— 落选。它是纯函数且已被 `MessagesPaneV2.render.test.tsx` 直接导入，留在主组件会让测试为了一个纯函数拉进整棵组件树；移到 `contextStatus.ts` 后主文件更薄，测试导入也更干净。
- **搬 JSX 时顺手改写成新组件 API / 调整结构** —— 落选。本次的证明方式是逐 token 对拍，任何顺手改写都要逐条解释并扩大证明范围；"只搬家、不改字"能让 58 项全部精确匹配。

## Verification

- **判据**：`ComposerV2` 741 → **387**；文件 1188 → **508**；新增函数最大 123 行；`architecture-baseline.json` 的 file-size 存量豁免 **37 → 36**（BF-17 脱表）。`MessagesPaneV2.render.test.tsx` 因 import 从一行拆成两行 1234 → 1235，已由 `--update-baseline` 追认。
- **测试先行**：`ComposerV2.test.tsx`（313 行，4 组共 17 例）覆盖发送/中止/排队标题、三种菜单、上下文三态、banner/附件/busy/file 下拉；拆分前先在原实现上全绿，拆分后 17/17。`vitest.setup.ts` 的 lucide mock 补了 `CircleHelp` / `Gauge` / `MinusCircle`（新测试渲染组件时 `thinkingModes` 会导入）。
- **逐 token 证明**：基线固定为 `ea8029ff3`（不是 HEAD）；**58/58 全绿、零改写**——16 项声明/纯函数、19 条派生语句、8 条父级保留语句与参数表、6 个 JSX 块、1 个父级残余 render、3 项 hook 顺序（原有 6 个 hook 顺序不变，新 hook 为第 7 个且内部零 hook）、5 组 prop 接线。新增的 hook 解构与子组件 props 属装配胶水，单列在 wiring 检查中；派生语句的 `t` 由闭包变量改为 hook 入参，token 序列不变。
- **负控制（3 组，均恢复后复跑）**：
  1. `showAbortButton` 的 `&& !hasDraftContent` 翻成 `&& hasDraftContent` → **1F/16P**（预期：空闲且可中止用例）。
  2. `optionDisabled = isPlan && !planModeAvailable` 翻成 `isPlan && planModeAvailable` → **2F/15P**（预期：运行模式选择 + plan 不可用两条）。
  3. 纯文案对照：agent 描述默认值末尾加一个句号 → **测试 17/17 仍绿，proof 57/58 红**（firstDiff 精确落在那条字符串），证明守卫能抓测试覆盖不到的文案漂移。
- **浏览器双视口 A/B（类型 B）**：真实 `pnpm dev`（Vite 5173 / server 3001 / gateway 19789），Chrome headless + CDP，桌面 1440×900 dpr1 与移动 390×844 dpr2；每个视口 11 个状态（首屏、输入、三菜单开/关、气泡开/关、清空），比对 DOM outerHTML SHA-256、8 个控件/容器 rect 与菜单 rect、控件 title/disabled/aria、菜单选项、popover 文本、横向溢出与控制台错误——**222/222 全部相等**，两侧控制台 error / page error / unhandledrejection 均为 0。截图仍不可得（本环境 CDP `captureScreenshot` 超时），证据以 DOM 指纹 + 布局断言替代。
  - **有意未验证**（谁因此漏了什么）：真实发送/agent 执行（会跑本机真实项目，跳过；由 17 条用例与负控制承担）；附件、文档引用、权限请求/审批横幅、busy/queued（需真实在途回合；由用例承担）；斜杠命令/文件提及与拖拽（由既有测试与 token 证明承担）；token budget 已知/告警/阻塞（当前会话无上报；由气泡用例承担）；plan 禁用态（本机模型可用 plan；由用例 + 负控制 2 承担）；其他 locale（未切语言，指纹不覆盖 i18n 文案）。
- **门禁**：`pnpm check` 退出码 0；`pnpm --filter sati-ui test` **199 文件全绿（1522 例）**——首轮 `server/routes/config.test.js` 的 rate-limit 用例在并行负载下出现 `Unauthorized` 解析失败，单文件重跑与全量重跑均绿，判定为既有 flaky（与本改动无关，未改其代码）；`pnpm test` **5968 例 / 5963 pass / 0 fail / 5 skipped**（legal-search 本地法律库缺失 4 条、graphviz 真机用例非 CI 跳过 1 条、patent_drafting_v1 未录制 fixture 1 条——共 6 个 SKIP 标记，node 顶层计 5 个 skipped）；`pnpm test:pr-tooling` 197/197。跳过项如实记录：本环境未验证法律检索集成与 graphviz 真机、patent 全链路 replay。
- **生成物**：`gen:event-matrix`、`gen:doc-claims` 重生成后无 diff；`measure:update` 反映 ui/src 664 → 675 文件、103986 → 104608 行，`ComposerV2` 从两个 Top 榜的 741/1188 位置移到 387 行条目并脱出文件榜。

## Consequences

- **换来**：主组件只留状态与装配，7 个区块各有名字与独立 props；此前零测试的 Composer 现有 17 条 jsdom 用例；file-size 豁免少一条。
- **代价**：道具从闭包直读变成显式 props（五个受检组件共 35 个 prop 接线，另两个搬迁组件的 props 在 JSX 块检查内），父组件多了一次 `useComposerDerivedState` 解构；这些是拆分本身不可避免的胶水，已由 wiring 检查固定。
- **交叠风险**：B2.1（#745，未合并）会同时改 `metrics.md` / `architecture-baseline.json` / backlog §38.2；本分支按自身基线生成，合并顺序会影响计数，需由后合并者在最新 main 上重建生成物并统一 §38.2 计数，不手改。
