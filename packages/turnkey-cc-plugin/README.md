# turnkey-cc-plugin

**Claude Code 插件版的 turnkey 工作流** — 给"三新 junior"（new to codebase / new to stack / new to team conventions）一个跑完整张 ticket 的脚手架。

> 这是 Cursor 版 [`turnkey-prototype`](../../v2-new-project-init/new-project/_drift/turnkey-prototype/)（在含该 path 的分支上）的 Claude Code port。两者并存，行为对齐，共用 `~/.turnkey/` 状态目录。

---

## TL;DR

在 Claude Code 对话里：

```text
/plugin marketplace add Mingwwww/edgeclaw-opc
/plugin install turnkey@edgeclaw-opc
/turnkey:start "把 SearchBar 接到 /api/search 上"
```

marketplace 分发在 v0.2.0 前不可用，当前请走开发模式：

```bash
claude --plugin-dir /absolute/path/to/edgeclaw-opc/packages/turnkey-cc-plugin
/turnkey:start "..."
```

详细安装见 [`INSTALL.md`](./INSTALL.md)。

主 skill 会按 **8 阶段漏斗** 路由：

```
onboard → clarify → design → [spec] → [tdd] → develop → test → review → ship
```

每阶段有：
- **junior-answerable** 的输入（不会被 PM 7 题问倒）
- **三盲扫描**（convention / trust / context blindness）
- **senior-gate** 在 design 和 ship 之前异步审核
- **stage artifacts**（写到 `~/.turnkey/artifacts/<ticket_id>/`）
- **context budget** 自动统计（hooks/turnkey-budget.js）

---

## 为什么需要这个

- AI agent + 三新 junior 在陌生 codebase 上做 feature ticket 时，最常见 3 个塌方点：
  1. **convention blindness** — 不知道项目怎么命名、放哪、走哪个 lint
  2. **trust blindness** — 把 LLM 输出 / 文档当事实，不交叉验证
  3. **context blindness** — 半路扔进对话的"哦对了..."缺失

- turnkey 用 SKILL + hook + runlog.json 把这三种盲点变成**显式 gate**，让 junior 可以独立推进，senior 只在关键节点做异步审核。

---

## 文件结构

```
turnkey-cc-plugin/
├── .claude-plugin/
│   └── plugin.json          # CC plugin manifest
├── skills/
│   ├── start/               # 主入口 → /turnkey:start
│   ├── onboard/             # /turnkey:onboard
│   ├── clarify/             # /turnkey:clarify
│   ├── design/              # /turnkey:design
│   ├── spec/                # /turnkey:spec (可选)
│   ├── tdd/                 # /turnkey:tdd (可选)
│   ├── develop/             # /turnkey:develop
│   ├── test/                # /turnkey:test
│   ├── review/              # /turnkey:review
│   └── ship/                # /turnkey:ship
├── hooks/
│   ├── hooks.json           # CC event bindings
│   ├── turnkey-capture.js   # UserPromptSubmit + Stop
│   ├── turnkey-budget.js    # PostToolUse + Stop (token 预算)
│   └── turnkey-stage-gate.js # 阶段切换 gate
├── templates/               # runlog / spec / design-doc 模板
├── examples/                # walkthrough 示例 ticket
├── INSTALL.md               # 安装与启用
└── README.md                # 本文件
```

---

## 三个新手最容易踩的坑

1. **跳过 onboard 直接写代码** → convention blindness 立刻爆。先跑 `/turnkey:onboard`，30 分钟拿到一份"我现在站在哪"。
2. **把 LLM 给的 API 当真** → trust blindness。`develop` 阶段会强制对高风险点做二次验证。
3. **clarify 答不出 problem/impact/scope** → 用 v2 的 junior-questions 而不是 v1 的 PM 问卷。skill 自带模板。

---

## 与 Cursor prototype 的差异（一行版）

- 调用 `/turnkey:X` 而非 `/turnkey-X`
- Hook event 改成 CC 原生的 `UserPromptSubmit / Stop / PostToolUse`
- 路径全部用 `${CLAUDE_PLUGIN_ROOT}` 而非 `~/.cursor/...`
- `~/.turnkey/` 状态目录共用（可在 Cursor / CC 之间切换 ticket）

详细对照表见 `INSTALL.md` §5。

---

## 状态

**v0.1.0 — 内部预览版。** 首次从 Cursor 版 port 到 Claude Code，smoke 通过，full funnel 跑过一次（示例见 `examples/walkthrough.md`）。生产环境尚未广泛 dogfood，使用前请至少跑一次 `/plugin validate` + 最小 smoke（见 `INSTALL.md` §4）。

下一步里程碑：**v0.2.0** — 补齐仓库根 `.claude-plugin/marketplace.json`、开放 `/plugin install turnkey@edgeclaw-opc` 路径、完成 full funnel 的第二次实战 dogfood。详见 [`CHANGELOG.md`](./CHANGELOG.md)。

贡献 / 反馈：仓库 issue，或在你的 ticket 目录 `~/.turnkey/artifacts/<ticket>/inbox.md` 留言。
