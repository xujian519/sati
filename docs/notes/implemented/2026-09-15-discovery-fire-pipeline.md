# Agent Note: DiscoveryFire 的 run / rerunPlan 收口到共用管线

Status: implemented

## Problem

常驻执行（always-on）的 Discovery 计划有两条触发路径：首次触发走 `run()`，重跑计划走 `rerunPlan()`。两者本该是「同一管线的两种入口」，实现上却**各写了一份完整管线**：

- `run()` 的 Phase 2-4 位于 `:737-1010`；`rerunPlan()` 的对应段落位于 `:353-596`；
- 两段逐段语义一一对应（workspace 准备 → execution → report → 写回 plan / state / history），连各阶段的会话清理 `finally` 都一样；
- 两者相距 280+ 行，管线的任何一次调整（新增阶段、改报告结构、改状态字段）都要在两处同步，靠肉眼对齐。常驻执行是**无人值守**路径，漏改不会当场暴露，只会在下次触发时以「计划状态异常」的形式出现。

台账与 issue 都推测「差异仅在 `baseHistory`（`runPipeline(plan, baseHistory)` 的签名正暗示这一点）」。核码后需要修正：

1. **`baseHistory` 属偶然差异、且不可观察**。`rerunPlan` 的 `baseHistory` 含 `planId`，`run` 的不含——但 `run` 在每处 `appendHistory` 时又显式补上 `planId: planRecord.id`，故两条入口产出的 history 记录**本来就完全相同**。真正的差异全在**进入管线之前**：计划与正文的来源（discovery 产出 vs 从存储读回）、`rerunPlan` 多一次存在性双校验、多一次 `status: "ready"` 回落、以及一个 `state` 读取时点。
2. **台账记「两方法各带 5 个 `.catch(() => undefined)` finally 清理块」，实核不成立**。这段管线内每个入口 2 个（execution / report 的 `closeSession`），`run` 另多 1 个 discovery 会话的清理；文件中其余 6 个分属 `runApplyPhase` / `runWorkspacePhase` / `emitEvent` / `drainTurn` / `releaseDiscoveryLock`，不属于这段重复。
3. **`deps.logger` 是死接线**。它在 `DiscoveryFireDependencies` 中被声明、被 `AlwaysOnRuntime.bindGateway` 注入，却在整个 1255 行的文件里**零引用**。issue 备注建议的「把静默清理改为带日志的清理」正好卡在这里：字段早就在，只是没人接。

## Decision

1. **抽出 `private runPipeline({ runId, startedAt, planRecord, planMarkdown, state })`**，承载 Phase 2-4；两个入口各自只保留真正不同的前置。`run` 里那个只服务「未产出计划即失败」的历史基底改名 `prePlanHistory`，与管线内的 `baseHistory` 区分。
2. **方法体由原 `run()` 的 Phase 2-4 机械派生**，而非重写：只把 `planRecord.id` 改名为局部 `planId`、把 `discoveryCtx.plan.markdown` 改名为入参 `planMarkdown`；换行、尾逗号、空行保持原文。派生产物经脚本对 **275 行逐行规范化比对**（保留空白、只折叠这两个标识符的拼写），并在写盘后对**产出文件**复验一次；随后 `biome check` 报 `No fixes applied`，即派生块本身格式干净。这样 diff 退化为「抽方法 + 纯改名」，可逐行核对。
3. **`deps.logger` 接线到会话清理**：新增 `private closeSessionQuietly(sessionKey)`，本文件 5 处「关闭 always-on 会话」全部收敛到这里；失败记一条 `warn`（含 `sessionKey` 与错误消息）但不上抛。单独一个 commit，与纯收口分开审阅。
4. 新增 `tests/always-on/runtime/discovery-fire-pipeline.spec.ts`（10 例）：用 fake deps 直接驱动 `DiscoveryFire`，逐条钉住成功 / execution 出错 / 报告缺失 / 计划缺失 / 正文缺失 / `no_plan` / discovery 失败七条路径的事件序列与落盘调用；另加一条**跨调用方的有序 trace**（把「收尾落盘顺序」契约真正断言出来）与一条 **`run` ↔ `rerunPlan` 等价性用例**。

## Alternatives considered

- **按台账建议的签名 `runPipeline(plan, baseHistory)`** — 落败。会把「历史基底」这个**偶然差异**提升为接口参数，反而把两条入口本已相同的产出表达成不同的输入；改为管线内部按 `planRecord` 自建 `baseHistory`（含 `planId`），接口只暴露真正不同的东西（计划记录、计划正文、前置读到的 state）。
- **把 Phase 1 discovery 也并入管线、用参数开关** — 落败。discovery 段有自己的收尾分支（`markFailedNoPlan` / `no_plan` / 休眠），并入后管线要接受「可能没有计划」的输入，等于把两条入口的差异从「前置不同」退化成「管线内分支更多」，与收口目标相反。
- **手写新方法体**（而非从原文机械派生）— 落败。275 行手抄必然引入换行 / 尾逗号级别的噪声，diff 里「改名」与「重排版」混在一起，reviewer 无法逐行核对；机械派生把「零行为变化」变成可机械验证的命题。
- **`runPipeline` 改为 `public` / `static` 以便直接单测** — 落败。它是实现细节，暴露会扩大接口面；测试通过两个公开入口驱动即可覆盖（`rerunPlan` 是单入口调用，`run` 用计划工具在 fake gateway 内把计划写进 `discoveryCtx`）。仓内确有「导出内部函数供测试」的先例（`parseAgentThinking`），但那适用于**纯函数**，管线有 8 个依赖不适配。
- **把 `deps.logger` 一并从依赖里删掉**（既然是死的）— 落败。它被 `AlwaysOnRuntime.bindGateway` 注入且是常驻执行排障的唯一出口；接线比删除更符合意图。已把「此前零引用」写进方法 JSDoc 留痕。
- **把本文件全部 11 处 `.catch(() => undefined)` 一起改为带日志** — 落败（超范围）。其余 4 处属事件落盘（`emitEvent` / `drainTurn`）与锁删除，失败语义不同（前者是「日志写不进去」，后者是「锁文件已被清」），且「静默吞业务异常」的仓库级口径由 **#353** 统一裁定；在一个文件里先落一套口径会碎片化该决策。本 PR 只收敛**同类**（关闭会话）的清理。
- **把「收尾落盘顺序」契约留在注释里** — 落败。注释不承重；改为在 fake 上记有序 trace 并整条断言，负控制证明它真的会因为顺序对调而转红。

## Consequences

- **结构性消除**：管线的调整只需改一处，且 10 个用例钉住七条路径的可观测契约。
- **`deps.logger` 从死接线变为会话清理失败的留痕出口**（本 PR 的第二处可观察变更）：清理失败在常驻执行里不再无痕。上抛语义未变（仍不上抛），故不影响控制流。
- **量化收益**（`docs/technical-debt/metrics.md`）：
  - `DiscoveryFire.ts` 1256 → 1078 行，**退出「最大文件」榜**（榜内末位是 `RouterRuntime.ts` 1230）；
  - 方法 `run` 原 **414 行**，收口后不再存在，**退出「最大方法」榜**——它是榜内 `src/` 下最大的方法（其后为 `RouterRuntime.execute` 411），其余更大的都在 `ui/` 与 vendored 子包内；
  - src TS 总行数 185194 → 185017（净减 177 行），而语义完整保留。
- **事件矩阵**：`submitTurn` 的生产点行号 `DiscoveryFire.ts:1138 → :961`，生产/消费集合未变（同文件同一生产点）；已随 PR 重新生成。
- **残留**：本文件另有 4 处 `.catch(() => undefined)`（事件落盘 3 处、锁删除 1 处）仍是静默——交 #353 的仓库级口径统一处理，未在本 PR 内私自定义。
