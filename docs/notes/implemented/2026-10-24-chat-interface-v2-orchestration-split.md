# Agent Note: B2.6 ChatInterfaceV2 编排层拆分（#646）

Status: implemented

## Problem

`ui/src/components/chat-v2/ChatInterfaceV2.tsx` 的 `ChatInterfaceV2` 是 **668 行**的编排 god
function（文件 725 行），把八类互不相关的职责叠在同一个闭包里：

1. 流式缓冲三件套（buffer / timer / accumulated）与重置入口；
2. provider 状态 + run mode 循环 + 权限模式记忆写入；
3. abort 的 pending 闸门与全局 Escape 拦截；
4. WebSocket 重连恢复（清缓冲 → 条件全量刷新 → check-session-status）；
5. fork / 编辑最后一轮 / 重新生成最后一轮；
6. 只读提示 + ComposerV2 的 60 项接线 + composer slot 容器；
7. welcome（compact / hero）两套布局；
8. MessagesPaneV2 的 40 项接线与 grid 骨架。

计划 B2.6 判据：**流缓冲 / fork-regenerate / reconnect / composerSlot 四簇外置，props 契约不动，
`ChatInterfaceV2` ≤350 行**。

## Decision

按「状态来源」而不是按「代码位置」外置。主函数只保留装配：调用 8 个 hook、算 welcome、
包 `composerSlot`、选择 welcome / 常态两条 return。所有被搬移的语句、回调体、JSX 属性与
children 逐 token 保持原样；组件内通过解构恢复原变量名（例如 `const { input, ... } = composer`），
因此搬移后的 JSX 引用名与搬迁前一致。

| 模块 | 行数 | 内容 |
|---|---|---|
| `ui/src/components/chat-v2/chatInterfaceStreamBuffers.ts` | 23 | 3 refs + `resetStreamingState` |
| `ui/src/components/chat-v2/chatInterfaceProviderControls.ts` | 70 | provider 状态、thinking 可用性、run mode 循环、权限模式记忆、effective permission |
| `ui/src/components/chat-v2/chatInterfaceAbortGuard.ts` | 55 | `isAbortPending` + 两条失效 effect + 去重 abort + 全局 Escape effect |
| `ui/src/components/chat-v2/chatInterfaceReconnect.ts` | 80 | `handleWebSocketReconnect`（清缓冲 → 条件刷新 → status 请求） |
| `ui/src/components/chat-v2/chatInterfaceForkActions.ts` | 174 | `isForkPending` + fork / edit-last-turn / regenerate-last-turn |
| `ui/src/components/chat-v2/ChatComposerSlot.tsx` | 196 | 只读提示 / ComposerV2 接线 / slot 容器（入参按 composer/session/provider 分组） |
| `ui/src/components/chat-v2/ChatMessagesRegion.tsx` | 123 | MessagesPaneV2 接线 + grid 容器 + composerSlot 落位 |
| `ui/src/components/chat-v2/ChatWelcomePane.tsx` | 62 | compact / hero 两套 welcome 布局 |

结果：`ChatInterfaceV2` **668 → 283 行**，文件 **725 → 335 行**，判据 ≤350 达成；
文件未进 §38.2 ≥800 清单，`architecture-baseline.json` 存量豁免保持 **35** 条。

所有权约束：`runMode` / `isAbortPending` / `isForkPending` 不再由主闭包持有，但仍是每实例一份
hook 状态；stream 三个 ref 的句柄由 `useChatStreamBuffers` 创建后经入参传给 session hook、
reconnect hook 与卸载清理 effect，**没有第二份 ref**。provider / session / composer 三个 hook
的返回对象整体传入渲染组件，组件内不重新计算派生值。

## Alternatives considered

1. **只抽 composer JSX，其余留在主函数** —— 主函数仍有 ~550 行，达不到 ≤350；流缓冲、
   reconnect、fork 三簇才是阅读跳跃的主因。
2. **把 60 个 composer props 继续扁平传入 `ChatComposerSlot`** —— 组件签名与主函数调用点各
   60 行，拆完仍 ~360 行且新增一个巨型 props 契约；改为 `composer` / `session` / `provider`
   三个来源对象 + 12 个局部动作，调用点缩到 17 行，组件内解构后引用名不变。
3. **用 Context 透传 composer/provider 状态以消掉 props** —— 会新增隐式依赖与 provider 嵌套，
   与「props 契约不动、DOM 不变」的验收面冲突，且 `ChatInterfaceV2` 的 memo 语义会变。
4. **把 MessagesPaneV2 接线留在主函数** —— 主函数 ~320 行可勉强达标，但消息区与 composer 区
   的 JSX 分属两条 return 分支，留在主函数会让「布局骨架」与「欢迎态判断」继续纠缠。
5. **拆成子 hook 后继续在组件内组合 JSX** —— 与当前方案等价，但 JSX 仍占 ~140 行；
   组件边界能把「消息区 / composer 区 / 欢迎区」各自的变更原因隔开。

## Verification

- **逐 token 证明 9 段全绿，合计 2130 token**（基线 `366408140`，AST 定位 + scanner 逐 token，
  脚本 `/tmp/b26-token-proof.mjs` 由 BASE_SHA 取基线）：
  - S1 流缓冲 77/77；S2 provider 控制 148/148；S3 reconnect 149/149；S4 abort guard 222/222；
  - S5 fork/edit/regenerate 673/673；S6a composer conditional JSX 450/450；S6b slot wrapper 13/13；
  - S7 welcome 182/182；S8 messages region JSX 216/216。
- 声明式改写（逐条）：
  1. `cycleRunMode` 依赖数组 `[]` → `[setRunMode]`（setter 由 prop 传入，exhaustive-deps 不再视为内建稳定值）；
  2. `handleFork` 依赖数组尾部 +`setRunMode`（同上）；
  3. `selectPermissionMode` 参数标注 `typeof permissionMode` → 具名 `PermissionMode`（仅类型）；
  4. `onSubmit={wrappedSubmit as typeof handleSubmit}` → `onSubmit={wrappedSubmit}`（prop 已按
     `handleSubmit` 类型声明，运行时零变化）；
  5. `const composer = <conditional>; const composerSlot = <div>{composer}</div>` 合并为组件内
     「wrapper div 直接包 conditional」的单 block 解包；
  6. S5 的模板字符串按占位等长掩码比较（错误文案内容见 git diff，未变）。
- **hook 序列**：展开子 hook 后 hook 多重集 **EQUAL**、4 条 effect 的注册顺序 **EQUAL**；
  唯一重排是 `isAbortPending` / `isForkPending` 两条 `useState` 从 provider 之前移到
  realtime 之后（随簇迁移），每渲染周期 hook 数量与类型不变。
- **负控制**（每次恢复后复跑证明全绿 + 测试全绿）：
  - C1：去掉 `handleAbortWithPending` 的 `isAbortPending` 去重守卫 → **2F/16P**
    （Escape 重复 + stop 双击两条用例）；
  - C2：翻转 `shouldRefreshSessionOnReconnect` 分支 → **2F/16P**（空闲刷新 / 处理中跳过两条用例）；
  - C3：仅把 welcome 的 `mb-3` 改为 `mb-4`（测试不覆盖 className）→ 测试 **18/18 绿**，
    token 证明 S7 红（`182/182` 但 firstDiff=36），恢复后回到 9 段全绿。
- 新增 jsdom 测试 `ChatInterfaceV2.test.tsx` **18 例**（拆分前实现上先绿）：wiring 5、abort 4、
  fork/edit/regenerate 5、reconnect 2、welcome 2。
- **双视口 A/B**（branch `5373` vs main worktree `5374`，1440×900 / 390×844，系统 Chrome）：
  - welcome 态：布局盒（composer slot / textarea / heading）、placeholder、无横向溢出、
    无 pageerror —— **14/14** 一致；
  - 打开既有会话后的常态：composer 停靠底部（y+h=900）、两个滚动容器、无溢出 —— **8/8** 一致；
  - **有意未验证**：移动端「打开会话后的常态」需要在折叠侧栏里先选项目再选会话，本轮未驱动；
    真实发送消息（会触达本机项目与 agent）按 checklist §3 约定跳过，由测试与负控制承担。
- 门禁：`pnpm check` EXIT=0；UI `vitest run` **205 文件 / 1612 用例全绿**；根 `pnpm test`
  **5996 用例 / 0 fail / 5 skip**（跳过项均为既有环境依赖：本地法律库不可用、非 CI 环境的 graphviz
  门槛、`patent_drafting_v1` fixture 未录制；不是本次改动引入）；`pnpm test:pr-tooling` **208/208**；
  提交后 `measure-techdebt --check`、`check-architecture-boundaries`、token 证明复跑均通过。
