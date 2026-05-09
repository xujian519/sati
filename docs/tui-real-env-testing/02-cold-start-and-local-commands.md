# 冷启动与本地 TUI 命令测试

本文验证 `politdeck tui` 的基础交互，不要求模型返回成功。重点是 TUI 空态、输入框、帮助弹窗和本地命令行为。

## 用例 1：冷启动空态

### 输入

```bash
npm run build
node dist/src/cli/politdeck.js tui
```

### 预期现象

- 顶部显示 `PolitDeck ↗` 和 `v0.1.0`。
- 第二行显示 `model · default · <cwd> · local in-process`，其中 model 当前 CLI 传入为 `PolitDeck`。
- 中间显示 welcome card，内容包含 `PolitDeck ↗`、model、cwd 和 `local in-process`。
- 底部显示圆角输入框，左侧为 `> `，placeholder 为 `Ask PolitDeck... (/help)`。
- 冷启动时不显示假的 `You`、`PolitDeck` 对话。
- 冷启动时不显示假的 `tool read_file done`、`memory on`、`server healthy`。
- 没有输入和运行中的 turn 时，不显示 `thinking` 或常驻 idle 状态。

### 预期输出

TUI 保持交互式运行，命令不应自动退出。按 `Ctrl+C` 后退出，退出码为 `0`。

## 用例 2：帮助弹窗

### 输入

在空输入状态按：

```text
?
```

或输入：

```text
/help
```

然后按 `Enter`。

### 预期现象

- 出现圆角 help 面板，标题为 `PolitDeck commands`。
- 面板包含 `/new`、`/sessions`、`/mode plan`、`/mode default`、`/clear`、`/help`、`/exit`。
- help 打开时输入框失焦。
- 按 `Esc` 后 help 面板关闭，输入框重新获得焦点。

### 预期输出

不会创建新的 transcript 消息，不会触发模型请求，不会出现 `thinking`。

## 用例 3：切换模式

### 输入

```text
/mode plan
```

按 `Enter`。

### 预期现象

- Header 中 mode 从 `default` 变为 `plan`。
- Transcript 中出现系统消息：

```text
Mode: plan
```

继续输入：

```text
/mode default
```

按 `Enter`。

### 预期输出

- Header 中 mode 回到 `default`。
- Transcript 新增系统消息：

```text
Mode: default
```

## 用例 4：新建会话与列出会话

### 输入

```text
/new
```

按 `Enter`，随后输入：

```text
/sessions
```

按 `Enter`。

### 预期现象

- `/new` 后 transcript 显示 `New session: <sessionKey>`。
- session key 形如 `tui:project=<cwd>:...`。
- `/sessions` 会刷新 recent sessions；如果已有会话，输入框上方会显示 `sessions: ...` hint。

### 预期输出

命令只调用 Gateway 会话管理方法，不触发模型请求，不出现 `thinking`。

## 用例 5：清屏与退出

### 输入

先产生任意系统消息，例如：

```text
/mode plan
```

再输入：

```text
/clear
```

最后输入：

```text
/exit
```

### 预期现象

- `/clear` 后 transcript 清空，重新显示 welcome card。
- `/exit` 后 TUI 退出。

### 预期输出

`/exit` 对应进程退出码为 `0`。整个过程中不会访问模型 provider。
