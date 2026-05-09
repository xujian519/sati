# TUI 真实环境准备与通用流程

本文定义运行 TUI 真实环境测试前必须准备的配置、命令和记录方式。具体测试用例见本目录后续文档。

## 1. 前置条件

### 输入

在项目根目录执行：

```bash
npm install
npm run build
```

准备 PolitDeck 配置。默认配置路径为：

```text
~/.politdeck/politdeck.yaml
```

也可以用 `POLIT_HOME` 指向临时目录：

```bash
export POLIT_HOME=/tmp/politdeck-real-tui
mkdir -p "$POLIT_HOME"
```

配置中至少需要包含 `agent.model` 和对应 `model.providers`。示例：

```yaml
agent:
  model: edgeclaw/moonshotai/kimi-k2.6

model:
  providers:
    edgeclaw:
      protocol: openai
      url: https://openrouter.ai/api/v1
      apiKey: ${OPENROUTER_API_KEY}
      timeoutMs: 120000
      models:
        moonshotai/kimi-k2.6:
          capabilities:
            supportsToolUse: true
            supportsStreaming: true
            supportsParallelToolCalls: false
            supportsThinking: false
            supportsJsonSchema: true
            supportsSystemPrompt: true
            supportsPromptCache: false
            maxContextTokens: 128000
            maxOutputTokens: 8192
          multimodal:
            input: [text]
```

设置真实 provider key：

```bash
export OPENROUTER_API_KEY=<真实 key>
```

### 预期现象

- `npm run build` 成功生成 `dist/`。
- 启动 TUI 时不会因为配置缺失、provider 缺失或 API key 环境变量缺失而退回不可用网关。
- 如果配置错误，TUI 可以启动但提交 turn 后会显示错误消息，或者 CLI 直接打印配置错误。

### 预期输出

`npm run build` 退出码为 `0`。若失败，先修复 TypeScript 或配置问题，再继续真实 TUI 测试。

## 2. 启动 TUI 的标准命令

### 输入

```bash
node dist/src/cli/politdeck.js tui
```

也可以先启动 server，再启动 TUI：

```bash
node dist/src/cli/politdeck.js server --port 18789
```

另开一个交互式终端：

```bash
node dist/src/cli/politdeck.js tui
```

### 预期现象

- 交互式终端中出现 `PolitDeck ↗` header。
- 冷启动时显示 welcome card、模型、cwd、连接状态和输入框。
- 输入框中能看到 `Ask PolitDeck... (/help)` placeholder。
- 非交互式 stdin 下执行 `politdeck tui` 会报错。

### 预期输出

交互式模式不会立即退出。非交互式执行时预期 stderr：

```text
politdeck tui requires an interactive terminal.
```

## 3. 通用记录方式

### 输入

手工验收时记录以下信息：

```text
测试时间：
Git commit：
POLIT_HOME：
provider/model：
命令：
TUI 输入：
屏幕现象：
最终输出：
是否通过：
```

自动帧记录使用：

```bash
mkdir -p artifacts
POLITDECK_E2E_PROVIDER=edgeclaw \
POLITDECK_E2E_MODEL=moonshotai/kimi-k2.6 \
node dist/scripts/tui-e2e-record.js
```

### 预期现象

- 脚本会依次打印 `cold start`、`after typing prompt`、`submit`、`final` 帧。
- `artifacts/tui-e2e-frames.log` 会保存所有 TUI 帧。

### 预期输出

脚本成功时退出码为 `0`，并输出类似：

```text
Saved <N> frames to <repo>/artifacts/tui-e2e-frames.log
```

如果 120 秒内没有拿到最终答案，脚本会失败并报：

```text
Timed out waiting for the assistant final frame.
```
