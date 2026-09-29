# Agent Note: Cron 日字段 OR 语义（调度计算版本 3）

Status: implemented

## Problem

Unix cron 规定：当「月内日期（day-of-month）」与「星期（day-of-week）」两个字段都不以 `*` 开头时，两者按 **OR** 匹配。Sati 的 `matchesCron` 把五个字段一律用 `&&` 串联，于是 `0 9 1 * 1` 被解释成「既是每月 1 号又是周一」——下一次触发要等到两者重合（如 2027-02-01），而用户表达的「每月 1 号或每周一」根本不成立。这类表达式在自然语言里很容易被写下（「每月 1 号和每周一提醒我」），而缺陷形态是「任务很少触发」，不像报错那样显眼。

## Decision

新增 `CRON_SCHEDULE_COMPUTATION_VERSION = 3` 与判据 `cronDayFieldsUseOr(expression)`：两个日字段都不以 `*` 开头时按 OR，任一方以 `*` 开头（含 `*/n`）保持 AND，`matchesCron` 据此分流。判据取自表达式**原文**而非展开后的集合——`1-31` 与 `*` 展开结果相同但语义不同（前者是显式列举全部日期，仍走 OR）。

版本号 2 → 3 落在 `CronTask.scheduleComputationVersion`；`CronScheduler` 的缓存门改用常量，并在启动时迁移 v2 缓存：日语义未变的表达式直接复用旧 `nextRunAt`（避免最坏一年的逐分钟搜索）；日语义改变的取「旧缓存」与「OR 下新算」中较早者——OR 只会让触发提前，而落在未来的旧缓存可能是被并发上限推迟的逾期触发，不能被推后。迁移只改写版本号与 revision 一次，二次启动复用。

闰日捷径（`2/29` 的按年搜索）在 OR 语义下必须让路：`0 0 29 2 1` 会被「周一」命中，走捷径会漏掉非闰年的触发点。

模型可见面同步说明规则：`cron_create` 的 `inputSchema.schedule.expression` 描述与工具 `description` 都补上 OR/AND 判据与 `0 9 1 * 1` 的例子。

## Alternatives considered

- **保持 AND，仅文档说明** — 落选：与 Unix cron 语义相悖，从其他系统迁来的表达式会静默改含义；且「1 号且周一」本就无法用五字段表达，用户无从写起。
- **保留 AND 模式并加开关** — 落选：同一表达式在同一进程有两种含义，`nextRunAt` 缓存与展示失去可信基准。
- **迁移时一律重算 `nextRunAt`** — 落选：会把被并发上限推迟的逾期触发推后（丢掉一次应触发），并在日语义未变的任务上做最坏 366×24×60 次逐分钟匹配。
- **迁移时一律保留旧缓存** — 落选：等于保留缺陷本身（`0 9 1 * 1` 的 `2027-02-01` 被永久沿用）。
- **按展开后集合的大小判断通配** — 落选：`1-31` 与 `*` 展开相同，会误判为通配。

## Consequences

- 「双日字段受限」的**存量**任务升级后会触发得更频繁。若任务做无人值守写盘，影响面不小。Sati 没有 release 兼容性文档这一载体，故该行为变更在本 note 与 `cron_create` 的工具描述中留痕。
- 表达式解析成本不变（判据复用既有 `parseCronExpression`）。
- `scheduleComputationVersion` 只存在于任务记录内、不进模型可见投影，故不影响上下文预算或请求重建对拍。
- 工具 `inputSchema` 的描述文本变更按 AGENTS 规则 6 需重录 llm-replay fixture；实测本仓唯一 fixture（`tests/fixtures/llm-replay/deepseek-v4-flash-basic/`）的请求键不含 cron 工具 schema，键未变，无需重录。
