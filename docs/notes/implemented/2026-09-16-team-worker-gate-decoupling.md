# Agent Note: 通用团队层与专利域解耦（抽 WorkerGate 接口）

Status: implemented

## Problem

`src/agent/team/`（通用团队编排：任务池、邮箱、调度器、冷恢复）有 22 个 TS 文件，其中 21 个只依赖
`node:*`、`gateway/protocol`、`telemetry` 与自身；唯独 `scheduler/scheduler.ts` 反向 import 了
**专利业务域**：

```ts
import { workerAllowedForRole, type WorkerRegistry } from "../../../patent/worker-contract.js";
```

后果不是「不整洁」而是三条具体的：

1. **非专利团队也被强制走专利 worker 的 tier 校验路径**——`canMemberClaim` 对任何带
   `workerName` 的任务都要过 `workerAllowedForRole(roleSlug, worker)`，而 `WorkerTier`
   （`work/provision/reasoning/domain/checker`）与 `WorkerContract` 是**专利专业子任务**的概念
   （`src/patent/worker-contract.ts` 自述「移植自 Mady agentcore/worker/contract.go」）。
2. **依赖方向反转**：`agent/team → patent`，而 `patent` 本身又依赖 `tool`/`agent`
   （见 `backlog.md` `TD-BOUND-003` 的运行时值环）。专利域改一次 worker 契约，通用调度器要跟着改。
3. **它当初不是设计出来的**：`worker-contract.ts` 的领域属性说明这行 import 是移植时顺手带进来的，
   所以「修掉它」符合双方本意（不是否定某个有意的耦合设计）。

**核账偏差（与 issue #363 / `TD-TEAM-N06` 对账）**：

- issue 的证据是 `grep -rn "patent" src/agent/team/`，**作用域只覆盖 `agent/team/`**，因此漏掉了
  同型的第二处泄漏：`src/tool/builtin/team/`（通用团队工具）同样把专利域拉进了类型面——
  `teamUtils.ts` 的 `TeamToolsOptions.workerRegistry?: WorkerRegistry`（类型 import 自 patent
  **barrel**）与 `teamTasks.ts` 的存在性校验 `workerRegistry.get(workerName) === undefined`。
  即真实形态是 **2 个通用目录、3 个消费点**，不是 1 处。
- issue 与台账都没提到的一点：**调度器的 tier 判定此前没有任何判据**。`scheduler.spec.ts`
  的 18 个用例从未注入过 `workerRegistry`，「无权成员被跳过 / 有权成员照常认领」这条路径
  全靠 22s 的 gateway 集成用例间接覆盖（且那两条用例断的是**工具侧的存在性校验**，不是调度侧）。

## Decision

在通用编排层定义**领域无关**的门禁接口（`src/agent/team/worker-gate.ts`），专利域提供适配器，
装配点注入：

```ts
export interface WorkerGate {
  has(workerName: string): boolean;                                   // 存在性（工具侧校验用）
  allows(roleSlug: string, workerName: string): boolean;              // 权限（调度侧判定用）
}
```

- 接口刻意只有两个方法：编排层对 worker 的全部用法就是「存不存在」与「这个角色能不能干」。
  `has` 不可省——省掉它，工具侧的存在性校验就只能继续持着 `WorkerRegistry`，接口只覆盖一半消费方。
- **`allows` 的三条分支语义逐字保持**（未注册 worker → true、未登记角色 → true、已登记角色按 tier
  白名单），并**逐条写成判据**：把 fail-open 收紧会让尚未迁移到 worker 契约的任务派发**静默停摆**
  （调度器不再唤醒任何成员），这是本次迁移唯一可能悄悄漂移的地方。
- 适配器 `src/patent/team-worker-gate.ts` **不 import `agent/team` 的类型**：patent 是业务域，
  反向 import 通用编排层（哪怕 `import type`）在四层六域目标架构下仍是方向颠倒。结构一致性由
  装配点的显式标注在编译期把关：`src/cli/teamSubsystem.ts` 的
  `const workerGate: WorkerGate = createPatentWorkerGate(workerRegistry);`。
- `TeamSchedulerOptions.workerRegistry`、`TeamToolsOptions.workerRegistry`、
  `TeamSubsystemRuntime.workerRegistry` 一并更名为 `workerGate`：option 名是公开契约，
  留着旧名等于把「专利 worker 注册表」这个概念继续写在通用层的 API 表面上。
- **`ownedOpenTask` 仍走未过滤的任务快照**（已认领任务不因权限判定被夺回），这条既有语义
  本次**不动**，但补了一条判据把它钉住——它此前只在注释里。
- 新增两道**防回退门禁**：
  - eslint `no-restricted-imports` 的 `patterns` 对 `src/agent/team/**` 与
    `src/tool/builtin/team/**` 禁止任何指向 `patent` 的说明符（编辑器/`pnpm lint` 阶段即拦）；
  - `tests/agent/team/layering-boundary.spec.ts` 扫**真实源码树**（两个目录）断言不存在
    指向 `src/patent` 的模块依赖，并在「扫不到文件」时显式失败（空集放行是本类判据最危险的失败模式）。

## Alternatives considered

- **只改 `agent/team`（严格照 issue 的作用域）** — 落选：`tool/builtin/team` 的两处同型泄漏会留着，
  `WorkerGate` 只覆盖一半消费方，通用团队工具的 API 表面仍然写着专利域类型；而两者的修法完全
  相同（同一个接口、同一个装配点）。
- **接口只留 `allows`，工具层继续用 `WorkerRegistry`** — 落选：等于承认「通用团队工具可以知道专利域」，
  与 `agent/team` 侧的结论自相矛盾；且存在性校验与权限判定读的是同一份注册表，拆成两套注入 =
  两个真相。
- **适配器内联在装配点 `src/cli/teamSubsystem.ts`（issue 的建议写法）** — 落选：装配点内联后
  测试无法复用同一实现——两条集成用例需要自己再写一遍「查注册表 → 判 tier」映射，于是同一映射
  出现两份。放 patent 侧导出后，生产装配与测试用的是**同一个函数**。
- **适配器放 patent 侧但 import `agent/team` 的 `WorkerGate` 类型** — 落选：类型依赖也是依赖，
  四层六域下 domain → application 是反向边。装配点的一行显式标注同样能拿到编译期一致性检查，
  代价为零。
- **在 patent 侧用 structural 影子类型（自己声明一份 `{ has, allows }`）** — 落选：会造出第二份
  接口定义，正是本 PR 要消的那类「注定漂移的副本」；有人改接口时它不会报错。
- **把门禁收窄成 `(workerName) => tier` 的函数** — 落选：`has` 与 `allows` 无法分离（存在性校验
  得先拿到 tier），且 tier 字符串会把专利域的枚举语义直接泄漏回通用层——正是要拆的东西。
- **只加结构守卫测试，不加 eslint 规则** — 落选：违规要到 `build + test` 阶段才暴露（`pnpm test`
  需先 `npm run build`），编辑器与 `pnpm lint` 阶段零反馈；lint 层「关门」的边际成本只有一处
  `patterns` 配置。
- **eslint 里只写 `patterns`、不重复 `child_process` 禁令** — 落选：ESLint 的规则配置是**按文件块
  整体覆盖**而非合并，后声明的块会让这两个目录**静默失去** `exec/execSync` 禁令（看起来"配了"，
  实际被覆盖掉）。故抽出 `DANGEROUS_IMPORT_PATHS` 常量供两块共用，并在常量注释里写明原因。
- **把分层门禁做成 `lint-fixtures/` 的负控制 fixture** — 落选：fixture 在 `tests/` 下，根配置的
  `files` 作用域（`src/agent/team/**`）根本匹配不到它，要让 fixture 转红就必须在专用 config 里
  **再抄一份同样的规则**——那证明的是「抄来的规则会命中」，而不是「根配置的作用域正确」。
  作用域正确性改用两条真实证据：`tests/development-standards/lint-contract.spec.ts` 里对根配置的
  结构断言（作用域与规则体必须同块），以及本次在真实文件上做的作用域负控制（见 Consequences）。

## Consequences

- **行为等价证据**：`tsc --noEmit` 绿；`scheduler`（23 例）、`patent/team-worker-gate`（5 例）、
  `team-tools-integration`（7 例）、`layering-boundary`（2 例）全绿；全量门禁见 PR。
  等价性不靠「读起来一样」，靠**三条 fail-open 分支 + 不夺回语义各有一条判据**。
- **新增判据 13 例**（调度侧 5、适配器 5、分层守卫 2、lint 配置断言 1），其中调度侧 5 例填上了
  此前**零覆盖**的 tier 判定路径：
  - 未注入门禁 → 带 `workerName` 的任务照常派发（fail-open）；
  - 注入且成员无权 → 该成员被跳过、有权成员照常认领（证明是**过滤**，不是整队停摆）；
  - 查询实参逐条断言为 `[["researcher", …], ["drafter", …]]`（钉住编排层如实传递角色/worker 名，
    且判定按成员逐个进行）；
  - 任务无 `workerName` → 门禁**不被查询**；
  - 已认领任务不夺回（`ownedOpenTask` 走未过滤快照）。
- **负控制 6 组**（逐条核对转红名单、相邻用例仍绿、还原复绿）：
  | 注入 | 预期转红 | 实测 |
  |---|---|---|
  | 适配器 `allows` fail-open 反向（`worker === undefined \|\|` → `!== &&`） | 适配器「未注册 worker 一律放行」 | ✅ 1 例 |
  | 调度器 `canMemberClaim` 恒 `true` | 过滤 / 实参 2 例 | ✅ 2 例 |
  | `ownedOpenTask(tasks…)` → `ownedOpenTask(claimable…)` | 已认领不夺回 1 例 | ✅ 1 例 |
  | 适配器 `has` 恒 `true` | 适配器 2 例 + 集成「生产路径非死代码」2 例 | ✅ 4 例 |
  | 向 `scheduler.ts` 追加 `import … from "../../../patent/…"` | 分层守（agent/team）1 例 | ✅ 1 例（tool 侧守卫保持绿） |
  | 向 `teamUtils.ts` 追加同款 import（手跑 eslint） | `pnpm lint` 报 `no-restricted-imports` | ✅ 两目录各自实测报错、`exec` 禁令仍在 |
  **一条预测偏差如实记录**：`has` 恒真这一注入除预期两条外，**额外**打红了适配器里的
  「门禁读取的是注册表当前状态」用例——该用例为证明「读的是实时状态」同时断言了
  `has("late-worker") === false`，因此被这条注入正确命中。它属于「同一注入有多个判据承重」，
  不是误红。
- **未做**：同节的 `TD-TEAM-N07`（成员会话前缀正则 `/^team[:-]/` 三处独立定义）issue 提过
  「可一并处理」，本次未动——它触及会话身份判定（fail-closed 方向），值得独立一轮；
  worker tier 的**产品面**语义（判定规则本身）本次未改，只搬了判定位置。

## 相关

- issue #363、台账 `TD-TEAM-N06`（本节相邻条目 `TD-TEAM-N07` 未做）
- `src/agent/team/worker-gate.ts`、`src/patent/team-worker-gate.ts`、`src/cli/teamSubsystem.ts`
- `src/agent/team/scheduler/scheduler.ts`、`src/tool/builtin/team/{teamUtils,teamTasks}.ts`
- `tests/agent/team/layering-boundary.spec.ts`、`tests/patent/team-worker-gate.spec.ts`
