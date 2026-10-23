# B1.1 — session store actions 拆为四组普通函数工厂（2026-10-23）

## 背景

`ui/src/stores/useSessionStore.ts` 是 chat 与 app-shell 两条链路共用的数据底座：
单例 `Map<string, SessionSlot>` + 28 个 action + 合并/去重纯函数，文件 1,348 行，
`createSessionActions` 单函数 624 行（sweep 冻结清单 §38.1 B1.1 / §38.2 BF-09）。

B1.1 判据：`createSessionActions` ≤350 行；文件 ≤800 行并注销 file-size 存量豁免。
checklist §6 的红线是**绝不拆子 hook**——`useRef(new Map())` 是 per-session store 的唯一句柄，
拆成 `useSessionFetch()` 之类的子 hook 会让每个子 hook 各建一份 Map，28 个方法静默失效。

## 做法

- 新建 `sessionStoreCore.ts`（684 行）：类型（`NormalizedMessage` / `SessionSlot` / …）、
  合并与去重纯函数、URL/响应 helper、rAF 通知调度器、常量，**逐 token 原样搬迁**。
- 新建 `sessionActions/`：
  - `context.ts`（61）：`SessionActionDeps` 与 `SessionActionContext`；把原来主闭包开头的
    `getNotifyScheduler` / `notify` / `setActiveSession` / `getSlot` / `has` 收进
    `createSessionActionContext(deps)`。
  - `serverActions.ts`（202）：`fetchFromServer` / `fetchMore` / `refreshFromServer` / `isStale`。
  - `streamActions.ts`（211）：realtime append/batch、streaming/thinking 更新与 finalize、清理。
  - `activityActions.ts`（37）：`upsertActivity` / `setActivities`。
  - `subagentActions.ts`（154）：link、detail message、detail streaming/thinking。
- `useSessionStore.ts` 只保留：公开 re-export、`createSessionActions`（**624 → 67 行**）
  的装配（创建一个 `ctx`，四个工厂都吃同一个 `ctx`）、4 个访问器、hook 本身；文件
  **1,348 → 133 行**。
- 四个工厂都是**模块级普通函数**、工厂体内零 hook 调用，同一份 `storeRef` /
  `activeSessionIdRef` / `notifySchedulerRef` 经 deps 传入 → 单 Map 不变量不变。
- return 对象仍然显式列出 28 个键，键序与拆分前逐项一致（避免 spread 改变顺序）。

## 证据

- **逐 token 证明 68/69**：AST 提取基线声明与新位置声明，TS scanner 去 trivia 后逐 token 比对；
  唯一差异是 `INVISIBLE_REALTIME_KINDS` 加 `export` 后超过行宽、biome 折行并补一个尾逗号
  （token 序列仅多 `,`，无其他变化）。
- **负控制**（按 checklist §2/§6）：
  1. `getSlot` 改为单一共享键 → `useSessionStore.actions.test.tsx` **18/18 全红**（预期）；
  2. `updateStreamSlot` 把 merged patch 挪到 realtime 行赋值之后 → **1/18 红**，且恰为
     `expect(secondMerged).not.toBe(firstMerged)` 那条（预期）。
- 定向测试：`useSessionStore.actions.test.tsx` + `useSessionStore.streaming.test.ts`
  **42/42 pass**。
- `pnpm --filter sati-ui test`：**197 文件 / 1486 例全绿**。
- `pnpm check` EXIT=0；`pnpm test:pr-tooling` **197/197 pass**。
- `pnpm test`（后端全量）：5958 例 / 5951 pass / **0 fail** / 5 skip / **2 cancelled**——
  两个 patent docx 文件在本机整包并发下触发 60s 文件级超时（`testTimeoutFailure`）；
  隔离复跑 `applicationDocx` **21/21**（4.1s）、`renderPatentDocument` **17/17**（61.4s，
  须把超时放宽到 120s）。与本改动无交集，按既有 P2.2 记录同口径列为环境负载产物。
- 指标：ui/src 文件 647 → 653、行数 103,082 → 103,223；metrics 中
  `createSessionActions (624)` 与 `useSessionStore.ts (1348)` 两条均消失；
  file-size 存量豁免 **40 → 39**（BF-09 脱表）。

## Alternatives considered

- **拆成子 hook（`useSessionFetch` / `useSessionStreaming` / …）**：会为每个子 hook 创建
  独立 `Map`，28 个方法静默读到不同 store；checklist §6 明令禁止。否。
- **只把 actions 搬到单个 `sessionActions.ts`，类型与纯函数留在原文件**：文件仍约 770 行，
  贴着 800 行上限、没有后续余量，且类型/纯函数与 action 的职责仍混在一起。否（选择
  core + 四工厂）。
- **action 模块从 `useSessionStore.ts` 反向 import 类型与 helper**：会形成
  `useSessionStore → actions → useSessionStore` 的运行时环（helper 是值导入，不能只靠
  type-only 擦除）。否（统一从 `sessionStoreCore.ts` 单向导入）。
- **用 class / 依赖注入容器承载 ctx**：为四个纯函数工厂引入生命周期与实例语义，成本高于
  收益；显式 `SessionActionContext` 已能保证单 Map。否。
- **用 spread 组装 return（`{...server, ...stream, ...}`）**：键序会随文件与 spread 顺序
  漂移，而 28 键顺序是既有测试与消费方的稳定面；改为逐键显式列出。否。
