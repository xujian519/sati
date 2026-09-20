# Agent Note: useSessionStore 的主闭包外化为模块级工厂

Status: implemented

## Problem

`ui/src/stores/useSessionStore.ts` 的 1405 行里，模块级纯函数区（约 660 行）有 24 条直测兜底，
而 `export function useSessionStore()` 的**主闭包 727 行**持有 33 个 `useCallback`、
`Map<string, SessionSlot>` 单例与全部并发时序逻辑——**零覆盖**。要改任何一条取数/合并/
流式语义，先得读完 727 行，且没有任何测试会在你改错时叫住你。

台账 TD-UI-APP-N02 立案时的两条主张（"8 个近同 streaming 函数"与"三处重复拼 `URLSearchParams`"）
在 2026-09-02（PR #241）就已修掉，条目从未回填——所以这一波要处理的不是重复代码，
而是**主闭包的长度与零覆盖**。

## Decision

**方案 B：把 33 个 `useCallback` 整体外化到模块级工厂 `createSessionActions(deps)`，主闭包只留组装。**

- 主闭包 727 → **20 行**：3 × `useRef` + 1 × `useState` + 1 × `useMemo`（依赖 `[setTick]`）。
- 工厂 634 行（`function createSessionActions(deps: SessionActionDeps)`），**体内零 hook 调用**——它是普通函数，不是伪装成函数的 hook。
- **绝不拆子 hook**：主闭包里的 `useRef(new Map())` 是 per-session store 的唯一句柄。若拆成
  `useSessionFetch()` / `useSessionStreaming()` 之类的子 hook，每个子 hook 会各自 `useRef(new Map())`
  ⇒ 变成多份互不可见的 store ⇒ **28 个方法静默失效**：不抛错、日志干净、既有 24 条测试全绿。
  这条红线在派单时写成"违反即任务失败"，并用一条负控制钉住（把 `getSlot` 改成单一共享键 ⇒ 18/18 用例全红）。
- 为了让搬迁后的函数体**零改写**，`deps` 在工厂内解构成**同名局部**（`storeRef` / `activeSessionIdRef` /
  `notifySchedulerRef` / `setTick`），因此没有 `deps.xxx` 前缀改写。

**为什么"单次构造"是等价的（本次最需要论证的一点）**：`useMemo(..., [setTick])` 的依赖是
`useState` setter（身份恒定）⇒ 工厂只执行一次 ⇒ 33 个方法引用永久稳定。而原实现的 33 个
`useCallback` 的依赖数组**全部是彼此**（12 × `[getSlot, notify]`、4 × `[notify]`、9 × `[]`、
其余 6 个是 `[updateStreamSlot]` 等同族），链最终收敛到 `[]`——也就是说**它们原本就是永久稳定的引用**。
两边都是"永不重建"，所以引用稳定性的粒度没有变化。

## Alternatives considered

- **拆成多个子 hook（每个负责一族方法）** — 看起来最"模块化"，实际是**静默失效**：每个子 hook 新建一份
  `useRef(new Map())`，28 个方法各写各的 store，没有任何报错。这是本任务明确禁止的形态。
- **33 个 `useCallback` 保留在主闭包、只把 body 外化成纯函数（薄转发壳）** — 主闭包约 200 行，
  搬迁后 token 等价性更弱（每个 callback 的箭头都要改写成 `(...args) => doX(deps, ...args)`），
  认知负载也更高。既然依赖图证明引用本就永久稳定，整体外化没有代价。
- **把 `useMemo` 依赖写成 `[]`（而不是 `[setTick]`）** — 更"稳定"，但 `setTick` 是 `useState` setter
  （恒等），写进去不影响重跑条件，却能让 eslint `react-hooks` 满意、也让"为什么可以只构造一次"
  这件事在代码里自解释。用 `[]` 会依赖"setters 恒等"这条隐式知识。
- **顺手把模块级纯函数区也按族拆文件** — 与本波目标无关（那 660 行已有 24 条直测兜底），
  且会让 diff 失去"可逐 token 验证"的边界。
- **保留主闭包 ≈150 行（计划的目标值）** — 目标值来自"薄转发壳"那一形态。既然选了整体外化，
  20 行是自然结果，不需要为凑数字往回填转发壳。

## Consequences

- 主闭包 727 → 20 行；文件 1405 → 1346 行（其余是工厂新增的 deps 类型与组装骨架）。
- **新增 18 条 `renderHook(useSessionStore)` 用例**（新文件 `useSessionStore.actions.test.tsx`），
  主闭包从零覆盖变成有网：取数/分页/刷新、实时并入与水位剪除、流式 delta 合并与 finalize、
  thinking 与 text 分行、subagent detail 流、per-session 隔离、仅活跃会话触发重渲染、活动去重。
- **4 处负控制**：① 翻转 `:1176-1179` 的 "Patch merged BEFORE mutating existing" 顺序 ⇒ 唯一 1 条红
  （投影引用未变，UI memo 会持旧数组）；② per-session 隔离换成单一共享键 ⇒ 18/18 全红；
  ③ 去掉 `refreshFromServer` 的空响应守卫 ⇒ 1 条红；④ 去掉 `shouldKeepRealtimeAfterServerRefresh`
  的 `__streaming_` 分支 ⇒ 1 条红。
- **逐 token 等价性**：34/34 条搬迁（33 个箭头 + `getNotifyScheduler`）逐 token 相同；模块前区
  token 一致（仅删掉未使用的 `useCallback` import）；hook 创建顺序 `useRef,useRef,useState,useRef`
  不变；return 对象 28 键顺序一致。
- 台账 TD-UI-APP-N02 回填 done，并把"8 个近同函数 / 三处重复 URLSearchParams"两条主张标注为
  **2026-09-02 已修、条目未回填**，位置口径一并更正。
- 未做浏览器验证：本波**无 UI 变化**（纯状态层重构，组件渲染路径未动），jsdom `renderHook` 即验收面。
