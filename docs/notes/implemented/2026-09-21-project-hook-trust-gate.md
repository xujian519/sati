# Agent Note: 项目级 hook 信任强制期（1.2b）

Status: implemented

## Problem

1.2a 让项目 hook 的风险可见了，但**可见不等于防护**：`<projectRoot>/.sati/plugins/<plugin>/hooks/hooks.json`
里声明的 `command` hook 仍然照常装进 `HookRuntime` 并 `spawn(..., { shell: true })`。克隆一个带该文件的
仓库仍然等于执行任意命令。

同时有三个不能回避的配套问题：

1. **授权粒度**：参考底稿（ZCode）的记录形状是**逐 hook**（`matcherIndex` / `hookIndex`）。但 1.2a 已确立
   信任单位必须是**插件目录整棵树的内容摘要**——`command` 可以引用目录内的脚本，只认声明会让
   「声明没变、被执行的脚本换了」变成合法绕过。
2. **审批可达性**：只做 Web 界面会让纯 CLI/TUI 用户看到自己的项目 hook 静默失效却无处同意。
3. **「改了就失效」**：授权必须绑定内容，否则改一行声明就能沿用旧授权。

## Decision

- **执行面**：`retainTrustedHookMatchers(settings, evaluation)` 只放行 `source === "project"` 且评估为
  `trusted` 的 matcher；`pending` / `stale` / `revoked` / `blocked` 与**缺 `pluginId`** 的 project matcher
  一律剔除。其他来源（宿主注入的 gateway 权限回调、`global`、`builtin`）原样保留——它们不在
  「打开仓库即执行」的威胁形态里。
- **fail-closed 在装配点**：`ProjectRuntimeRegistry.resolveTrustedHookSettings` 把评估结果交给过滤；
  评估本身抛错时按「全部未评审」处理（传空评估 → 清掉全部 project matcher）并留 warn 日志。
  拿不到证据不放行，与权限门「不确定即拒绝」同向。
- **授权写路径**：`HookTrustStore.record` 原子写 `<pilotHome>/hook-trust.json`（先读整表 → 覆盖该键 →
  原子写）。授权记 `decision: "granted"` + 当时的内容摘要；**撤销写 `decision: "revoked"` 而不是删除**
  ——删掉就与「从未评审」不可分辨，保留记录才能解释「这个插件为什么一直不生效」，并让重新授权成为
  显式动作。
- **协议 1.11**：新增可选方法 `hook_trust_list` / `hook_trust_decide`（未接线的宿主返回
  `not_configured`，符合 MINOR + feature-detect 的既定纪律）。实现由宿主注入
  （`createLocalGateway` → `createHookTrustService`），与注册表**共享同一个存储实例**——两个实例会
  各自读旧表再整表写回，互相覆盖。
- **CLI 出口**：`sati hooks list | approve <pluginId> | revoke <pluginId>` 与协议方法走同一个服务。
  强制期让 hook 生效的入口因此有两个（CLI 与协议/Web），日志与列表都会打印下一条该敲的命令。
- **声明投影**：`summarizeHookDeclarations` 把声明投影成「事件 / matcher / 类型 / 原文摘要（命令、URL、
  提示词首行，截断 300 字符）」供人评审。看不见内容的「授权」不是授权；路径与命令不进遥测，但必须
  出现在本机审批界面上。

## Alternatives considered

- **逐 hook 粒度（ZCode 的 matcherIndex / hookIndex 形状）** — 落选：信任单位必须覆盖目录内被引用的
  脚本（1.2a 的整树摘要），逐 hook 摘要给出的是一个**更弱**的并行单位；两者并存还会让人误以为
  「勾中一条就等于那条安全」。UI 仍逐条展示声明（`entries[].hooks`），但决定作用在插件的内容摘要上。
- **授权绑定路径而非摘要** — 落选：路径不变而内容可换，等于永久授权任意内容；1.2a 的内容摘要正是为
  堵这个。
- **撤销 = 删除记录** — 落选：见 Decision（不可分辨 + 无法解释「为什么一直不生效」）。
- **默认不强制、给用户一个开关** — 落选：把任意命令执行面做成 opt-in 等于没有这道门。强制 + 可达的
  审批路径才是正解；1.2a 已提前一个版本把风险可见，迁移有说明。
- **把信任评估塞进 `PluginRuntime.snapshotContributions()`** — 落选：评估是异步（读盘哈希）而快照是
  同步 API，塞进去只能逼出「快照里放 Promise」的坏形状。过滤放在异步装配点。
- **加 `hook_trust_changed` 推送事件** — 落选：WS 推送需要按连接的订阅簿记（`kanban_subscribe` 形态），
  而当前消费方（Web 走 `ui/server` 的 REST、CLI 是一次性进程）都是按需拉取。为没有消费者的推送新增
  方法与订阅面是投机设计；日后需要时按 MINOR 追加，旧客户端忽略未知帧即可。
- **只提供 Web 界面审批** — 落选：见 Problem 第 2 条。协议 + CLI 先行，Web 面随后（同一 PR 栈）。
- **把授权直接写进 `sati.yaml`** — 落选：`src/` 内没有 sati.yaml 写通道，且信任是运行时事实，
  与用户配置混写会让「用户改了什么」不可辨认（同 1.2a）。

## Consequences

- 换来了：未评审的项目 hook **不再执行**；授权有 CLI 与协议两个可达入口；改内容即失效（摘要比对）；
  「谁在什么时候授权了哪一份内容」在 `hook-trust.json` 里有据可查。
- 迁移代价（有意）：现有项目若自带 `.sati/plugins/*/hooks/hooks.json`，升级后其 hook 默认不生效。
  日志会打印 `disabled=<n>` 与原因，`sati hooks list` 列出声明原文并给出授权命令。这是 1.2a 先落地
  一个版本所要换取的「有准备的破坏」。
- fail-closed 的代价：一次瞬时 IO 失败会让本回合不装载项目 hook（日志说明原因）。`global` 与
  `builtin` hook 不受影响，宿主注入的权限回调也不受影响（它没有 `source`）。
- 仍未做：Web 侧审批界面与 `ui/server` 的 REST 路由（协议与 CLI 已可用，界面属增量）；
  telemetry 的 `hook_trust.revoked` 专用事件同样留到与 Web 面一起落，避免一轮改两处公共契约。
- 报告与决定的粒度是**插件**（`pluginId = <name>@project`），不区分 matcher/hook 槽位。
