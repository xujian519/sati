# Agent Note: bash 输出在采集阶段设上限

Status: implemented

## Problem
`NodeShellCommandRunner` 把子进程 stdout/stderr 逐块累加成**无界字符串**。
工具声明的 `maxResultBytes`（200KB）由 `ToolRuntime` 在结果组装完成后才截断，
对已经分配的内存无效。于是 `bash(command: "cat 大日志")`、`yes`、`find /` 之类
命令会在超时（默认 30s）之前把数 GB 文本攒进主进程，足以把 agent 进程撑到 OOM；
超时/报错时也可能先因内存耗尽而崩，用户只会看到进程消失。

## Decision
- 在 `commandRunner.ts` 引入 `CappedStreamCapture`：每条流保留头 40% + 尾 60%，
  上限 4,000,000 字符，超出部分丢弃并在结果中插入
  `[Sati] ... N characters omitted (output capped to bound memory) ...` 标记。
- 头尾都保留的原因：开头通常是上下文，结尾通常是编译/运行诊断，二选一会丢失
  关键信息。
- 进度回调（`onStdout`/`onStderr`）仍按原样逐块转发，不参与截断。

## Alternatives considered
- **仅在 `ToolRuntime` 层加大截断力度** —— 截断发生在字符串已经建好之后，
  无法阻止 OOM，落选。
- **超限直接杀进程并报 tool 错误** —— 会把「输出很多」误报成执行失败，
  且仍需要一个新错误码/结果字段，改动面更大。
- **只保留尾部** —— 会丢掉开头的命令上下文与首批数据，诊断价值下降。

## Consequences
- 单条流最多常驻约 8MB（UTF-16 字符），两条流约 16MB，内存上界可控。
- 超大输出被截断时，结果中的 `stdout_bytes` 统计是**截断后**的值，但标记行
  明确写出省略量，不构成静默数据丢失。
- 依赖「完整 stdout」的下游（目前只有模型与 UI 展示）不受影响。
