# TUI + Server Always-On 真实测试

本文验证 `pilotdeck server` 启动 Always-On runtime 后，TUI 仍能作为同一项目的真实交互入口连接 server，并通过日志、会话列表和 `${PILOT_HOME}/always-on` 产物验证 Always-On 行为。

Always-On 当前由 server 进程启动，不是单独的 TUI 命令。TUI 在本组用例中的作用是：

- 连接同一个 Gateway server，确认 server 与 TUI 可同时工作。
- 通过普通用户 turn 制造项目会话和近期用户活动。
- 通过 `/sessions` 观察 Always-On discovery / execute session 是否进入会话列表。
- 对 Always-On 产出的 plan、report、workspace 文件进行人工复核。

## 用例 1：server 启动 Always-On runtime

### 输入

准备一个启用 Always-On 的 `pilotdeck.yaml`。`projects` key 必须是当前项目的绝对路径：

```yaml
agent:
  model: edgeclaw/moonshotai/kimi-k2.6

alwaysOn:
  enabled: true
  trigger:
    enabled: true
    tickIntervalMinutes: 1
    cooldownMinutes: 0
    dailyBudget: 2
    heartbeatStaleSeconds: 90
    recentUserMsgMinutes: 0
    preferChannel: tui
  dormancy:
    enabled: false
    debounceMs: 2000
    ignoreGlobs:
      - "**/.git/**"
      - "**/node_modules/**"
      - "**/dist/**"
      - "**/.pilotdeck/**"
  workspace:
    snapshotMaxBytes: 1073741824
    gitLfs: false
  execution:
    maxTurns: 30
    maxToolCalls: 200
    timeoutMinutes: 20
  projects:
    /Users/gucc1/Codes/work/modelbest/PilotDeck:
      enabled: true

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

终端 A：

```bash
npm run build
node dist/src/cli/pilotdeck.js server --port 18789
```

终端 B：

```bash
node dist/src/cli/pilotdeck.js tui
```

### 预期现象

终端 A 输出：

```text
PilotDeck server listening: ...
WebSocket: ...
[always-on] always-on runtime started ...
```

终端 B 的 TUI 显示：

```text
server connected
```

或显示具体 server URL。TUI 不应退回 `local in-process`。

### 预期输出

server 与 TUI 都保持运行。`${PILOT_HOME}/always-on/` 下应开始出现项目级目录、state 或 run history 相关文件。若没有出现，等待至少一个 `tickIntervalMinutes` 周期后复查。

## 用例 2：Always-On discovery 无 plan

### 输入

保持用例 1 的 server 和 TUI 运行。为了降低模型产生 plan 的概率，在项目没有明显改动时等待一次 tick。也可以在项目根目录只做无关文件触发后再等待：

```bash
touch /tmp/pilotdeck-always-on-noop-signal
```

不要在 TUI 中发送新消息，等待至少 70 秒。

### 预期现象

- server 日志出现 Always-On tick 或 fire 相关日志。
- 如果 discovery 没有生成 plan，日志应出现：

```text
[always-on] always-on fire complete ... "outcome":"no_plan"
```

- TUI 仍然可用，可以继续输入普通消息。

### 预期输出

`${PILOT_HOME}/always-on/.../run-history.jsonl` 中出现一次 outcome 为 `no_plan` 的记录。TUI 中执行：

```text
/sessions
```

可能看到 `always-on/discovery:project=...` 会话，也可能因为 session 已关闭只看到普通 TUI 会话；关键验收产物以 run history 为准。

## 用例 3：Always-On discovery 生成 plan 并执行

### 输入

在项目根目录创建一个明确的待办信号文件，增加模型生成 plan 的概率：

```bash
cat > .pilotdeck-always-on-signal.md <<'MD'
# Always-On 测试信号

请生成一个最小 plan：在 artifacts/always-on-smoke.txt 写入 ALWAYS-ON-SMOKE-OK，并在 report 中说明验证方式。
MD
```

等待下一次 tick。若 `dormancy.enabled` 为 `true`，确保该文件路径没有命中 ignore globs。

### 预期现象

- server 日志出现 `always-on fire complete`。
- 如果模型调用 `always_on_discovery_plan` 工具，`${PILOT_HOME}/always-on/.../plans/` 下出现 plan markdown。
- 如果 plan 被执行，`${PILOT_HOME}/always-on/.../reports/` 下出现 report markdown。
- Always-On execution session 的 cwd 应位于 `${PILOT_HOME}/always-on/worktrees` 或 `${PILOT_HOME}/always-on/snapshots` 下，不应直接在项目根执行。

### 预期输出

至少一个 run history 记录 outcome 为：

```text
executed
```

或在模型未产出 plan 时为：

```text
no_plan
```

若 outcome 为 `executed`，预期满足：

- plan 文件存在。
- report 文件存在。
- report 中包含 `Verification Results` 或兜底补齐的验证章节。
- 如果模型按信号执行，隔离 workspace 中应出现 `artifacts/always-on-smoke.txt`，内容包含 `ALWAYS-ON-SMOKE-OK`。

## 用例 4：TUI 用户活动阻止 Always-On

### 输入

把 `recentUserMsgMinutes` 设置为非零，例如：

```yaml
alwaysOn:
  trigger:
    recentUserMsgMinutes: 5
```

重启 server 和 TUI。在 TUI 中输入：

```text
这是 Always-On gate 测试，请只回答 USER-ACTIVITY-OK。
```

等待回复完成后，等待下一次 Always-On tick。

### 预期现象

- TUI 普通 turn 正常完成。
- server 日志在下一次 tick 输出 gate blocked，reason 为：

```text
recent_user_msg
```

- Always-On 不应启动 discovery turn。

### 预期输出

run history 不应新增 `executed` 或 `no_plan` fire 记录。server 日志中应有：

```text
[always-on] always-on gate blocked {"reason":"recent_user_msg"}
```

如果仍然触发 discovery，需要检查 TUI lease / recent user message 是否已接入当前 server 进程；若当前实现尚未从 TUI 写入 Always-On lease，该用例应标记为实现缺口，而不是通过。

## 用例 5：Always-On 配置错误不影响 TUI fallback 展示

### 输入

在 `alwaysOn.projects` 中写入非绝对路径或非法字段：

```yaml
alwaysOn:
  enabled: true
  trigger:
    enabled: true
  projects:
    relative-project:
      enabled: true
      sessionKey: legacy-session
```

启动 server：

```bash
node dist/src/cli/pilotdeck.js server --port 18789
```

再启动 TUI：

```bash
node dist/src/cli/pilotdeck.js tui
```

### 预期现象

- server 启动阶段应显示配置诊断、warning 或失败信息。
- 如果 server 启动失败，TUI 不能连接远端，会回退到 `local in-process` 或提交后显示本地配置错误。
- 如果 server 继续运行，Always-On 应忽略非法项目或以诊断方式处理，不应静默伪成功。

### 预期输出

预期输出包含 `alwaysOn.projects` 相关诊断，例如：

```text
alwaysOn.projects.<root>.sessionKey is no longer accepted
```

或：

```text
alwaysOn.projects must be an object keyed by absolute project root
```

TUI 不能因为 Always-On 配置错误而显示虚假的 Always-On 成功状态。
