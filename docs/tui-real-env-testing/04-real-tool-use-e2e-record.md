# TUI 真实工具调用帧记录测试

本文使用 `scripts/tui-e2e-record.tsx` 验证真实模型通过 TUI 触发工具调用。该脚本会注册一个真实 `add_numbers` 工具，渲染真实 `TuiApp`，把 prompt 输入到 TUI，并把所有帧保存到 `artifacts/tui-e2e-frames.log`。

## 脚本行为

脚本默认参数：

```text
POLITDECK_E2E_PROVIDER=edgeclaw
POLITDECK_E2E_MODEL=moonshotai/kimi-k2.6
POLITDECK_E2E_PROMPT=Use add_numbers to compute 17 + 25, then tell me the result.
```

脚本注入的 system prompt 要求模型必须调用 `add_numbers`，而不是自己心算。工具返回：

```json
{ "sum": 42 }
```

## 用例 1：默认真实工具调用

### 输入

准备真实 provider 配置与 API key 后执行：

```bash
npm run build
mkdir -p artifacts
POLITDECK_E2E_PROVIDER=edgeclaw \
POLITDECK_E2E_MODEL=moonshotai/kimi-k2.6 \
node dist/scripts/tui-e2e-record.js
```

### 预期现象

终端会打印四个关键帧：

```text
--- cold start (...)
--- after typing prompt (...)
--- submit (...)
--- final (...)
```

帧内容应体现以下过程：

- cold start 帧只有 header、welcome card 和输入框。
- after typing prompt 帧中输入框展示完整 prompt。
- submit 后 transcript 出现 `You` 和用户输入。
- 运行中出现 `thinking` 或工具 activity。
- final 帧中出现工具结果和 `PolitDeck` 回复。
- final 帧中不再残留 `thinking`。

### 预期输出

脚本退出码为 `0`，并保存：

```text
artifacts/tui-e2e-frames.log
```

最终帧必须包含数字：

```text
42
```

日志中应能看到工具结果行，通常以 `⎿` 前缀渲染，内容为 `42` 或包含 `42` 的结果预览。

## 用例 2：开启 Gateway event trace

### 输入

```bash
npm run build
mkdir -p artifacts
POLITDECK_E2E_TRACE=1 \
POLITDECK_E2E_PROVIDER=edgeclaw \
POLITDECK_E2E_MODEL=moonshotai/kimi-k2.6 \
node dist/scripts/tui-e2e-record.js
```

### 预期现象

除了 TUI 帧，终端还会打印 Gateway event trace：

```text
[trace] submitTurn() called
[trace ...] tool_call_started add_numbers
[trace ...] tool_call_finished add_numbers
[trace ...] assistant_text_delta ...
[trace] turn finished after ...
```

### 预期输出

trace 中必须包含：

- `submitTurn() called`
- `tool_call_started`
- `tool_call_finished`
- 至少一个 `assistant_text_delta`

最终帧仍然包含 `42`，脚本退出码为 `0`。

## 用例 3：自定义 prompt 仍要求工具调用

### 输入

```bash
npm run build
mkdir -p artifacts
POLITDECK_E2E_PROVIDER=edgeclaw \
POLITDECK_E2E_MODEL=moonshotai/kimi-k2.6 \
POLITDECK_E2E_PROMPT="Use add_numbers to compute 100 + 23, then answer only with the number." \
node dist/scripts/tui-e2e-record.js
```

### 预期现象

- 输入框显示自定义 prompt。
- 模型调用 `add_numbers`。
- 工具 activity 完成后 transcript 出现工具结果。

### 预期输出

当前脚本的完成条件仍固定检查最终帧包含 `42`，因此这个用例预期会超时失败，除非同步修改脚本的完成条件。该用例用于暴露脚本断言与自定义 prompt 之间的约束。

预期失败输出：

```text
Timed out waiting for the assistant final frame.
```

如果需要让自定义 prompt 成为常规可通过用例，应先把脚本完成条件改为读取预期答案环境变量，例如 `POLITDECK_E2E_EXPECTED_TEXT`。

## 用例 4：模型未调用工具时的失败判定

### 输入

使用一个不支持 tool use 的模型，或在配置中把目标模型 `supportsToolUse` 配置为 `false`，再执行默认脚本。

### 预期现象

- 可能出现模型配置、请求构造或 provider 错误。
- 如果模型直接输出答案但没有工具事件，trace 中不会出现 `tool_call_started add_numbers`。

### 预期输出

该用例应判为失败。合格的真实工具调用测试必须同时满足：

- trace 或帧日志中出现工具调用过程。
- final 帧包含 `42`。
- `thinking` 清除。
- 退出码为 `0`。
