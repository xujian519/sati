# P0-2 Transcript 韧性加固（单次 write + torn-tail 自愈）设计方案

> 对标 PenguinHarness `packages/core/src/trace/writer.ts`。只做设计，不实施。

---

## 1. 问题与目标

`JsonlTranscriptWriter`（`src/session/transcript/JsonlTranscriptWriter.ts`）目前用 `appendFile` 批量落盘，存在两个 PenguinHarness 刻意规避的隐患：

1. **大记录撕裂**：`appendFile` 在单次调用写入超过 Node 内部 `kWriteFileMaxChunkSize`（512 KiB）时会拆成多次底层 `write(2)`。进程死在分块之间会在磁盘留下**前半段**，而后一条记录因为没有换行会被**粘连到这条半行上**——一个崩溃就把这一行以及其后所有行污染成一条不可解析的 JSON。Sati 的 model-visible 历史里可能有超大 `tool_call` arguments 或超长工具输出进入 transcript，风险真实存在。
2. **续写不补换行**：进程在"某条记录写到一半"时崩溃（被 OS 截断的短写），下次续写不会探测文件尾是否以 `\n` 结尾，新记录会直接粘到半行上。

现有对抗手段（`writeChain` 串行 + `flushCheckpoint` + fail-closed + reader 的 `line_invalid` 容错）能处理"整批次没落盘"，但处理不了"单条记录被 512 KiB 分块撕裂、其后记录粘连"这一中间态。

**目标**：写入侧保证（a）任何单条记录不会被撕裂；（b）续写前探测文件尾，撕裂则从新行起补 `\n`。读取侧已有 `parseLine` 容错可保留。

---

## 2. 改动设计（集中在一个文件）

只改 `JsonlTranscriptWriter.ts`，不改 transcript 数据格式（仍是 JSONL，每行一条），不触碰 `AgentTranscriptEntry` / reader / 事件面。

### 2.1 写入路径改为「open(`a`) + 逐条 write(2)」

把 `flushPending()`（当前 `appendFile(this.options.path, lines.join(""))`）改为：

```
open(path, "a")   # 一次 flush 一次 open/close，保持"每批一次系统 open"
for each line in lines:
    fh.write(line)   # 每条记录一次独立的 write(2)，带短写循环
```

要点（对齐 penguin `appendRecord`）：
- 用 **O_APPEND 句柄 + 单次 `write(2)`**，而不是 `appendFile`，避免 512 KiB 自动分块。
- **逐条 write** 而不是 `lines.join("")` 一次写：保证一条记录的字节不会被拆分——即使整批超过 512 KiB，也是每条记录一个完整 write，任何崩溃最多撕裂"当前这条"，不会粘连后续（后续每条有自己的换行结尾，opaque reader 跳过撕裂行后仍能解析后面）。
- **短写循环**：`write` 返回字节数可能小于请求；循环直到写完，`bytesWritten <= 0`（ENOSPC 零进度）则抛错并标记 torn。任何中途失败（`written > 0`）标记 `tornTail = true`。
- `mkdir` / `dirReady` 自愈逻辑、`writeChain` 串行链、ack/resolve 语义**全部保留**，只替换落盘调用本身。

性能说明：一次 flush 仍是一次 `open`，内部逐条 `write`，相比原来"一次 `appendFile` 一条超大 write"的开销可忽略；换来的是记录级原子性与崩溃安全。

### 2.2 续写 torn-tail 探测 + 补 `\n`

新增 `private tornTail = false` 与 `probeTornTail(path)`（对齐 penguin）：

- 首次写某文件（或 resume 后第一次写）时 `open(path,"r")` + 读最后 1 字节；非 `\n` 结尾且非空 → `tornTail = true`。
- 下一条记录写入时，若 `tornTail` 则前缀 `\n`，再写记录本体，写成功清位。
- 语义：崩溃留的半行不会导致新记录粘连；半行本身由 reader 的 `line_invalid` 容错跳过。

### 2.3 灰度开关 + 向后兼容

- 新增 `SATI_TRANSCRIPT_SINGLE_WRITE`（默认 `"1"` 开），显式关闭时回退 `appendFile` 批量路径，便于线上回滚与性能对照。
- 输出格式不变，旧 session 文件照常读/续写（续写会 probe torn-tail，属于本次新增的净化行为）。

---

## 3. 新增/改动文件清单

- 改：`src/session/transcript/JsonlTranscriptWriter.ts`（写入路径 + probeTornTail + tornTail 状态 + env 开关）。
- 新增测试：`tests/session/transcript/jsonl-writer-torn-tail.spec.ts`。
- 不改：`TranscriptReader.ts`（已有 `line_invalid` 容错，保留）、`TranscriptEntry.ts`、`AgentTranscriptWriter` 接口、任何事件面。

---

## 4. 测试策略

1. **大记录不撕裂**：写入一条 UTF-8 超过 512 KiB 的 `durable_message`（含超大 tool_call arguments / 长中文），完成后 `readTranscript` 能完整解析全部条目，无 `line_invalid`。
2. **torn-tail 探测**：构造一个文件尾不以 `\n` 结尾（模拟崩溃半行），用同一 Writer 续写一条；断言新记录从新行开始（文件内容 = 半行 + `\n` + 新记录 + 换行），reader 只报旧半行 `line_invalid` 且能解析新记录。
3. **短写失败标记**：模拟写中断（注入 `fh.write` 抛错），断言 `tornTail` 被置位、下一批正确补 `\n`。
4. **回归**：既有 `tests/session/transcript/jsonl-writer.spec.ts`（写链 M3 缓冲 / restoreState 续写 / forSubagent 侧链 / 子代理预览截断）全部保持 green。
5. 走 `pnpm test`（后端子集）+ `pnpm check`（typecheck/lint/format/事件矩阵——本改动不触事件面，事件矩阵应 green）。

---

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 写入路径改动影响所有 session 持久化 | 输出格式不变；env 开关灰度；既有 writer 测试回归；先小流量对照 |
| 逐条 write 带来的性能顾虑 | 一次 flush 仅一次 open；写路径开销可忽略；开关可立即回退 |
| 半行 skip 丢数据 | 半行本就是不完整记录（要么已被 OS 截断、要么被 512 KiB 撕裂），跳过它不丢任何**完整**记录；resume 由 `request_header` 断点兜底 |
| 多进程写同一文件（不支持场景） | 沿用现有"单写者"契约；单次 write 在本地 O_APPEND 原子文件系统上仍比 appendFile 更稳 |

---

## 6. Alternatives considered

- **方案 A：无改（维持 appendFile 批量）** —— 落选：512 KiB 分块撕裂在"超大 records 进 transcript"时真实存在，且后续记录粘连会放大单次崩溃的破坏面。
- **方案 B：只补 torn-tail 探测，不改写入为单条 write** —— 部分采纳但不够：探测能救"崩溃续写"，但救不了"本进程内 512 KiB 分块把单条记录撕成两半、后续行粘连"（appendFile 自动分块发生在一次调用内部）。必须两者都做。
- **方案 C：改传内容格式（如每条一个对象/引入日志库）** —— 落选：改动破坏既有 JSONL 契约与 reader/resume 依赖，为韧性付出过大代价。
- **方案 D：用 `fs.appendFile` 但每次只写一条** —— 落选：`appendFile` 对超 512 KiB 的单条依然会自动分块，无法解决问题；必须用 O_APPEND 句柄 + 手动 write。
- **方案 E：无开关直接替换** —— 落选：写入路径属关键路径，保留 env 开关使线上可即时回退，避免一次性全量切换风险。
