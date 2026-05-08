# PolitDeck TUI 设计审核文档

本文用于审核 PolitDeck TUI 的视觉与交互方案。目标是对齐 `third-party/claude-code-main` 的 TUI 设计形态，只替换品牌名称、logo 和深蓝主题；在用户确认前不继续改真实 TUI 实现。

## 1. 结论

当前实现状态：已按本文档 Step 1-8 落地第一版目标 TUI，并通过端到端真实模型 + 真实工具的迭代验证。

- 真实实现位于 `src/adapters/channel/tui/app/`，包含 `Header.tsx`、`WelcomeCard.tsx`、`PromptInput.tsx`、`MessageList.tsx`、`MessageResponse.tsx`、`ActivityLine.tsx`、`HelpDialog.tsx`、`theme.ts`、`PolitDeckLogo.tsx`、`types.ts`、`TuiApp.tsx`。
- 端到端验证脚本 `scripts/tui-e2e-record.tsx` 用 `ink-testing-library` + OpenRouter `moonshotai/kimi-k2.6` 真实跑一次 tool use turn，并落帧到 `artifacts/tui-e2e-frames.log`。
- 已修复迭代发现的视觉问题：Header `↗` 与版本紧贴、activity `✦ thinking` 残留、空 assistant 渲染孤立 `⎿`、tool 与 assistant 输出混在一起没有 label。
- assistant 现在显式 `PolitDeck` label，tool 仍用 `⎿`，user 用 `You`，与 Claude Code 视觉规范保持一致。

PolitDeck TUI 应该做成 **Claude Code 风格的 REPL TUI**，而不是三栏 dashboard，也不是带假示例对话的启动页。

目标原则：

- 启动页只展示品牌、版本、模型/连接/cwd 等环境信息。
- 不在空白启动页中展示假的 `You` / `PolitDeck` 示例对话。
- 不在欢迎页中展示假的 `tool read_file done`、`memory on`、`server healthy`。
- 不在欢迎页中展示 `● idle · context 0% ...` 这种运行状态长句。
- 真正的消息、工具调用、权限请求只在用户开始会话后出现在 transcript 中。
- 输入框必须是明确可输入控件，有可见 cursor、placeholder、焦点态。

## 2. Claude Code TUI 实际长什么样

### 2.1 顶层结构

Claude Code 的 TUI 是 REPL 结构，核心是：

```text
App providers
  -> Logo / welcome block
  -> transcript scroll area
  -> overlay / modal area
  -> bottom pinned area
       -> spinner / permission / status
       -> prompt input
```

对应源码：

| 能力 | Claude Code 文件 | 作用 |
| --- | --- | --- |
| 顶层 provider | `third-party/claude-code-main/src/components/App.tsx` | 包住全局 app state / stats / fps |
| 欢迎页 / logo | `src/components/LogoV2/LogoV2.tsx` | 启动时展示品牌、版本、model、cwd、notice |
| 紧凑 logo | `src/components/LogoV2/CondensedLogo.tsx` | 小窗口/常规启动展示 compact brand block |
| 主布局 | `src/components/FullscreenLayout.tsx` | scrollable transcript + bottom pinned prompt |
| 输入框 | `src/components/PromptInput/PromptInput.tsx` | prompt、slash command、history、modal 入口 |
| 底层输入 | `src/components/TextInput.tsx` + `src/components/BaseTextInput.tsx` | cursor、placeholder、paste、输入事件 |
| 回复缩进 | `src/components/MessageResponse.tsx` | assistant/tool 输出前缀 `⎿` |
| 状态栏 | `src/components/StatusLine.tsx` | 可配置 statusline，显示 model/cwd/mode/tokens 等 |
| 主题 token | `src/utils/theme.ts` | 颜色集中定义，不在组件里散落硬编码 |

### 2.2 启动页行为

Claude Code 启动页分两种：

1. **Condensed mode**
   - 用小 logo / mascot。
   - 旁边显示：
     - `Claude Code v...`
     - model / billing
     - cwd / agent name
   - 不展示示例聊天。
   - 不展示工具假状态。

2. **Full logo mode**
   - 一个有 border 的 welcome block。
   - 左侧品牌 / mascot。
   - 右侧 recent activity / release notes / onboarding feed。
   - 仍然不是假对话，而是实际 product notice / onboarding 信息。

核心点：**欢迎页是环境与入口信息，不模拟对话。**

### 2.3 Transcript 行为

Claude Code 的 transcript 只有真实事件：

- 用户真的输入后，出现 user message。
- 模型真的返回后，出现 assistant message。
- 工具真的执行后，出现 tool activity / result。
- permission 真的需要时，出现 permission modal。

因此 PolitDeck 不应在冷启动时塞：

```text
You
  Build the gateway adapter design...

PolitDeck
  ⎿ Gateway is running...
```

这会让用户误以为已经发生过一次对话。

### 2.4 输入框行为

Claude Code 输入框不是静态 `Text`，而是：

- `PromptInput` 负责复杂业务：slash command、history、modal、快捷键。
- `TextInput` 用 `useTextInput` 维护输入状态。
- `BaseTextInput` 用 `useDeclaredCursor` 和 placeholder renderer 管理 cursor。
- cursor 是可见的，placeholder 和真实输入不会混淆。

PolitDeck 第一阶段不需要完全复制所有复杂能力，但必须满足：

- 有真实输入组件。
- 有可见 cursor。
- placeholder 只在空输入时显示。
- `Enter` 提交。
- `Ctrl+C` 在 running 时 abort，不 running 时退出。

## 3. PolitDeck 目标 TUI

### 3.1 总体视觉

保持 Claude Code REPL 结构，但替换：

| 项 | Claude Code | PolitDeck |
| --- | --- | --- |
| 产品名 | Claude Code | PolitDeck |
| 视觉符号 | Clawd mascot | `P + arrow` / `PolitDeck ↗` |
| 主色 | Claude orange | 深蓝 + ivory |
| 状态模型 | Claude billing/model | PolitDeck provider/model/server |
| 后端 | Claude main loop | Gateway / AgentSession |

目标配色：

```ts
const politDeckDarkBlueTheme = {
  brand: "rgb(238,234,218)",        // ivory logo text
  brandAccent: "rgb(125,180,255)",  // arrow / focus blue
  background: "rgb(7,15,28)",       // deep navy
  panel: "rgb(10,25,47)",
  text: "rgb(230,237,247)",
  subtle: "rgb(120,145,170)",
  border: "rgb(45,75,110)",
  success: "rgb(74,222,128)",
  warning: "rgb(250,204,21)",
  error: "rgb(248,113,113)",
  permission: "rgb(96,165,250)",
};
```

### 3.2 目标启动空态

冷启动时建议长这样：

```text
╭─ PolitDeck ↗ v0.1.0 ─────────────────────────────────────────────╮
│                                                                  │
│   PolitDeck ↗                                                    │
│                                                                  │
│   Claude Sonnet 4.6                                              │
│   /Users/miwi/PolitDeck                                          │
│   server connected                                               │
│                                                                  │
╰──────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────╮
│ > ▌ Ask PolitDeck...                                             │
╰──────────────────────────────────────────────────────────────────╯
```

如果是 in-process fallback：

```text
server connected
```

替换为：

```text
local in-process
```

注意：

- 不显示 `Start here: /new /sessions ...`。
- 不显示假 user/assistant 对话。
- 不显示假 tool 状态。
- 不显示 `● idle · context 0% ...`。
- `/help` 可以由用户主动打开 modal，而不是常驻欢迎区。

### 3.3 有真实对话后的形态

用户发送消息后：

```text
╭─ PolitDeck ↗ v0.1.0 ─────────────────────────────────────────────╮
│ Claude Sonnet 4.6 · default · /Users/miwi/PolitDeck · server     │
╰──────────────────────────────────────────────────────────────────╯

You
  帮我看一下 gateway adapter 设计

PolitDeck
  ⎿ 我会先检查 gateway 和 adapters 的边界...

  ⎿ tool read_file
     docs/politdeck-adapter-refactor-development-guide.md

PolitDeck
  ⎿ 结论是...

╭──────────────────────────────────────────────────────────────────╮
│ > ▌ Ask PolitDeck...                                             │
╰──────────────────────────────────────────────────────────────────╯
```

### 3.4 状态信息放在哪里

状态信息分三类：

| 信息 | 展示位置 | 是否冷启动展示 |
| --- | --- | --- |
| model / mode / cwd / connection | 顶部 header 或 welcome block | 是 |
| running / tool activity | 真实 turn 运行期间，靠近 transcript 底部或 spinner 行 | 否 |
| context / memory / token | statusline，可配置或后续开启 | 否，第一版不常驻 |

因此冷启动不显示：

```text
● idle · context 0% · tools ready · memory on · press ? for help
```

可以在运行中短暂显示：

```text
✦ thinking...
⎿ read_file running
```

## 4. 当前 PolitDeck TUI 的问题

当前截图里的问题：

1. Header 太重，占据顶部但信息密度低。
2. 中间大面积空白。
3. Logo 只有一个孤立的 `↗`，没有形成品牌块。
4. `AI agent runtime...` 文案位置过低，像渲染错位。
5. `● idle` 常驻没有实际价值。
6. 输入框虽然现在有 cursor，但视觉仍像“底部状态条”，不像 Claude Code 的 prompt。
7. 空态缺少 Claude Code 那种 compact welcome card。

## 5. 改造步骤

### Step 1：删除空态假内容

状态：已完成。

从当前 TUI 删除以下冷启动内容：

```text
Start here: /new /sessions /mode plan /help
You
  Build the gateway adapter design...
PolitDeck
  ⎿ Gateway is running...
tool read_file done memory on server healthy
● idle · context 0% ...
```

保留：

- Logo / brand。
- version。
- model。
- cwd。
- connection。
- prompt input。

验收：

- 打开 `politdeck tui` 时，没有任何假 conversation。
- transcript 区域为空，或只有 welcome card。

### Step 2：重做 Welcome Card

状态：已完成。实现为 `src/adapters/channel/tui/app/WelcomeCard.tsx`。

新增 `WelcomeCard.tsx`，对齐 `LogoV2` / `CondensedLogo` 思路。

结构：

```text
Box borderStyle="round" borderColor="brandAccent"
  title: " PolitDeck ↗ "
  content:
    PolitDeck ↗
    model
    cwd
    connection
```

验收：

- 小终端下压缩为 3-4 行 compact card。
- 大终端下不铺满空白。
- 无三栏。

### Step 3：Header 变轻

状态：已完成。实现为 `src/adapters/channel/tui/app/Header.tsx`。

当前 header：

```text
PolitDeck ↗ v0.1.0    PolitDeck · default · cwd · local
```

目标：

```text
PolitDeck ↗ v0.1.0
Claude Sonnet 4.6 · default · /Users/... · server connected
```

或在 welcome card 存在时，header 可以更轻，只保留一行。

验收：

- header 不喧宾夺主。
- connection 信息清楚，但不是大块 border。

### Step 4：PromptInput 对齐 Claude Code

状态：已完成。`PromptInput.tsx` 使用 `ink-text-input` 接管输入、placeholder、cursor 和 submit。

当前已改用 `ink-text-input`，继续保留。

下一步视觉调整：

- prompt box 不要过高。
- border 用 subtle blue。
- focus 时 border 亮蓝。
- placeholder 使用 dim color。
- 光标使用反色 block。

目标：

```text
╭──────────────────────────────────────────────╮
│ > ▌ Ask PolitDeck...                         │
╰──────────────────────────────────────────────╯
```

验收：

- 用户一眼知道可以输入。
- 空输入时 placeholder 不像真实文本。
- 输入文字后 placeholder 消失。

### Step 5：真实消息渲染

状态：已完成基础版。`MessageList.tsx` 冷启动只显示 WelcomeCard；用户提交后才出现 `You`，模型事件到来后才出现 `PolitDeck` / `⎿`。

实现与 Claude Code `MessageResponse` 对齐：

- user message：`You` label + 正文。
- assistant message：`PolitDeck` label + `⎿` 缩进。
- tool result：同样走 `⎿`，但颜色更 subtle。
- error：红色 `Error`。

验收：

- 冷启动没有消息。
- 发送后才出现 `You`。
- 收到模型回复后才出现 `PolitDeck`。

### Step 6：Activity 不常驻

状态：已完成。`ActivityLine.tsx` 在没有 running/activity 时返回 `null`，不再显示 idle/context/tools/memory。

删除常驻 `ActivityLine` 的 idle 展示。

改成：

- 没有 activity：不显示。
- running：显示 `✦ thinking...`。
- tool running：显示 `⎿ read_file running`。
- tool done 后可转成 transcript 中一条 tool message，或短暂停留后消失。

验收：

- 空态没有 `● idle`。
- 工具状态只在真实事件发生后出现。

### Step 7：Help 改为 modal

状态：已完成基础版。`?` 或 `/help` 才显示 `HelpDialog.tsx`。

`?` 或 `/help` 打开 help modal。

冷启动不展示 `/new /sessions /mode plan /help` 引导。

目标：

```text
╭─ Commands ─────────────────────╮
│ /new       New session          │
│ /sessions  Browse sessions      │
│ /mode plan Planning mode        │
│ /clear     Clear transcript     │
│ /exit      Quit                 │
╰────────────────────────────────╯
```

验收：

- 默认不占屏幕。
- 只有用户主动打开才展示。

### Step 8：主题集中化

状态：已完成基础版。颜色集中在 `src/adapters/channel/tui/app/theme.ts`。

保留 `app/theme.ts`，但所有 TUI 组件只读 theme token。

禁止在组件里散写：

```ts
"rgb(...)"
```

验收：

- 深蓝主题替换只改一处。
- 后续可加 light / ansi fallback。

## 6. 目标文件结构

```text
src/adapters/channel/tui/
  TuiChannel.ts
  app/
    TuiApp.tsx
    WelcomeCard.tsx
    Header.tsx
    PromptInput.tsx
    MessageList.tsx
    MessageResponse.tsx
    ActivityInline.tsx
    HelpDialog.tsx
    theme.ts
    types.ts
```

与 Claude Code 对应关系：

| PolitDeck | Claude Code 参考 |
| --- | --- |
| `WelcomeCard.tsx` | `LogoV2/LogoV2.tsx` + `CondensedLogo.tsx` |
| `TuiApp.tsx` | `App.tsx` + REPL composition |
| `MessageList.tsx` | transcript rendering |
| `MessageResponse.tsx` | `MessageResponse.tsx` |
| `PromptInput.tsx` | `PromptInput.tsx` + `TextInput.tsx` |
| `HelpDialog.tsx` | slash command modal |
| `theme.ts` | `utils/theme.ts` |

## 7. 审核点

请确认以下决策：

1. 空态是否只保留 welcome card + input，不展示假对话。
2. 冷启动是否不展示 `Start here`。
3. 冷启动是否不展示 `● idle/context/tools/memory`。
4. Logo 是否用 `PolitDeck ↗` 文字版，不强行做大 ASCII。
5. 主题是否采用深蓝 + ivory + bright blue accent。
6. Header 是否显示 model/mode/cwd/connection。
7. Help 是否只通过 `?` 或 `/help` 弹出。

确认后，再按 Step 1-8 改真实 Ink 组件。
