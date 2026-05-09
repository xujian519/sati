# TUI 远端 Server 连接与会话测试

本文验证 TUI 在已有 PolitDeck server 运行时能够连接远端 Gateway，而不是只走本地 in-process gateway。

## 用例 1：启动 server 后连接 TUI

### 输入

终端 A：

```bash
npm run build
node dist/src/cli/politdeck.js server --port 18789
```

终端 B：

```bash
node dist/src/cli/politdeck.js tui
```

### 预期现象

终端 A 输出：

```text
PolitDeck server listening: http://...
WebSocket: ws://...
```

终端 B 的 TUI header 或 welcome card 中显示连接状态为：

```text
server connected
```

如果 probe 能拿到具体 URL，也可能显示：

```text
server <url>
```

不应显示：

```text
local in-process
```

### 预期输出

两个进程都保持运行。终端 B 按 `Ctrl+C` 退出 TUI 时，不应终止终端 A 的 server。

## 用例 2：远端 TUI 真实模型 turn

### 输入

保持终端 A 的 server 运行。在终端 B 的 TUI 输入：

```text
请回答：1 + 1 等于几？只输出数字。
```

按 `Enter`。

### 预期现象

- TUI transcript 出现 `You` 和用户输入。
- TUI 显示 `thinking`。
- server 端不应崩溃。
- 完成后 TUI 出现 `PolitDeck` 回复。

### 预期输出

最终 assistant 回复应包含：

```text
2
```

允许模型附带少量说明，但该用例通过标准是答案中明确包含 `2`，并且 turn 完成后 `thinking` 消失。

## 用例 3：远端新建会话后列出会话

### 输入

在连接 server 的 TUI 中输入：

```text
/new
```

按 `Enter`，随后输入：

```text
/sessions
```

按 `Enter`。

### 预期现象

- TUI 显示 `New session: <sessionKey>`。
- `/sessions` 后会话列表从 server 的 Gateway session storage 读取。
- 输入框上方的 session hint 中能看到最近会话。

### 预期输出

不触发模型请求，不出现 `thinking`。server 继续运行。

## 用例 4：server 停止后的回退行为

### 输入

先启动 server 和 TUI，确认 TUI 显示 `server connected`。然后停止终端 A 的 server，再重新打开一个新的 TUI：

```bash
node dist/src/cli/politdeck.js tui
```

### 预期现象

- 新 TUI 不能连接远端 server。
- 如果本地配置有效，则回退到 `local in-process`。
- 如果本地配置无效，则提交消息时显示本地 gateway 不可用或配置错误。

### 预期输出

不应出现半连接状态。连接状态必须明确为 `local in-process` 或错误消息。

## 用例 5：远端退出隔离

### 输入

连接 server 的 TUI 中输入：

```text
/exit
```

### 预期现象

- TUI 进程退出。
- server 仍继续监听。
- 再次执行 `node dist/src/cli/politdeck.js tui` 可以重新连接同一个 server。

### 预期输出

TUI 退出码为 `0`。终端 A 不出现异常堆栈。
