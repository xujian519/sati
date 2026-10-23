# Agent Note: B2.1 MessagesPaneV2 渲染编排六簇外置（#646）

Status: implemented

## Problem

`ui/src/components/chat-v2/MessagesPaneV2.tsx` 的 `MessagesPaneV2` 是 **824 行**的 god function，文件 **1183 行**
（≥800 行存量豁免）。`#159 N03` 已把虚拟化层与占位链拆走，但主组件仍把六类互不相同的职责压在同一闭包里：

1. **交互状态**：消息 key 的 WeakMap/计数器、可展开进程行、子代理详情开关、增量缓存 ref；
2. **子代理投影**：活动过滤、`subagentThinkingById` 的逐次扫描与引用复用、打开态活动；
3. **可渲染时间线**：消息过滤、最后 turn 动作定位、实时进程分组、增量缓存、`useMessageVirtualization`；
4. **实时状态**：运行中子代理、流式 thinking 预览、底部状态步骤；
5. **渲染器**：`renderLiveProcessDetailMessages` / `renderLiveProcessGroup` / `renderMessageItem` 三个大回调；
6. **搜索与布局**：`useChatHistorySearch` + 历史搜索注册 + 底部布局告警探针。

计划 B2.1 判据：**`MessagesPaneV2` ≤350 行，且 38 条 render 测试整块 green**。

## Decision

按**原代码中 hook 的连续区间**外置，而不是按渲染区块重切：

| 模块 | 文件行 | 函数行 | 内容 |
|---|---|---|---|
| `messagesPaneTypes.ts` | 69 | — | `MessagesPaneV2Props`、`KeyedRenderableMessageItem`、`RenderableItemsCache` |
| `messagesPaneHelpers.ts` | 62 | — | 9 个消息分类/计数/fork 判定纯函数 |
| `useMessagesPaneInteractionState.ts` | 67 | 61 | key Map/计数器、增量缓存 ref、进程行展开、子代理开关 |
| `useSubagentActivityProjection.ts` | 77 | 64 | 活动投影与 `subagentThinkingById` 引用复用 |
| `useRenderableMessageTimeline.ts` | 256 | 218 | 过滤/分组/增量缓存/虚拟化/实时 turn 锚点 |
| `useLiveStatusView.ts` | 78 | 59 | 运行中子代理、thinking 预览、live step |
| `useMessagesPaneRenderers.tsx` | 307 | 249 | 三个渲染回调（含 683 tokens 的 `renderMessageItem`） |
| `useMessagesPaneSearchAndLayout.ts` | 104 | 77 | 搜索 hook/注册与布局告警 effect |

结果：`MessagesPaneV2` **824 → 338 行**，文件 **1183 → 360 行**，脱离 §38.2 ≥800 清单，
`architecture-baseline.json` 存量豁免 **37 → 36**；最大新函数 249 行，未产生新的 ≥300 行 god function。

关键约束：

- **hook 调用顺序不变**。六个自定义 hook 按原语句的连续区间切开，调用点顺序即原 hook 顺序；
  证明脚本把子 hook 按调用点展开后与基线逐 token 比较（41 tokens），完全一致。
- **返回的 JSX 整块未动**（332 tokens 逐 token 相同），组件树、条件分支、className 均未改。
- 单例句柄（`messageKeyMapRef`、`generatedMessageKeyCounterRef`、`renderableItemsCacheRef`）仍各只有一份，
  `renderableItemsCacheRef` 经参数传入 timeline hook，未在子 hook 内重建。
- `useMessageVirtualization({ keyedItems, scrollContainerRef })` 仍在 timeline hook 内、参数同序。

## Alternatives considered

1. **只抽纯函数与类型，hook 体留在组件** —— 824 行只降到 ~650 行，达不到 ≤350 判据；
   闭包内的状态、effect 与三个渲染回调才是阅读成本主体。
2. **按渲染区块拆（header / list / footer 子组件）** —— 会改变组件树与条件渲染位置，
   从类型 A 变成类型 B（需双视口浏览器 A/B），且 `renderMessageItem` 需要向 `MessageRowV2`
   透传约 25 个 prop；这正是 `#159 N03` 记录的先例：得到的是纯搬运层，读者仍要跨文件跳转。
3. **合成一个 `useMessagesPaneController`** —— 只是把 824 行 god function 改名为 god hook，
   没有缩小任何阅读单元，也拿不到六个可独立命名的职责边界。
4. **先把 `renderMessageItem` 改成组件** —— 前置条件是收敛 `MessageRowV2` 的 props 面（`#159 N03`
   已记为台账项），属行为面重构；本项只做位置迁移，不把两个问题捆在一起。
5. **在组件内保留一两个小 hook（如 interaction state）不拆** —— 会破坏「原 hook 连续区间」这一可证明边界，
   让 token 证明的语句映射变复杂，收益也只是少一个文件。

## Verification

- **逐 token 证明 74/74**（基线 `ea8029ff3`，即分支起点 origin/main；AST 定位 + scanner 逐 token）：
  2 个类型别名、14 个顶层函数、44 条搬迁语句（按原语句序号分六组）、14 条组件保留语句、
  **JSX return 332 tokens**、**展开后的 hook 顺序 41 tokens**。声明式改写 3 处：
  1. 增量缓存 ref 的内联对象类型 → 命名类型 `RenderableItemsCache`（类型等价）；
  2. `useSubagentMessages` 第 5 参 `openSubagentActivity?.state` → hook 入参 `openSubagentActivityState`
     （调用点传同一表达式）；
  3. `renderableMessageItems` 的 useMemo 依赖数组补 `renderableItemsCacheRef`
     （ref 由参数传入，仍是稳定值）。
- **负控制**（每轮恢复后复跑 74/74 + 38/38）：
  - C1：`liveProcessHeaderIndex` 的 `index + 1` 改为 `index` → **1 红 / 37 绿**，
    失败用例正是 "renders live processing time above the active assistant turn with activity status"；
  - C2：`shouldRenderBottomLiveStatus` 取反 → **6 红 / 32 绿**，覆盖底部状态与三条压缩状态用例；
    *过程记录*：首次把 `hasOpenEndedLiveProcessGroup` 与判定**同时**取反，两次取反互相抵消（语义等价），
    测试 38/38 全绿——这不是负控制，而是无效改写；随后改为只取反最终判定才得到上述 6 红；
  - C3：仅把 `max-w-[860px]` 改为 `max-w-[861px]` → 证明 **73/74**（唯一红在 JSX 字符串 token），
    测试 **38/38** 全绿，证明守卫能抓到测试不覆盖的文案漂移。
- **门禁**：`pnpm check` EXIT=0；UI `vitest run` **198 文件 / 1505 用例**全绿
  （首次全量有 1 个无关用例 `Annotator.test.tsx` 因 i18n 初始化竞态失败，单文件复跑 3/3、
  全量复跑全绿，未当成通过项）；根 `pnpm test` 5968 用例（5963 pass / 0 fail / 5 skip，已知降级项）；
  `pnpm test:pr-tooling` 197/197。
- **生成物**：`gen:event-matrix`、`gen:doc-claims` 无 diff；`architecture-baseline.json` 删除
  `MessagesPaneV2.tsx:1183`（37 → 36）；`metrics.md`：组件 824 → **338**、文件 1183 → **360**；
  本次刷新同时把 `src/patent/figuregen/inkscape-renderer.ts`（916 行）收入 Top 30——
  该文件已在 §38.2 登记为 BF-34，属生成物基线的既有漂移，与 B2.1 无关。
- **类型判定为 A（状态层重构）**：返回的 JSX 与三个渲染回调体逐 token 未变，无组件树/分支重排；
  按 checklist §0 以 jsdom + token + 负控制为验收面，未做双视口浏览器 A/B。
  **有意未验证**：真实浏览器中的虚拟滚动、会话切换与搜索定位交互不由本项覆盖，
  由既有 38 条 render 测试承担。
