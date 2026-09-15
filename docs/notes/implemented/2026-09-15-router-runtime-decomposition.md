# Agent Note: RouterRuntime 巨型闭包按职责拆分

Status: implemented

## Problem

`src/router/RouterRuntime.ts` 是 1230 行单文件，`createRouterRuntime`（885 行）一个闭包承载
config 归一、session store、health cache、路由决策、执行、重试、编排、统计八件事；内部
`decide()`（224 行）与 `execute()`（411 行）都是嵌套异步生成器，捕获外层十来个变量。

后果不是「难看」，而是**主链路核心决策无法单独测试**：

- `tests/router/` 顶层只有 2 个 spec，`RouterRuntime.ts` 只有 1 个（token-saver 失败诊断）；
- 全量套件里所有经 `createRouterRuntime` 的用例都是 `enabled: false` 直通，因此
  `sati_router_fallback` / `sati_router_zero_usage_retry` / `sati_router_transient_retry` /
  `sati_router_execute_failed` 四个事件在 `tests/` 下**零命中**；
- fallback / transient-retry / zero-usage 三套重试分支与「已产出内容是否可重放」的状态机
  咬合紧密，改动时回归只能靠端到端。

### 与 issue 登记口径的差异（先核代码再动手）

| 项目 | issue #343 / 台账登记 | 实测（2026-09-15） |
|---|---|---|
| 文件行数 | 1229 | `wc -l` 1229；指标口径 1230 |
| `createRouterRuntime` | `:94` 起，877 行 | `:94`–`:978`，**885 行** |
| `decide()` | `:255-466`，211 行 | **`:257-480`，224 行** |
| `execute()` | `:488-898`，410 行 | **`:499-909`，411 行** |
| 建议拆分产物 | 「拆 `decision.ts`/`execution.ts`/`sticky.ts`/`media.ts`」 | `config/` `fallback/` `health/` `retry/` `session/` `stats/` `orchestrate/` `protocol/` `scenario/` `customRouter/` `tokenSaver/` **已在**；文件尾另有 13 个模块级纯函数（250 行）已在闭包外。真正残留的 monolith 只有闭包体本身 |
| 直接单测 | 「14 个 spec 覆盖不了嵌套闭包」 | 顶层仅 **2** 个 spec；四个重试事件 **0** 命中（台账另立 `TD-ROUTER-008`） |

即：**根因判断正确，但「拆哪儿」的坐标已漂移**——`utils/mediaReroute.ts` 的注释已自述
「纯函数，从 RouterRuntime 闭包提取以便单测」，说明本条债务此前已有若干次局部偿还。本次是
沿用同一路线把剩余的嵌套部分走完，而不是另起 `decision.ts`/`execution.ts` 两套新目录。

## Decision

按职责把闭包体拆成模块，**闭包捕获量收敛为两个显式依赖对象**：

| 模块 | 内容 | 行数 |
|---|---|---|
| `decision/decideRouterDecision.ts` | `decideRouterDecision` + `resolveCustom` + `RouterDecisionDeps` | 313 |
| `execution/executeRouterDecision.ts` | `executeRouterDecision` + `applyDecisionToRequest` + 候选分档 + `RouterExecutionDeps` | 559 |
| `execution/streamAttempt.ts` | 单 attempt 执行器 `streamAttempt` + 流错误归类 + 可中止延时 | 203 |
| `media/modelMediaSupport.ts` | `missingForModel` / `supportsMediaRequirements` / `downgradeRequestForAttempt` | 46 |
| `media/rerouteDecisionForMedia.ts` | 媒体重路由结果回写决策 | 42 |
| `sticky/preserveStickyForCache.ts` | cache-aware 切换判定（纯函数） | 77 |
| `retry/retryGates.ts` | `shouldTransientRetry` / `shouldZeroUsageRetry`（纯谓词） | 46 |
| `RouterRuntime.ts` | 只剩装配 + `stream`/`invalidateSticky`/`shutdown` | 190 |

拆分的**安全前提是三条证明**（细则见下），因此正文一律**机械化派生**而非重打：

1. **派生**：新模块正文由 `git show HEAD:src/router/RouterRuntime.ts` 切片 + 统一反缩进 +
   内联 `import()` 相对深度 +1 得到；每次替换断言「恰好命中一次」。
2. **精确重建判据**：把派生文本按 **31 段已逐段人工审计的精确块映射**（签名重排 14、形参穿线 11、
   判据外提 2、显式枚举新增 4）重建，要求结果与入库文件**逐行全等**（空白归一化后、**保序**）。
   六个模块全部 `PASS`，无一处无法归因的差异。
3. **格式化层零漂移**：`biome check` 与 `eslint` 对新文件均输出无待修项 ⇒ 入库文本即格式化规范形态，
   派生块与入库之间的缩进差异确由格式化步骤产生、且是**统一反缩进**。

**为什么最终用「精确全等」而不是「识别已声明形态」**：初版判据是识别式 allowlist（`SHELL` 正则 +
子串标记），但负控制实测暴露两个真漏洞——① 只校验派生侧是否含已声明片段，**不校验入库侧实参**，
故外提判据的实参被改坏也能溜过；② 子串匹配，**行尾追加内容**可溜过。改成「这次编辑的精确映射」后
两个漏洞同时关闭，且保序全等还能拦住 `&&` 操作数换序（短路顺序敏感）。初版曾报「19 处未声明」，
复盘为**校验器自身的缺陷**：其反缩进常数与派生脚本不一致，把格式化造成的统一位移误判为改动。

**负控制（判据必须实测在承重）**：向入库文件注入四类漂移，确认校验器**全部转红**，还原后复绿——
C1 抽取体内逻辑漂移（`<` → `<=`）、C2 外提判据的实参漂移（`transientRetryCount` → `+ 1`）、
C3 行尾注释漂移、C4 判据实参换序。C2/C4 正是识别式判据漏掉的两类，这是改判据的直接依据。

**短路语义单独核过**：判据外提把 `!hasYieldedContent && isFallbackEligible(outcome.error) && …` 改成了
`shouldTransientRetry({ fallbackEligible: isFallbackEligible(outcome.error), … })`，实参因此**先于短路**
求值。逐项核实等价：原短路点与现调用点同在 `if (outcome.error) {` 分支内（HEAD `:683`/现 `:330`，
两处判据偏移恒为 353 行），故 `outcome.error` 非空；`isFallbackEligible` 是纯谓词（两次 `Set.has`
＋字段读取，无副作用、无 I/O、无日志），故提前求值不可观测。谓词内部操作数顺序亦与原 `&&` 链一致。

**行为锚先于重构落地**：先补 32 条特征化用例（`router-runtime-decide.spec.ts` 15 条、
`router-runtime-execute.spec.ts` 11 条、`retry/retry-gates.spec.ts` 6 条），只经公开入口
`createRouterRuntime(...).decide/.execute` 驱动；**抽取前后断言一行未改，全绿**。重构后这些
用例成为主路径的第一批直接单测（`TD-ROUTER-008`）。

**残留（未做，另行登记 `TD-ROUTER-009`）**：`executeRouterDecision` 本体仍有 429 行，
两套重试分支的「发事件 + 算退避 + 等待」编排未拆出；它现在进入「最大方法」榜首（比原
`execute` 的 411 行**更大**，因为重试判据改走谓词后多出调用与实参行）。抽出单 attempt 执行器
与重试判据后，这一层拆分已是纯机械工作。

## Alternatives considered

- **一次性重写决策/执行逻辑（谓词表驱动 `resolvedFrom`、单 attempt 执行器返回结构化结果）** —
  落选：这才是 issue 建议的理想终局，但它**不是零行为变化**。`execute` 里 `continue outer` /
  `break outer` / `return` 三种退出语义与 `pending` 缓冲、`lastHasBuffered` 回放互相咬合，32 条
  用例不足以证明重写等价；先做可证明的结构搬迁，把逻辑重构留给有余量的后续。
- **保持「正文全搬进一个文件」** — 落选：实测该方案产出 737 行单文件、`execute` 仍 411 行，
  只是把「god function」换成「god file」，等于把债务挪个位置。
- **拆成两个 PR（先 decide，再 execute）** — 落选：同文件同根因，且两条路径的字段化用例已在同一
  批写好；两 PR 意味着两次串行合并（main `strict`）与两轮 5–7 分钟 CI，收益只是评审块更小。
- **顺手删掉不可达分支** — 落选（保留）：`attemptPlans.length === 0` 的守卫与其唯一调用点
  `createUnsupportedMediaError` 经集合推理**不可达**（`candidateAttempts` 恒含首个 requested
  attempt；有媒体需求时非 native 即 downgraded，两类之并恒等于全体）。删除是行为以外的独立清理，
  且它的「不可达」结论值得单独复核，故本次**原样搬走**并在此记录。
- **把内容门控循环也抽成二级生成器** — 落选（推迟）：`pending`/`hasYieldedContent` 的逻辑可以
  写成「yield 消费方可见事件 + 末尾 yield 哨兵」的二级生成器，能再削 ~35 行；但它触及流式热路径
  且与 `streamAttempt` 的哨兵语义叠加，收益小于风险，留给 `TD-ROUTER-009`。
- **重试判据保持内联布尔表达式** — 落选：issue 明确点名「重试判定纯函数」，且内联条件与副作用
  交缠时无法逐格验证「哪一个入参在承重」。抽成谓词后真值表用例只需翻转单个入参。
- **把 `streamAttempt` / `media/*` 也挂进 `src/router/index.ts`** — 落选：栏桶沿用仓内惯例——
  能力级模块（`decideRouterDecision` / `executeRouterDecision` / `preserveStickyForCache`）导出，
  `utils/*` 一类内部件不导出；`streamAttempt` 属后者，调用方只应是 `executeRouterDecision`。
- **把 `RouterExecutionDeps.healthTrackerFor` 换成直接传 `Map`** — 落选：`shutdown()` 要清
  `healthTrackers`，传回调可保住「表由 runtime 持有」的语义，避免把生命周期状态外泄给执行模块。
- **等价性判据停留在「识别式 allowlist」（正则 + 子串标记）** — 落选：写起来更省事，但负控制实测
  它漏掉「外提判据的实参漂移」与「行尾追加内容」两类漂移，无法支撑「零行为变化」这句话。改判据的
  代价是逐段转录 31 条精确映射并人工审计，收益是判据从「像不像已声明的编辑」变成「是不是就是这次
  编辑」。
- **把等价性校验脚本随 PR 提交** — 落选：脚本的切片范围与锚点是按 #343 的行号硬编码的，对后续改动
  没有复用价值，却在 `scripts/` 下留一份会误导后来者的「一次性设施」。仓内惯例是一次性验证脚本用完
  即删、方法与结论写进决策记录；**判据本身的通用形态**（精确重建 + 负控制四步）已并入交付 skill。

## Consequences

- 收益：`RouterRuntime.ts` 1230 → 190 行、`createRouterRuntime` 885 行 **退出最大方法榜**；主路径
  从「零直接单测」变为 32 条确定性用例（`decide` 的 `resolvedFrom` 溯源五个取值、cache-aware
  切换/保留、媒体重路由；`execute` 的 fallback、内容已产出后不重试、transient retry、zero-usage
  retry、全失败回放、媒体降级重发、子代理预算、取消）；全量套件 4431 例 0 失败。
- 事件面零变化：`docs/event-producer-consumer.md` 重生成后**83 个事件逐事件比对生产/消费集合**，
  唯一差异是 4 处 `error` 生产者由 `RouterRuntime.ts` 迁到 `execution/executeRouterDecision.ts`
  （计数 4 → 4），即纯位移。
- 代价（明说）：`executeRouterDecision` 429 行成为 `src/` 最大函数，比拆分前**更大**；两套重试
  分支的副作用编排仍在函数体内（`TD-ROUTER-009`）。本次赢的是「可测 + 可定位」，不是「变短」。
- 代价：新增 6 个目录层级更深的模块文件与 2 个 barrel 导出；读者需要在 7 个文件间跳转才能拼出
  一次完整路由。换来的是每个模块都能被单独实例化测试。
- 顺带发现（非本次引入）：台账 `TD-ROUTER-004` 引用的 `RouterRuntime.ts:421` 在拆分前就已漂移
  （HEAD 该行是 `scenarioType,`），且 `src/router/` 全量 grep 已无任何 `console.*`——该条疑已由
  他处修复，已在台账加复核注记待确认。
