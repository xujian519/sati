# turnkey-cc-plugin · Internal Troubleshooting

> **面向贡献者 / maintainer**。普通用户排查看 `INSTALL.md` §7 即可。
>
> 本文收录的是和 upstream proxy、Cursor-prototype 对齐、plugin 内部约定相关的 deep-diagnostic 信息，外泄到用户文档会造成信息过载。

---

## 1. proxy.ts streaming tool-call 字段丢失

**症状**：

```text
Bash failed due to the following issue:
  The required parameter `command` is missing.
```

或类似 "tool 调用参数缺失"。

**根因**：`claude-code-main/proxy.ts` 在把 OpenAI 风格 streaming `tool_calls` 转成 Anthropic 风格事件时丢字段。**不是 plugin 本身 bug**。常见 failure mode：

| 代号 | 现象 | 修复 |
|------|------|------|
| F1 | 并行多个 `tool_call`（`index=0` + `index=1`）第二个工具的参数被并到第一个 | proxy 已用 per-tool block index 隔离 |
| F2 | 上游分两个 chunk 发 `id` 与 `function.name` | proxy 已支持累积，等齐后再开 block |
| F3 | `finish_reason` 提前到达、`arguments` 还在缓冲 | proxy 已加 emergency flush |
| F4 | 没有可观测性 | `PROXY_DEBUG=1` 启动 proxy，写 `/tmp/proxy-debug-<pid>-<ts>.jsonl` |

历史追溯：参见 `~/.turnkey/artifacts/fbbf49c3a154/`。

### 1.1 开 debug 重现

```bash
# 1. 重启 proxy 带 debug
PROXY_DEBUG=1 bun run /path/to/claude-code-main/proxy.ts
# stderr 会打印:
#   [proxy:debug] PROXY_DEBUG=1 → writing raw chunks + emitted events
#   to /tmp/proxy-debug-<pid>-<ts>.jsonl

# 2. 重现失败（在 Claude Code 里 /turnkey:start "<ticket>"）

# 3. 查 debug log
tail -f /tmp/proxy-debug-<pid>-<ts>.jsonl

# 4. 锁定出问题的 tool_call
jq 'select(.kind=="upstream_chunk") | .payload.choices[0].delta.tool_calls // empty' \
  /tmp/proxy-debug-<pid>-<ts>.jsonl
jq 'select(.kind=="emergency_tool")' \
  /tmp/proxy-debug-<pid>-<ts>.jsonl   # F3 触发记录
```

### 1.2 单测覆盖（避免回归）

```bash
cd /path/to/claude-code-main
bun test proxy-stream-converter.test.ts
# 5 cases: single-tool / multi-tool 并行 / id-name 分开到达 /
#          只有 args 没 name / finish 在 usage 之前
```

5 个 case 中任何一个失败都说明 proxy 又退化了。新增边界 case 时务必加进 `proxy-stream-converter.test.ts`。

### 1.3 Plugin 侧硬化

`skills/start/SKILL.md` 的 Phase 0 已用单一 hook（`hooks/turnkey-bootstrap.js`）取代原先 4 个独立 Bash 调用。这能减少 agent 同时发多个 `tool_use`、触发上述 proxy bug 的几率。Phase 1+ 仍可能并行调工具，但单步骤的复杂度被降到 1。

> ⚠️ 如果后续有人把 Phase 0 回退成多个独立 bash 块，请恢复 hook 调用 —— 否则上游 proxy bug 会在新 ticket 开启时高概率复现。

---

## 2. Hook event 命名与 Cursor prototype 的对齐

CC plugin 用的事件：

- `UserPromptSubmit`
- `Stop`
- `PostToolUse`

Cursor prototype 用的是原生 cursor hook（结构不同）。两者的映射表请在 prototype 侧 `hooks.json` 稳定后更新 INSTALL.md §5。

---

## 3. 已删除文件

- `merge-hooks-json.js`（Cursor 专用合并器）在 CC port 时删除 —— CC plugin 用自身 `hooks/hooks.json`，不需要合并到全局。
- 部分 `hooks/turnkey-*.js` 注释里仍残留 `~/.cursor/...` usage 示例，记入 deferred。

---

## 4. Single-writer 假设

Plugin 和 Cursor prototype 共享 `~/.turnkey/` 目录。hook 内**没有** cross-process lock（只有一个 `~/.turnkey/.inbox.lock` 目录做 inbox append 的 atomic）。同时跑 Cursor + Claude Code 两个客户端写同一 ticket 会 race。

Sandbox 用法见 `INSTALL.md` §8。

---

## 5. 有用的引用

- `~/.turnkey/artifacts/<ticket>/06-develop-log.md` — 每个 ticket 的 develop 阶段日志
- `~/.turnkey/artifacts/fbbf49c3a154/99-pause-checkpoint.md` — proxy tool-call 字段丢失 ticket 的根因分析
- `~/.turnkey/artifacts/7d796933d064/` — Cursor → Claude Code port 的 decision / deviation 记录
