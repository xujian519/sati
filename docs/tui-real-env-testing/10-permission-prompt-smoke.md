# TUI 权限弹窗冒烟测试

验证 TUI 权限交互的完整链路：弹窗渲染、按键响应、规则持久化、`/permissions` 命令。

## 权限触发机制速查表

在 **default 模式**下，以下工具会触发 `permission_request`（即弹窗）：

| 工具 | 触发条件 | payload 关键字段 | 示例 prompt |
|------|----------|------------------|-------------|
| `bash` | 命令不匹配 `SAFE_READ_PATTERNS`（见下） | `{ command: "..." }` | "帮我在当前目录运行 npm install" |
| `write_file` | 任何写入（`isReadOnly: false`） | `{ filePath, content }` | "在当前目录创建一个 hello.txt" |
| `edit_file` | 任何编辑（`isReadOnly: false`） | `{ filePath, oldString, newString }` | "把 README 第一行改成 Hello" |
| `web_search` | 始终（`checkPermissions` 硬编码 `ask`） | `{ query }` | "搜索一下 Node.js 22 的新特性" |
| `web_fetch` | 始终（`checkPermissions` 硬编码 `ask`） | `{ url }` | "打开 https://example.com 看看内容" |
| `agent` | 始终（`checkPermissions` 硬编码 `ask`） | `{ task, ... }` | "用子 agent 帮我分析这段代码" |
| `task_create` | 任何创建（`isReadOnly: false`） | `{ command }` | "后台运行 npm test" |
| `task_stop` | 任何停止（`isReadOnly: false`） | `{ taskId }` | "停止那个后台任务" |

### bash 免弹窗的安全命令（`SAFE_READ_PATTERNS`）

以下 bash 命令被认为是只读的，**不会触发**权限弹窗：

```
pwd, ls, git status, git diff, git log,
printf, echo, node -e, sh -c 'exit N'
```

### bash 直接 deny 的危险命令（`DENY_PATTERNS`）

以下命令会被**直接拒绝**（deny，不弹窗）：

```
rm -rf /, sudo, chmod -R 777, chown -R,
git reset --hard, git clean -f, dd if=,
curl/wget | sh/bash
```

### 不触发弹窗的只读工具

```
read_file, grep, glob, read_skill, plan_mode,
ask_user_question, structured_output, task_list, task_output,
mcp_* (passthrough)
```

## 前置条件

- 有效的模型配置（至少一个 provider 可用）。
- `~/.pilotdeck/permissions.json` 存在且 `skipPermissions: false`。
- 终端支持 Ink 交互（标准 TTY，不是管道）。

### 重置到初始状态

```bash
# 备份当前配置
cp ~/.pilotdeck/permissions.json ~/.pilotdeck/permissions.json.bak

# 重置为空白（确保所有弹窗正常触发）
echo '{"version":1,"allowedTools":[],"disallowedTools":[],"skipPermissions":false}' \
  > ~/.pilotdeck/permissions.json

# 启动 TUI
npx pilotdeck tui
```

---

## 用例 1：bash 写命令 — 弹窗出现，按 y 允许一次

### 输入

```text
请在当前目录创建一个叫 /tmp/pilotdeck-smoke-test 的空文件，用 touch 命令
```

### 预期

1. TUI 底部出现黄色 `PermissionPrompt` 框：
   ```
   ⚠ Permission required: bash
     Command: touch /tmp/pilotdeck-smoke-test
     [y] Allow  [a] Allow & remember  [n] Deny  [Esc] Abort turn
   ```
2. 按 **y**。
3. 工具执行成功，Agent 回复确认。
4. 检查 `~/.pilotdeck/permissions.json`：`allowedTools` **没有**新增条目（一次性允许不持久化）。

### 验证命令

```bash
ls -la /tmp/pilotdeck-smoke-test
cat ~/.pilotdeck/permissions.json | python3 -m json.tool
```

---

## 用例 2：bash 写命令 — 按 a 允许并记住

### 输入

```text
请删除刚才的文件 /tmp/pilotdeck-smoke-test
```

### 预期

1. 弹窗出现，显示 `rm /tmp/pilotdeck-smoke-test`。
2. 按 **a**。
3. 工具执行成功。
4. 检查 `~/.pilotdeck/permissions.json`：`allowedTools` 中新增 `"bash:rm:*"`。

### 验证命令

```bash
cat ~/.pilotdeck/permissions.json | python3 -m json.tool
# 预期包含: "bash:rm:*"
```

---

## 用例 3：记住的规则在下一次生效（不再弹窗）

### 输入

```text
删除 /tmp/pilotdeck-smoke-test-2（先创建它再删除）
```

### 预期

1. `touch` 命令 → 弹窗（因为 `bash:touch:*` 尚未 allow）。按 **y**。
2. `rm` 命令 → **不弹窗**（因为上一步已记住 `bash:rm:*`）。
3. 两步都执行成功。

---

## 用例 4：按 n 拒绝

### 输入

```text
运行 npm install
```

### 预期

1. 弹窗出现，显示 `npm install`。
2. 按 **n**。
3. Agent 收到拒绝通知，回复说权限被拒绝并提供替代方案（或询问用户）。
4. 不执行 `npm install`。

---

## 用例 5：按 Esc 中止当前 turn

### 输入

```text
运行 npm test
```

### 预期

1. 弹窗出现。
2. 按 **Esc**。
3. 整个 turn 被中止（不是单个工具被拒绝，而是会话回到空闲输入状态）。
4. `pendingPermission` 被清空，输入框重新可用。

---

## 用例 6：web_search / web_fetch 弹窗

### 输入

```text
搜索一下 "Rust async trait" 的最新进展
```

### 预期

1. 弹窗出现：`⚠ Permission required: web_search`。
2. 按 **y** 或 **a**，搜索执行并返回结果。

---

## 用例 7：write_file / edit_file 弹窗

### 输入

```text
在 /tmp 下创建 pilotdeck-test.txt，内容写 "hello world"
```

### 预期

1. 弹窗出现：`⚠ Permission required: write_file`。
2. 按 **y**，文件被创建。

---

## 用例 8：`/mode bypassPermissions` — 跳过所有弹窗

### 输入

```text
/mode bypassPermissions
```

然后：

```text
运行 echo "bypass test" && touch /tmp/bypass-test
```

### 预期

1. `/mode` 命令输出 `Mode: bypassPermissions`。
2. bash 命令**不弹窗**，直接执行。
3. 检查 `~/.pilotdeck/permissions.json`：`skipPermissions` 为 `true`。

### 恢复

```text
/mode default
```

确认 `skipPermissions` 恢复为 `false`。

---

## 用例 9：`/permissions` 命令管理规则

### 输入序列

```text
/permissions
```

### 预期

列出当前 allowedTools 和 disallowedTools。

```text
/permissions allow web_search
```

### 预期

`permissions.json` 中 `allowedTools` 新增 `"web_search"`。

```text
/permissions deny bash:curl:*
```

### 预期

`permissions.json` 中 `disallowedTools` 新增 `"bash:curl:*"`。

```text
/permissions clear
```

### 预期

`allowedTools` 和 `disallowedTools` 都被清空。

---

## 用例 11：bash 安全命令不弹窗

### 输入

```text
请执行 ls -la 并告诉我当前目录有什么
```

### 预期

1. **不弹窗**，`ls` 属于安全只读命令，直接执行。
2. Agent 回复目录列表。

更多免弹窗命令可测试：`pwd`、`git status`、`git diff`、`git log`。

---

## 用例 12：bash 危险命令直接 deny

### 输入

```text
执行 sudo rm -rf /
```

### 预期

1. **不弹窗**，直接被 deny（匹配 `DENY_PATTERNS`）。
2. Agent 回复 "Dangerous shell command denied." 或类似拒绝信息。

---

## 用例 13：Web UI 与 TUI 共享权限

### 准备

在 Web UI 中允许 `web_search` 工具。

### 验证

1. 检查 `~/.pilotdeck/permissions.json` 中 `allowedTools` 包含 `web_search`。
2. 启动 TUI，输入一条触发 `web_search` 的消息。
3. **不弹窗**（因为 Web UI 已允许，TUI 每次 turn 重读 `permissions.json`）。

反向同样成立：TUI 中 `/permissions allow bash:npm:*` 后，Web UI 也应生效。

---

## 测试后清理

```bash
# 恢复原始配置
cp ~/.pilotdeck/permissions.json.bak ~/.pilotdeck/permissions.json
rm -f /tmp/pilotdeck-smoke-test /tmp/pilotdeck-smoke-test-2 /tmp/pilotdeck-test.txt /tmp/bypass-test
```

## 通过标准

| # | 用例 | 关键验证点 |
|---|------|-----------|
| 1 | y 允许一次 | 弹窗出现 + 执行成功 + 不持久化 |
| 2 | a 允许并记住 | 弹窗出现 + 执行成功 + `permissions.json` 新增条目 |
| 3 | 记住规则生效 | 第二次同类命令不弹窗 |
| 4 | n 拒绝 | 弹窗出现 + 工具不执行 + Agent 回退 |
| 5 | Esc 中止 turn | turn 中止 + 输入框恢复 |
| 6 | web_search 弹窗 | 非 bash 工具也弹窗 |
| 7 | write_file 弹窗 | 文件系统写操作弹窗 |
| 8 | bypassPermissions | 跳过所有弹窗 + `skipPermissions` 持久化 |
| 9 | /permissions 命令 | allow/deny/clear 正确读写 |
| 11 | 安全命令免弹窗 | ls/pwd/git status 直接通过 |
| 12 | 危险命令直接 deny | sudo/rm -rf 直接拒绝 |
| 13 | Web UI 共享 | 一端 allow，另一端免弹窗 |
