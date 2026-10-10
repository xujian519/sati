# Agent Note: desktop.server.log 逐行时间戳管道与 close 语义

Status: implemented

## Problem

desktop.server.log 汇总 gateway 与 ui server 两个子进程的全部 stdout/stderr，但行内没有任何时间戳：17MB/136k 行的文件里定位「哪次启动慢了、慢在哪一段、两个进程事件如何对齐」只能靠相邻行的上下文猜。spawnWithLog（`apps/desktop/src/server-manager.ts`）此前是把子进程 stdout/stderr 直接 pipe 到日志文件流。

## Decision

`createTimestampTransform()`（导出供测试）：Transform 逐行加 ISO 时间戳前缀——跨 chunk 断行用 carry 缓冲到下一 chunk 再补前缀（保证一行恰好一个前缀），stream end 时 flush 未换行的尾行。stdout/stderr 各持独立实例。`child.once("close", endLog)` 替代原 `exit`：'exit' 在 stdio 关闭前触发，Transform 缓冲可能未 flush 就结束了日志流；'close' 在所有 stdio 流关闭后触发，保证尾行不丢。日志轮转（20MiB、keep 3）此前已存在，本次无新增。

## Alternatives considered

- **每 chunk 加一个前缀** —— chunk 边界 ≠ 行边界：一行跨 chunk 时会被插入多个前缀或前缀落进行中间；选逐行缓冲。
- **stdout/stderr 共用一个 Transform** —— 两流 chunk 交错会让 carry 互相污染、断行错拼；各持实例。
- **保留 exit 事件挂 endLog** —— 尾部缓冲是否 flush 取决于事件时序，是隐性竞态；'close' 语义明确（stdio 全关后触发）。
- **时间戳在子进程侧打** —— gateway 日志源多且混有 tsx/MCP server 等第三方输出，子进程侧无法全覆盖；宿主管道是唯一收口点。
- **引入结构化日志库（pino 等）** —— 消费方（人 + grep）就是看文本，JSON 化降低可读性且引入依赖；保持「ISO 前缀 + 原始行」。

## Consequences

- **换来**：日志每行可独立时间定位（延迟分析、跨进程事件对齐不再靠猜）；尾行不丢。
- **付出**：时间戳是宿主写入时刻（与子进程产生时刻有毫秒级偏差）；每行 +25 字节；多一层 Transform（开销可忽略）。
