# Agent Note: 项目级 hook 信任报告期（1.2a）

Status: implemented

## Problem

`.sati/plugins/<plugin>/hooks/hooks.json` 被无条件发现并装载（`PluginRuntime.refreshWithReport`
→ `loadPluginFromPath` → `loadPluginHooks`），`type: "command"` 的 hook 最终由
`HookRuntime` → `CommandHookExecutor` 走 `spawn(command, { shell: true })`。**克隆一个带该
文件的仓库即等于执行任意命令**，用户既不被询问、也看不到来源；默认还是
`skipPermissions: true`。

三个现状事实决定了做法：

- 现有的插件变更检测是 `mtimeMs + size` 指纹（`PluginRuntime.fingerprintOf`），**不能当
  信任判据**（`clone`/`checkout`/`rsync` 重写 mtime 会假变，`touch` 可伪造）。
- 拍平后的 `SatiHookMatcher` 只残留 `pluginId = "<name>@<source>"` 字符串，没有独立来源字段——
  而插件名可以含 `@`，靠解析字符串判来源不可靠。
- `parseHooksConfig` 已显式拒绝磁盘配置注册 `callback` 类型 hook，故磁盘来源只剩
  command/prompt/http/agent 四类，攻击面已收窄到「可执行的声明」。

## Decision

新增 `src/extension/plugins/trust/`（内容哈希 + 存储 + 评估 + 上报），装配期**只报告**：

- **内容摘要**：`computeHookBundleDigest` 对插件目录**整棵树**做 `sha256`（相对路径 + 内容，
  排序、`\0` 分隔）。整树而非仅声明文件的理由：`command` 可以引用目录内的脚本，
  「声明没改、被执行的脚本换了」是最省事的绕过。算不出来的三种形态一律 `blocked`
  （`manifest.hooks` 字符串解析到目录之外、含符号链接/非普通文件、超出 2000 文件 / 8 MiB 上限），
  不设静默通过路径。
- **状态**：`trusted` / `pending`（无记录）/ `stale`（同槽位摘要不同）/ `revoked` /
  `blocked`。`revoked` 先于摘要比对判定——撤销是对该插件的处置，不该因内容回到旧版本而复活。
- **存储**：`<pilotHome>/hook-trust.json`（`HookTrustStore`，版本门 + 损坏/未知版本按空表，
  fail-closed）。1.2a **只实现读路径**，写路径（授权/撤销）随 1.2b 的网关方法一起落地。
- **工作区身份键**：canonical 项目根的 `sha256` 摘要（32 hex，`computeWorkspaceIdentityKey`）。
  取摘要而非路径：存储与日志都不落本机绝对路径；走 canonical：worktree 与主仓库同身份。
- **评估面**：`source === "project"` 且**实际声明了 hook** 的插件。`global` 在用户自己的
  `~/.sati/plugins` 下、`builtin` 随发行版而来，都不在「打开仓库即执行」这一形态里。
- **来源标记**：`SatiHookMatcher.source` 由宿主在拍平时填（`loadPluginHooks`），
  **不从磁盘配置读**——否则被克隆的仓库可以用 `"source": "builtin"` 自称可信。
- **上报**：`ProjectRuntimeRegistry.prepareSessionRuntime` 在 `refresh()` 之后调用一次，
  同一工作区**内容变化时才输出**；异常一律吞掉——观测面不得让会话起不来。
  日志只含工作区摘要前缀、插件名、状态与摘要，不含路径与命令。

## Alternatives considered

- **复用 `PluginRuntime` 的指纹缓存当信任判据** — 落选：`mtime+size` 拼串不是内容哈希，
  mtime 可被重写与伪造；信任判据必须逐字节。用 `utimes` 的测试钉住了这一点（仅改 mtime
  摘要不变、改写声明摘要变化）。
- **只哈希声明文件（`plugin.json` + 声明的 hooks 文件）** — 落选：会漏掉目录内被引用的脚本，
  等于给「改脚本不改声明」留了通道。改整树哈希后必须设上限，超限按 `blocked`（可见）
  而非静默通过。
- **信任键直接用项目路径** — 落选：往存储/日志里灌本机绝对路径，且 worktree 与主仓库会各要
  一次授权。改为摘要 + canonical。
- **1.2a 一并落地授权记录写路径** — 落选：没有调用方（写入口是 1.2b 的 `hook_trust_decide`），
  先写等于无法验证的死代码；「谁能授权、授权粒度多细」本身是 1.2b 的审批设计问题。
- **报告期顺带接入 telemetry** — 落选：telemetry 契约的 `TelemetryModule` 枚举
  （router/always_on/memory/cron_job/session）没有扩展装配位；为一条报告改公共契约，不如与
  1.2b 的 `hook_trust.revoked` 专用事件一起做。本阶段只写本地日志，天然满足「路径不落库」。
- **每个会话都打一行报告** — 落选：装配每会话一次，同内容重复行会变成噪音进而没人看。
  改为按工作区内容签名去重。
- **报告期就顺带拦截（未信任不装载）** — 落选：会让现有带项目 hook 的仓库静默失效；计划明确
  拆 1.2a/1.2b，强制与审批交互必须成对落地（否则用户只看到「hook 不生效」而无处授权）。
- **在 hooks 协议里复制一份来源联合类型** — 落选：`SatiHookMatcher.source` 用
  `SatiPluginSourceKind` 的仅类型反向引用（运行时已擦除、无运行时循环），避免两个真值源漂移。

## Consequences

- 换来了：项目 hook 的风险第一次在日志里可见（工作区摘要 + 插件 + 状态 + 内容摘要），
  行为**零变化**；工作区身份、内容哈希、来源标记三块 1.2b 直接复用。
- 代价：每个新会话装配时对项目插件目录做一次全量读取哈希（仅 `project` 来源、有上限、
  同目录缓存不参与）。这是 1.2a 的刻意选择——缓存会重新引入「mtime 不变则内容不可见」的问题。
- 未做（属 1.2b）：不拦截、不审批、无 `hook_trust_*` 网关方法（协议 1.11）、无应用级 UI；
  报告按**插件**粒度，不区分 matcher/hook 槽位（1.2b 的授权记录才带 matcherIndex/hookIndex）。
- 已知不精确处：`loadPluginFromPath` 目前吞掉 `parseHooksConfig` 的 diagnostics，
  声明语法错误的插件在报告里表现为「没有 hook」而非「声明有问题」——同属 1.2b 的评审面。
- 现状记录（R1）：`PluginRuntime` 用同步 `resolvePath(projectKey)` 发现 `.sati/plugins`，
  而信任键走 canonical 根；worktree 下两者可能指向不同目录，此时结果只是「多一次评审」
  （摘要不同 → `stale`），不会产生假信任。统一到 canonical 发现路径留待 1.2b 一并处理。
