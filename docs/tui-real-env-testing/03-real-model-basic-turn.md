# TUI 真实模型对话测试

本文验证用户从 TUI 输入一条普通消息后，真实链路能够完成一次模型 turn。链路为：

```text
TuiApp
  -> Gateway.submitTurn()
  -> AgentSession
  -> RouterRuntime
  -> ModelRuntime.stream()
  -> provider API
  -> GatewayEvent
  -> TUI transcript
```

## 用例 1：普通文本对话

### 输入

准备真实 provider 配置和 API key，执行：

```bash
npm run build
node dist/src/cli/politdeck.js tui
```

在 TUI 中输入：

```text
请用一句话回答：PolitDeck 是什么？
```

按 `Enter`。

### 预期现象

- 输入提交后，transcript 中出现：

```text
You
请用一句话回答：PolitDeck 是什么？
```

- 底部出现 spinner，形态类似：

```text
thinking · 0.1s
```

- 模型开始流式返回后，transcript 中出现 `PolitDeck` label。
- 回复完成后 `thinking` 消失，输入框恢复可输入状态。
- 如果 provider 返回错误，transcript 中出现红色错误消息，不应卡在 running 状态。

### 预期输出

成功时，最终 transcript 至少包含一段 assistant 文本，例如：

```text
PolitDeck
PolitDeck 是一个面向 AI agent runtime 的终端交互与网关编排工具。
```

不要求逐字一致，但必须满足：

- assistant 文本非空。
- 回复与问题语义相关。
- turn 完成后没有残留 `thinking`。
- 进程保持运行，等待下一次输入。

## 用例 2：空输入不提交

### 输入

启动 TUI 后直接按 `Enter`，或只输入空格后按 `Enter`。

### 预期现象

- 输入框清空或保持空态。
- 不新增 `You` 消息。
- 不出现 `thinking`。
- 不访问模型 provider。

### 预期输出

TUI 无新增 transcript 输出，进程继续运行。

## 用例 3：运行中 Ctrl+C 中断

### 输入

启动 TUI 后输入一个较长请求：

```text
请详细解释 PolitDeck 的 agent、gateway、router、model、tool 模块如何协作，至少写 800 字。
```

按 `Enter`。看到 `thinking` 或开始流式输出后，按：

```text
Ctrl+C
```

### 预期现象

- TUI 调用 `gateway.abortTurn()`。
- 当前 running 状态结束后输入框恢复焦点。
- 如果 provider 已经输出部分内容，transcript 可以保留已输出内容。
- 再次按 `Ctrl+C` 时 TUI 退出。

### 预期输出

允许出现 provider 或 runtime 的中断相关错误消息，但不允许：

- spinner 永久停留。
- 输入框永久不可用。
- 进程无响应。

## 用例 4：配置错误展示

### 输入

临时设置一个缺少 API key 的 `POLIT_HOME`：

```bash
export POLIT_HOME=/tmp/politdeck-tui-missing-key
mkdir -p "$POLIT_HOME"
cat > "$POLIT_HOME/politdeck.yaml" <<'YAML'
agent:
  model: bad-provider/bad-model
model:
  providers:
    bad-provider:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: ${MISSING_POLITDECK_KEY}
      models:
        bad-model:
          capabilities:
            supportsToolUse: false
            supportsStreaming: true
            supportsParallelToolCalls: false
            supportsThinking: false
            supportsJsonSchema: false
            supportsSystemPrompt: true
            supportsPromptCache: false
            maxContextTokens: 1000
            maxOutputTokens: 256
          multimodal:
            input: [text]
YAML
unset MISSING_POLITDECK_KEY
npm run build
node dist/src/cli/politdeck.js tui
```

在 TUI 中输入：

```text
hello
```

### 预期现象

- 如果 local gateway 创建失败，TUI 会使用 fallback gateway。
- 提交后 transcript 显示错误消息。
- 不会显示虚假的 assistant 成功回复。

### 预期输出

错误文案应能指向本地配置或 gateway 不可用问题，例如：

```text
No PolitDeck server is available and local config could not start session ...
```

或模型配置解析错误。退出码不作为该用例的主要断言，主要断言是 TUI 不假装成功且不挂死。
