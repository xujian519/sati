# turnkey-cc-plugin · 安装与启用

> Claude Code 插件版的 turnkey 工作流。Cursor 版仍位于 `v2-new-project-init/new-project/_drift/turnkey-prototype/`（在含该 path 的分支上），两者并存，行为对齐。

---

## 1. 推荐安装（marketplace）

Claude Code 正式的分发渠道是 **plugin marketplace**。在 Claude Code 对话里：

```text
/plugin marketplace add Mingwwww/edgeclaw-opc
/plugin install turnkey@edgeclaw-opc
```

首次会提示 trust 仓库。安装成功后：

- `/plugin marketplace list` 能看到 `edgeclaw-opc`
- `/plugin` → Discover 里能看到 `turnkey`

> ⚠️ **预览期说明**：v0.1.0 暂未在仓库根 publish `.claude-plugin/marketplace.json`，所以上面两条命令目前还不能走通。要在 v0.2.0 前使用，请走 §2 开发模式；v0.2.0 marketplace 分发补齐后这一节即可生效（见 `CHANGELOG.md`）。

---

## 2. 开发模式（`--plugin-dir`，session-only）

用于本地 dogfood / 贡献 / 调试。**不是给最终用户的安装方式**——退出 Claude Code 即失效。

```bash
claude --plugin-dir /absolute/path/to/edgeclaw-opc/packages/turnkey-cc-plugin
```

Claude Code 启动时从该路径加载 plugin manifest（`.claude-plugin/plugin.json`）、`skills/`、`hooks/hooks.json`。

加载成功后会出现以下可调用项：

| 调用 | 触发的 SKILL.md |
|------|----------------|
| `/turnkey:start` | `skills/start/SKILL.md` ← 主入口 |
| `/turnkey:onboard` | `skills/onboard/SKILL.md` |
| `/turnkey:clarify` | `skills/clarify/SKILL.md` |
| `/turnkey:design` | `skills/design/SKILL.md` |
| `/turnkey:spec` | `skills/spec/SKILL.md`（可选） |
| `/turnkey:tdd` | `skills/tdd/SKILL.md`（可选） |
| `/turnkey:develop` | `skills/develop/SKILL.md` |
| `/turnkey:test` | `skills/test/SKILL.md` |
| `/turnkey:review` | `skills/review/SKILL.md` |
| `/turnkey:ship` | `skills/ship/SKILL.md` |

> 一般你只需调 `/turnkey:start "<ticket 描述>"`，主 skill 会按阶段路由到子 skill。

### 2.1 从源码 dogfood `claude-code-main`（贡献者用）

如果你不是用安装好的 `claude` 二进制，而是直接跑本仓库的 `claude-code-main`（典型场景：同一个 PR 里既改 plugin 又改 host），可以把 `--plugin-dir` 透传给 dev script：

```bash
cd claude-code-main

# bun（推荐，dev script 本身就是 bun --watch）
bun run dev --plugin-dir /Users/da/ws/edgeclaw-test-0422/packages/turnkey-cc-plugin

# npm（必须用 -- 把后续参数转发给 script）
npm run dev -- --plugin-dir /Users/da/ws/edgeclaw-test-0422/packages/turnkey-cc-plugin
```

`--plugin-dir` 可重复，多个 plugin 叠加：

```bash
bun run dev \
  --plugin-dir /abs/path/to/edgeclaw-opc/packages/turnkey-cc-plugin \
  --plugin-dir /abs/path/to/another-plugin
```

排错时配 `--debug` 看 plugin 加载日志：

```bash
bun run dev --debug --plugin-dir /abs/path/to/edgeclaw-opc/packages/turnkey-cc-plugin
```

⚠️ **路径必须是当前机器能 `ls` 到的绝对路径**，否则 plugin 静默不加载，错误只出现在对话里的 `/plugin` Errors tab（见 §7）。

---

## 3. 团队共享（project settings）

在项目 `.claude/settings.json` 注册 marketplace，让协作者 trust 仓库后自动提示安装：

```json
{
  "extraKnownMarketplaces": {
    "edgeclaw-opc": {
      "source": {
        "source": "github",
        "repo": "Mingwwww/edgeclaw-opc"
      }
    }
  }
}
```

个人全局（user scope）则改 `~/.claude/settings.json`（macOS / Linux）。

> ⚠️ 早期文档可能提到 `~/.config/claude-code/settings.json` 和 `"plugins": {"directories": [...]}` 之类的 key——**现版本 Claude Code 都已不支持**，请以官方 `extraKnownMarketplaces` schema 为准。

---

## 4. 验证安装（smoke）

```bash
# 1) 启动（开发模式示例）
claude --plugin-dir /absolute/path/to/edgeclaw-opc/packages/turnkey-cc-plugin
```

然后在对话里：

```text
# 2) 结构性校验 — 官方 plugin 校验器
/plugin validate

# 3) 最小调用
/turnkey:onboard
```

预期：

- `/plugin validate` 返回 0 error（检查 `plugin.json` / `SKILL.md` frontmatter / `hooks/hooks.json` 的 schema）
- Claude Code 识别 `/turnkey:onboard` 并触发 `skills/onboard/SKILL.md`
- 任何 prompt 提交后，`hooks/turnkey-capture.js`（绑 `UserPromptSubmit`）写一行到 `~/.turnkey/runlog.json`（如果文件已存在）或 non-blocking 失败（hook 失败**必须**不阻塞对话，见 §8 Obs-A）

---

## 5. 与 Cursor 版（turnkey-prototype）的关系

| 项 | Cursor 版（prototype） | Claude Code 版（这个 plugin） |
|----|------------------------|------------------------------|
| 安装路径 | symlink → `~/.cursor/skills/` | `/plugin install` 或 `--plugin-dir` |
| Skill 调用 | `/turnkey-onboard`（prefix 风格） | `/turnkey:onboard`（plugin namespace） |
| Hook 事件 | cursor 原生 hook（见 prototype README） | `UserPromptSubmit` / `Stop` / `PostToolUse` |
| Hook 路径 | `~/.cursor/hooks/turnkey-*.js` | `${CLAUDE_PLUGIN_ROOT}/hooks/turnkey-*.js` |
| 状态文件 | `~/.turnkey/runlog.json` | **同上**（共用，刻意为之） |
| Artifacts | `~/.turnkey/artifacts/<ticket>/` | **同上** |

> 共用 `~/.turnkey/` 目录是设计选择——让你能在 Cursor 跑了一半切到 Claude Code 继续。代价：同一时间只能一个客户端在写。如果同时跑会有 race，先用人肉排队。

---

## 6. 卸载

```bash
# 方式 A: 从 Claude Code 里 /plugin uninstall turnkey
# 方式 B: 停止 --plugin-dir 加载（session 模式退出即可）
# 方式 C: 从 .claude/settings.json / ~/.claude/settings.json 移除 marketplace
# 数据保留: ~/.turnkey/ 目录不动（你的工作记录还在）
```

如要彻底清理状态：

```bash
rm -rf ~/.turnkey
```

> ⚠️ 这会清空所有 ticket 的 runlog 和 artifacts。一般不建议。

---

## 7. Troubleshooting

### 先看 `/plugin` Errors tab

Plugin 加载任何问题（manifest 错、hook 脚本报错、skill frontmatter 错），Claude Code 都会汇总在 `/plugin` 的 Errors tab。**排查永远先看这里**，再去看 hook log。

### `${CLAUDE_PLUGIN_ROOT}` 未展开 / "command not found: node ${CLAUDE_PLUGIN_ROOT}/hooks/..."

`${CLAUDE_PLUGIN_ROOT}` 是 Claude Code 在 plugin 上下文里注入的环境变量，值为 plugin 安装目录的绝对路径。**只在 Claude Code 实际加载这个 plugin 时**才被设置。

如果你看到字面 `${CLAUDE_PLUGIN_ROOT}` 出现在错误消息里，通常是以下三种情况之一：

| 场景 | 现象 | 处理 |
|------|------|------|
| Plugin 没被 Claude Code 加载 | 在普通 shell / 普通 cursor 跑 hook | 启动 `claude --plugin-dir ...` 或走 §1 marketplace 装 |
| Hook 在 SKILL.md 之外被外部脚本调用 | env 没注入 | 手动 `export CLAUDE_PLUGIN_ROOT=/abs/path/to/edgeclaw-opc/packages/turnkey-cc-plugin` 再跑 |
| Static dogfood / 离线测试 | 模拟 plugin 行为不走 CC | 把 `${CLAUDE_PLUGIN_ROOT}` 替换为绝对路径 |

**1 行自检**：

```bash
node -e 'console.log(process.env.CLAUDE_PLUGIN_ROOT || "NOT SET")'
```

→ 输出 `NOT SET` 说明你不在 plugin 加载上下文里（这本身可能是预期的，如外部 dogfood）。

### Hook 触发了但 `~/.turnkey/inbox.jsonl` 没新行

- 检查 `~/.turnkey/logs/turnkey-capture.log` 和 `turnkey-budget.log` 看 hook 是否报错
- 检查 hook 是否拿到 stdin：CC 不同版本的 hook payload 形状可能不同，如果 stdin 空 `tryParse` 返回 null 但仍会写一条 record（只是 payload 为 null）
- 检查写权限：`ls -la ~/.turnkey/`
- 检查 lock dir 是否卡住：`rm -rf ~/.turnkey/.inbox.lock` 强解

### Stage-gate 时区告警看着不对（刚开始 1 分钟却报 145min）

`runlog.json` 里 `funnel.<stage>.started` 应是 ISO 8601 with offset（`Z` 或 `+08:00`）。如果是 timezone-naive（无 offset），`Date.parse` 会按本机 timezone 解析，可能算错。最新的 stage-gate advisory 会附原始 ts 在告警 msg 里（`started 2026-04-21T00:00:00Z`），一眼可判断是不是时区问题。

### Tool 调用报 "required parameter ... is missing"

这通常不是 plugin 本身 bug，而是上游 API 代理层在转换 streaming `tool_calls` 时丢字段。详见 `TROUBLESHOOTING-internal.md`（仓库贡献者用）。

---

## 8. Sandboxed runs（隔离的状态目录）

所有 hook 都尊重 `TURNKEY_HOME` 环境变量，默认值 `~/.turnkey`。这个 seam 让你能把 plugin 跑在隔离状态下，不污染主 ticket：

```bash
# 临时跑一个 dogfood / 测试 ticket，完全不影响 ~/.turnkey/runlog.json
export TURNKEY_HOME=/tmp/turnkey-sandbox-$$
mkdir -p $TURNKEY_HOME/artifacts

# 在这个 shell 里跑的所有 turnkey hook（无论是 CC 触发还是手动 node 调）
# 都读写 $TURNKEY_HOME 下的 runlog.json + inbox.jsonl
node ${CLAUDE_PLUGIN_ROOT:-/abs/path/to/edgeclaw-opc/packages/turnkey-cc-plugin}/hooks/turnkey-stage-gate.js --stage onboard
```

典型用途：

- **CI / 自动化测试 plugin** — 不污染开发者本地状态
- **dogfood / spike** — 试一个 throwaway ticket，完事 `rm -rf $TURNKEY_HOME` 即可
- **多 ticket 并行** — 每个 `claude` session 设不同 `TURNKEY_HOME`，绕过 single-writer 假设
- **subagent 跑 plugin** — subagent 用独立 `TURNKEY_HOME` 跑全 funnel，不动主对话的 runlog

⚠️ Plugin 自身不在 hook 里写 `TURNKEY_HOME`，只是**读**。如果要在 SKILL.md 里推 sandbox 模式，需在 prompt 里告诉 agent 设这个 env。

### Obs-A：hook 必须 non-blocking

所有 turnkey hook 脚本失败时必须以 exit 0 退出（或抛错但不写阻塞 response），因为 CC hook 阻塞会中断用户对话。所有 hook 的实现都围绕这条约束写，review 时需复核。

---

## 9. 已知限制（v0.1.0）

- **v0.1.0 是内部预览版**，生产环境尚未 dogfood。使用前请至少跑一次 §4 smoke。
- **Marketplace 分发未 publish**：仓库根缺 `.claude-plugin/marketplace.json`，v0.2.0 会补（见 `CHANGELOG.md`）。
- **SKILL.md 散文仍混用 "turnkey-X" 命名**：关键调用（路由表、invocation 示例）已统一成 `/turnkey:X`，部分章节标题和正文仍沿用 prototype 的 `turnkey-X` 写法，不影响运行。
- **与 Cursor prototype hook event 名称对照**（§5 表格）待 prototype 侧 hooks.json 结构校对后更新。

更细的贡献者注意事项见 `TROUBLESHOOTING-internal.md`。
