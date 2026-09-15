# Agent Note: TurnRunner 提前终止路径统一收口

Status: implemented

## Problem

`TurnRunner.run()` 里有多条「提前终止」路径——转录落盘失败、`UserPromptSubmit` hook 阻断、输入被接受但未请求模型、loop 运行中抛错。它们都要把同一件事做完：构造错误结果、把结果落盘、收尾产物采集、记录并上报失败状态、发 `turn_failed` 与 `turn_completed`。

这段五步样板原先在四处各抄了一遍。代价不是行数，而是**形状一致性靠人工维护**：`turn_result` 的字段或错误码语义一旦调整要同步改四处，漏改一处就会让某条路径产出形状不一致的 `turn_result`，而这类不一致只在下游消费（UI / telemetry / 续算扫描）时才暴露。`TurnRunner` 处于主链路且是改动高频区，风险随新增提前终止情形线性增长。

## Decision

抽出私有异步生成器 `emitEarlyFailure(args)` 承载这套序列，四处调用点改为 `return yield* this.emitEarlyFailure({...})`，各自只声明自己的差异点。

**先核代码再动手**：原任务记的是「三条路径结构重复」，实际是**四条**（漏了 `run()` 末尾的 loop 抛错 catch），且四条**并非同构**——差异点有三个维度：

| 路径 | 结果落盘 | 产物收尾 | metadata 收尾 | 回填的 `messages` |
|---|---|---|---|---|
| 转录落盘失败 | 否（再写必失败） | 否（采集器尚未启动） | 否（标题未生成） | `options.messages`（只有原始输入） |
| `UserPromptSubmit` 阻断 | 是 | 是 | 否 | `messages`（含本次输入） |
| 未请求模型 | 是 | 是 | 是 | `messages` |
| loop 抛错 | 是 | 是 | 是 | `messages` |

于是签名采用三个可选参数 `finishArtifacts?` / `recordResult?` / `finalizeMetadata?` 表达差异，而不是把四条路径强行归一（归一就得改变至少一条路径的实际行为）。`messages` 因语义不同而必填。

**一并拉齐顺序约定**：产物收尾恒在结果落盘**之前**。成功路径（`run()` 主流程）已是这个顺序，`tests/session/turn-file-artifacts.spec.ts` 断言的也正是「转录里 `file_artifacts` 条目先于 `turn_result`」；四条失败路径中「loop 抛错」此前已符合，而「`UserPromptSubmit` 阻断」与「未请求模型」是反的。收口时以成功路径为准对齐，把这处漂移就地抹平。

`emitEarlyFailure` 用一个统一序列覆盖三条路径的 metadata 收尾（`settleTailWrite` 包裹）：`finalizeSessionMetadata` 内部本就逐项吞错，故对原先未包裹的那条路径是等价变换，同时让「这套序列不得向上抛」成为方法的显式契约。

## Alternatives considered

- **只抽「三条」路径，把 loop 抛错 catch 留在原地** — 落选。四条路径的尾部序列完全同形，留下的那条会成为第五处；而它恰好又是唯一已经符合产物先于结果顺序的那条，留着反而使「哪个顺序才是约定」继续模糊。
- **强行四归一（去掉可选参数，四条路径行为完全一致）** — 落选。会让「转录已坏」的路径也去写一次注定失败的 `recordTurnResult`，让采集器未启动的路径也去做产物收尾，并把 `messages` 回填统一成 `messages`（首条路径原本刻意回 `options.messages`，因为本次输入尚未被接受）。为整齐而改变四条路径的语义，收益是签名少三个参数，代价是引入无谓行为变更。
- **保留两条路径各自的反向顺序，给 helper 加一个 order 开关** — 落选。等于把一处真实的漂移固化成 API，且需要一条测试来锁定「两种顺序都合法」——这恰恰是「收口」要消灭的东西。
- **把这个序列做成独立的类或模块级函数** — 落选。它需要 `this.transcript` / `this.now` / `this.recordErrorResult` / `finishArtifacts` 闭包（后者捕获了本轮已启动的采集器），抽成独立单元就得把整组依赖注入进去，收益不抵依赖传递成本。`#342` 的目标是消除重复，不是把这个类拆小。

## Consequences

换来的是：四条路径共享一条声明式的序列，新增第五种提前终止情形时只需一次调用加声明差异点，不再有第五份样板；顺序约定由成功路径与失败路径共用同一条断言（`file_artifacts` 先于 `turn_result`），不再需要记住「例外有两条」。事件矩阵自证：`TurnRunner.ts` 中 `turn_completed` / `turn_failed` 的生产点由各 4 个降为各 1 个。

付出与遗留：

- `TurnRunner.ts` 行数由 627 增至 663。**这是文档成本而非逻辑膨胀**——四处共约 60 行的重复被换成约 25 行的调用点加一个约 45 行的方法与约 30 行 JSDoc。判据应是「同一序列的实现份数」（4 → 1）而非总行数。
- **可观察的行为变更仅有两处，且都是「向成功路径对齐」**：① 「`UserPromptSubmit` 阻断」与「未请求模型」两条路径的转录条目顺序由 `turn_result → file_artifacts` 变为 `file_artifacts → turn_result`；② 实现细节——产品代码的**事件流完全不变**（`file_artifacts` 事件本就先于失败状态事件），`turn_result` / `turn_failed` / `turn_completed` 的形状不变。`docs/event-producer-consumer.md` 已同 PR 重新生成，逐事件的「生产/消费集合」在归一化行号后与改动前一致（差异仅为行号位移与重复项合并）。
- `finishArtifacts` 作为闭包被传入 helper，是「不把 `run()` 拆小」这一取舍的直接体现；若 `#343` 式的依赖注入改造进入 `TurnRunner`，这里应改为 `RuntimeDeps` 的显式成员。
