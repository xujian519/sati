# TUI Memory 与 Context 真实测试

本文验证 TUI turn 会接入 `DefaultContextRuntime`、`MemoryAttachmentBuilder` 和 `EdgeClawMemoryProvider`。真实链路为：

```text
TuiApp
  -> Gateway.submitTurn()
  -> AgentSession
  -> DefaultContextRuntime.prepareForModel()
  -> MemoryResolver.retrieve()
  -> <memory-context> 注入 system prompt parts
  -> ModelRuntime.stream()
  -> DefaultContextRuntime.captureTurn()
  -> MemoryResolver.captureTurn()
```

当前 memory 通过 `memory` 配置段启用，provider 只支持 `edgeclaw`。memory provider 错误不应打断 TUI turn。

## 用例 1：启用 memory 后跨会话召回

### 输入

准备独立 `PILOT_HOME` 和 memory 根目录：

```bash
export PILOT_HOME=/tmp/pilotdeck-tui-memory
export PILOTDECK_MEMORY_ROOT=/tmp/pilotdeck-tui-memory-store
mkdir -p "$PILOT_HOME" "$PILOTDECK_MEMORY_ROOT"
```

在 `$PILOT_HOME/pilotdeck.yaml` 中启用 memory：

```yaml
agent:
  model: edgeclaw/moonshotai/kimi-k2.6

memory:
  enabled: true
  provider: edgeclaw
  rootDir: /tmp/pilotdeck-tui-memory-store
  captureStrategy: full_session
  includeAssistant: true
  maxMessageChars: 4000

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

启动 TUI：

```bash
npm run build
node dist/src/cli/pilotdeck.js tui
```

第一轮输入：

```text
请记住一个测试事实：PilotDeck TUI memory 验收代号是 BLUE-HERON-742。只回复 OK。
```

等待完成后输入：

```text
/new
```

在新会话里输入：

```text
只根据你能检索到的记忆回答：PilotDeck TUI memory 验收代号是什么？如果没有相关记忆，只回答 UNKNOWN。
```

### 预期现象

- 第一轮完成后 TUI 显示 `OK` 或等价确认。
- `/new` 后 transcript 显示 `New session: ...`，旧会话上下文不再直接出现在新 transcript 中。
- 第二轮仍会出现 `thinking` 并正常完成。
- memory 根目录下出现 EdgeClaw memory 相关文件或数据库文件。

### 预期输出

第二轮最终回复必须包含：

```text
BLUE-HERON-742
```

如果第二轮回答 `UNKNOWN`，或者只在同一 transcript 中依赖旧消息而没有跨会话召回，则该用例失败。

## 用例 2：memory disabled 时不召回

### 输入

复用相同 `PILOT_HOME`，但关闭 memory，并使用新的 memory root 避免历史数据干扰：

```yaml
memory:
  enabled: false
  provider: edgeclaw
  rootDir: /tmp/pilotdeck-tui-memory-disabled-store
```

启动 TUI，输入：

```text
请记住一个测试事实：禁用 memory 的代号是 DISABLED-MEMORY-991。只回复 OK。
```

完成后输入：

```text
/new
```

再输入：

```text
只根据你能检索到的记忆回答：禁用 memory 的代号是什么？如果没有相关记忆，只回答 UNKNOWN。
```

### 预期现象

- 两个 turn 都能正常完成。
- memory disabled 不应导致 TUI 报错。
- 第二个新会话没有 memory 注入。

### 预期输出

第二轮应回答：

```text
UNKNOWN
```

如果模型输出 `DISABLED-MEMORY-991`，需要检查是否仍在同一会话、是否复用了启用 memory 的 rootDir，或者模型是否从 prompt 外部信息中猜测。该用例应使用全新 `PILOT_HOME` 和 rootDir 复测。

## 用例 3：memory 检索失败不阻断 turn

### 输入

把 `memory.rootDir` 指向一个当前进程无权写入或无法创建的路径。macOS 本地可使用只读挂载路径；如果没有稳定的只读路径，可临时把目录创建为不可写：

```bash
export PILOT_HOME=/tmp/pilotdeck-tui-memory-error
mkdir -p "$PILOT_HOME" /tmp/pilotdeck-tui-memory-readonly
chmod 500 /tmp/pilotdeck-tui-memory-readonly
```

配置：

```yaml
memory:
  enabled: true
  provider: edgeclaw
  rootDir: /tmp/pilotdeck-tui-memory-readonly
  captureStrategy: full_session
```

启动 TUI 后输入：

```text
即使 memory provider 失败，也请只回答 MEMORY-NON-FATAL-OK。
```

### 预期现象

- TUI turn 不应因为 memory 失败而崩溃。
- transcript 中仍出现 `PilotDeck` 回复。
- 允许 stderr 或日志中出现 memory provider 相关 warning。
- turn 完成后 `thinking` 消失。

### 预期输出

最终回复应包含：

```text
MEMORY-NON-FATAL-OK
```

测试完成后恢复权限：

```bash
chmod 700 /tmp/pilotdeck-tui-memory-readonly
```

## 用例 4：captureStrategy 影响召回范围

### 输入

配置 `captureStrategy: last_turn`：

```yaml
memory:
  enabled: true
  provider: edgeclaw
  rootDir: /tmp/pilotdeck-tui-memory-last-turn
  captureStrategy: last_turn
  includeAssistant: false
```

启动 TUI，连续输入两轮：

```text
第一条事实：代号 A 是 ALPHA-111。只回复 OK。
```

```text
第二条事实：代号 B 是 BRAVO-222。只回复 OK。
```

然后输入 `/new`，再问：

```text
只根据记忆回答：代号 A 和代号 B 分别是什么？没有记忆的项目回答 UNKNOWN。
```

### 预期现象

- memory 只按最后一轮策略捕获最近 turn。
- 新会话可以召回第二条事实的概率应高于第一条事实。

### 预期输出

通过标准：

- 回复包含 `BRAVO-222`。
- 如果未包含 `ALPHA-111`，符合 `last_turn` 策略预期。
- 如果同时包含两者，需要检查 EdgeClaw memory service 是否进行了跨 turn 聚合；此时应记录为 provider 行为差异，而不是 TUI 故障。
