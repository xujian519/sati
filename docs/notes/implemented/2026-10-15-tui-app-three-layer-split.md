# Agent Note: TuiApp 根组件 render/input/state 三层拆分（#646 sweep P2.8）

Status: implemented

## Problem

`src/adapters/channel/tui/app/TuiApp.tsx` 的 `TuiApp` 是 **643 行**的 React 组件（文件 855 行，
在 file-size 棘轮存量豁免内，`backlog §38.2` BF-39 承接项）。它把四类互不相干的东西叠在同一个函数体里：

1. **state 初始化**：`useState<TuiAppState>` 的 20 余字段初值（读权限设置定 mode）。
2. **交互动作（state 层）**：`handleInputChange` / `openViewer` / `openSidebar` /
   `switchToSession`（含 gateway 会话记录回放映射）/ `openToolOutput` / `handleSubmit`
   （命令分派 + `for await (… gateway.submitTurn …)` 事件回流）。
3. **键盘分发（input 层）**：一个 288 行的 `useInput` 回调，按「查看器 → 权限队列 →
   帮助面板 → 侧栏 → 通用」顺序命中第一个可消费分支。
4. **渲染（render 层）**：chatContent JSX + 侧栏布局 + `SessionHint`。

外加模块级的 `handleCommand`（158 行斜杠命令 switch）与 `buildPermissionEntry`。
后果是「读一遍才能改一处」：改键盘行为要穿过 JSX 与动作定义；`switchToSession` 的记录回放
和 `handleSubmit` 的事件回流无法脱离 ink 运行时单独验证。

通过判据（计划 §161 P2.8 原文）：**「拆 render/input/state 三层」**，验证面「adapters 测试 + ink-testing」。

## Decision

**按关注点拆成四个模块，`TuiApp` 收缩为「state 初始化 + useEffect 首帧 + JSX（render 层）」**：

- 新增 `useTuiActions.ts`（state 层，284 行）：`useTuiActions({ gateway, projectKey, stdout, exit,
  state, setState, suppressUntilRef })` 返回七个动作回调；`handleSubmit` 内的 `for await`
  事件回流随 `handleSubmit` 一起迁入。
- 新增 `useTuiInput.ts`（input 层，318 行）：`useTuiInput(params)` 包住那 288 行 `useInput`
  回调，**逐分支原样搬运**（`props.gateway`→`gateway`，其余闭包变量经参数注入）。
- 新增 `tuiCommands.ts`：`handleCommand` + `buildPermissionEntry`（本就是模块级函数，迁出即
  从 855 行文件剥离）。`handleCommand` 签名去掉**从未被使用**的 `openViewer` 形参（既有死参）。
- 新增 `gatewaySurface.ts`：`TuiGatewaySurface = Pick<Gateway, 7 个方法>`——三个拆出模块只依赖这
  7 个方法，测试注入窄 stub 即可（`Gateway` 是 30+ 方法大接口，全量 mock 会稀释判据）。完整
  `Gateway` 结构性满足该 `Pick`，调用点零改动。

关键决策点：

1. **`useInput` 回调整体搬进 `useTuiInput`，不再二次切分**。该回调 288 行 < 300 阈值，落进 .ts 文件后
   不进 god-function 表；再按面板拆会更早触碰「命中第一个分支即 return」的短路顺序，风险大于收益。
2. **`suppressUntilRef` 在 `TuiApp` 创建、注入 actions 与 input 两层**。ctrl 组合键的时间戳抑制
   是两层的接缝（input 写、handleInputChange 读），留在共同上游组件而非任一层。
3. **state 初值 `useState` 与首帧 `listSessions` 的 `useEffect` 留在 `TuiApp`**。二者是组件级
   副作用，移进动作 hook 会让 hook 拥有它不该拥有的生命周期。
4. **不改任何行为**：三分支权限队列、mode 循环、侧栏折叠/游标、提交回流全部逐字节搬运；
   `handleCommand` 的写权限分支经 `SATI_HOME` 隔离后可直测。

## Alternatives considered

- **只做命令外提（P2.8 判据字面最小解）**：`TuiApp` 仍 480+ 行踩 M1 红线，input 层的 288 行
  回调仍锁在组件里不可测。否。
- **把 `TuiApp` 改写成 `useReducer` 状态机**：能更彻底解耦，但要把 20 个 `setState` 调用点全部
  改写成 action，属行为面重构（计划 §1.2 非目标），且 ink 组件无既有测试兜底。否，留待 TUI 有
  ink-testing 基线后另议。
- **保留 `handleCommand` 的 `openViewer` 形参以免动签名**：死参在 `--max-warnings 0` 下是潜在噪声，
  且既然本就在搬家，删它成本为零。否（选择删除）。

## Verification

- `pnpm check` EXIT=0（freshness / config / typecheck / ui-typecheck / lint / format 全链）。
- `pnpm test` **5616 例 / 5611 pass / 0 fail / 5 skip**（行为不变，既有全量语料无转红）。
- 新增 `tests/adapters/tui-commands.spec.ts`：12 例覆盖 `handleCommand`（非命令短路 / `/new` /
  `/switch N` / `/sessions` / `/clear` / `/help` / `/exit` / 未知命令 / `/view` / `/permissions` /
  `/mode`，写权限分支经临时 `SATI_HOME` 隔离）与 `buildPermissionEntry` 的 bash/git 铸造。
- god function（metrics 现查）：`TuiApp` 643 行条目消失；**≥400 存量 25 → 24**（M1 侧 `src/`
  已无 ≥400 god fn），≥300 合计 51 → 50。
- 文件体积：`TuiApp.tsx` 855 → 184 行，脱 file-size 棘轮存量豁免（41 → 40，`--update-baseline`）。
- **事件矩阵 +1（`submitTurn 流 ×14 → ×15`）**：生产者列零变化，消费者聚合计数 +1。根因是
  `listTsFiles` 只扫 `.ts` 不扫 `.tsx`——旧的 `for await (… gateway.submitTurn …)` 藏在 `TuiApp.tsx`
  里**一直未被矩阵登记**；迁入 `useTuiActions.ts`（.ts）后该消费点被正确捕获。这是「降级但不静默」
  方向的准确性提升（TUI 的事件消费现在可见），非计数漂移，已 `gen:event-matrix` 回填并 `check` green。
- 文档事实层：`docs/code-facts.md` 的 `src/adapters/` 文件数 96 → 100（新增 4 文件），
  `pnpm gen:doc-claims` 回填。
