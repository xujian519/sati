# Agent Note: Transcript 写入韧性加固（单次 write + torn-tail 自愈）

Status: implemented

## Problem

`JsonlTranscriptWriter` 用 `appendFile` 批量落盘，有两个把单次崩溃放大为一整段污染的隐患（对齐 PenguinHarness trace/writer.ts 的规避）：(a) `appendFile` 对超过 Node 内部 512 KiB 分块阈值（`kWriteFileMaxChunkSize`）的**单条记录**自动拆成多次底层 write，进程死在分块之间会留下半条记录，其后所有记录因缺换行而粘连到它；(b) 续写不探测文件尾是否以 `\n` 结尾，崩溃残留的半行会继续粘连新记录。读取端虽有 `line_invalid` 容错，但防不了"一条撕裂记录粘连后续多条"中间态。

## Decision

- 落盘从 `appendFile` 改为 `open(path,"a")` + **逐条 `write(2)`**（带短写循环、零进度抛错并标记 torn），每次 flush 仍一次 open/close、每次记录一个独立 write，避免 512 KiB 自动分块撕裂单条记录。
- 新增 `probeTornTail()` + `tornTail` 状态位：进程首次写该文件时探测文件尾，非 `\n` 结尾则下一记录补 `\n` 从新行开始（半行由读取端 `line_invalid` 跳过）。
- 加 `SATI_TRANSCRIPT_SINGLE_WRITE` 开关（默认开 `1`，显式 `0` 回退 `appendFile`），便于异常回滚与性能对照。
- 不改 transcript 数据格式（仍每行一条 JSON），不触碰 reader / `AgentTranscriptEntry` / 事件面。

## Alternatives considered

- **维持 `appendFile` 批量** — 512 KiB 分块撕裂在超大 records 进 transcript 时真实存在，且后续记录粘连会放大破坏面，弃。
- **只补 torn-tail 探测、不改单条 write** — 能救"崩溃续写"，但救不了"本进程内 512 KiB 分块把单条记录撕成两半、后续行粘连"，必须两者都做，弃。
- **改内容格式（每条对象 / 引入日志库）** — 破坏既有 JSONL 契约与 reader/resume 依赖，代价过大，弃。
- **`appendFile` 但每次只写一条** — 对超 512 KiB 的单条仍会分块，无法根治，必须 O_APPEND + 手动 write，弃。
- **无开关直接替换** — 写入路径属关键路径，保留 env 开关使线上可即时回退，弃。

## Consequences

换来：崩溃/超大记录下不再出现"一条撕裂记录污染后续所有记录"，resume 可靠性更高。付出：写入路径实现略复杂；默认路径由批量 `appendFile` 变为逐条 `write`（一次 flush 仍一次 open，性能开销可忽略）；需维护 `SATI_TRANSCRIPT_SINGLE_WRITE` 开关。事件矩阵因 `JsonlTranscriptWriter` 行号漂移（file_artifacts 生产者行 181→189）而重新生成，属合规行号变化，非新增/删除事件。
