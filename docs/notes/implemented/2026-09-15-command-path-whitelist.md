# Agent Note: `/api/commands/*` 改用共享路径白名单

Status: implemented

## Problem

`ui/server/routes/commands.js` 里 `/api/commands/load` 与 `/api/commands/execute` 处理的是**同一个语义的参数**（「命令 / 技能文件路径」），却各带一套严格度差两档的校验：

- `/execute` 用目录白名单（`resolvePilotHome(env)/commands`、`/skills`，加上传了 `context.projectPath` 时的 `.sati/commands`、`.sati/skills`）；
- `/load` 只要求 `resolvedPath.startsWith(os.homedir())`，或路径里出现 `.sati/commands|skills/` 子串。

`ui/server` 是浏览器可达的 Express 服务端，所以 `/load` 的实际效果是**一个「读用户主目录任意文件」的原语**（`~/.ssh/id_rsa`、`~/.aws/credentials`……），而这条边界是**无意放宽的**——同文件另一个路由已经写明了正确策略。

顺带暴露两处同源问题：`/load` 对**自己的文档化作用域反而是坏的**（`SATI_HOME/commands` 下的命令会被拒，因为它不在真实 `$HOME` 下、路径里也没有 `.sati/`），而 `.sati/commands|skills/` 的子串正则**不锚定任何根**，任何盘符上形如该串的路径都放行。

## Decision

新增 `ui/server/utils/commandPaths.js` 作为**唯一**路径策略：

- `commandAllowedBases(context, env)` — 返回允许基目录；Sati home 两档恒在，项目两档仅在 `context.projectPath` 存在时加入。
- `isUnderBase(base, target)` — 用 `path.relative` 判定严格后代；基目录自身（`rel === ""`）拒绝，只有**真正的 `..` 段**才算穿越。
- `resolveCommandPath(commandPath, context, env)` — 解析 + 判定一步完成，放行返回绝对路径，否则返回 `null`。

两个路由都改为调用它，拒绝时共用 `COMMAND_PATH_DENIED_MESSAGE`。`/load` 相应接受可选的 `context`（**不传即更窄**，只保留 Sati home 两档），并且读文件与响应里回传的都是**解析后的路径**而非入参原值。

`isUnderBase` 顺手修掉旧实现 `rel.startsWith("..")` 的误判：名为 `..foo` 的文件此前被当成穿越拒绝，现在按 `..` + 分隔符判定。

## Alternatives considered

- **直接删掉 `/load`** — 落选：它的 UI 消费方为零（`docs/code-refinement-plan.md:573`、`:578` 已登记为「死路由 ×9」之一），删除确实能消掉整个攻击面。但下线一条 HTTP 路由属于**协议面变更**，需要单独的决策与消费方声明，而本 issue 的诉求是「两条路由同策略」而不是「下线一条」。留到 #356 的协议面专项，届时一并处理 taskmaster 那 8 条。
- **保留两份实现、只把 `/load` 的判据抄成与 `/execute` 一致** — 落选：那正是漂移的成因。两份相等只在下一次改动前成立，而这两处已经证明会分叉；且「放宽边界」从此变成两个不显眼的编辑点。
- **用 `fs.realpath` 解析符号链接后再判定** — 落选（本次不修，记录为已知缺口）：允许目录内的一个符号链接仍可指向目录外。但构造它需要**先能写 `~/.sati/commands/`**，而具备该权限的本地主体读取同用户其它文件本就不受此路由约束，因此这不是本路由引入的额外暴露面；`/execute` 此前同样如此。真要收紧需引入异步 realpath 并统一两个路由的错误语义，属于会改行为的独立变更。
- **用 `resolvedPath.startsWith(base + path.sep)` 做前缀匹配** — 落选：语义上等价于 `path.relative` 但更容易写错（分隔符、`..` 归一、大小写），且字符串前缀判断在 `base` 未归一化时静默失效。`path.relative` 由平台自己处理这些细节。
- **在 `/load` 缺 `context` 时回退到「真实 `$HOME` 下任意位置」以保持向后兼容** — 落选：那等于保留漏洞本体。缺 `context` 只意味着调用方没声明项目，没有理由因此放宽到全主目录。

## Consequences

- 「放宽命令路径边界」此后只有一处可改（`commandAllowedBases`），且改动会同时作用于两个路由与被导入的测试。
- `/load` 是**行为净变化**，不只是收紧：它现在能从 `SATI_HOME/commands`、`SATI_HOME/skills` 与项目 `.sati/*` 正常读命令，同时拒绝真实 `$HOME` 下的任意文件——旧实现恰好相反。
- 回归覆盖在两层：`ui/server/utils/commandPaths.test.js` 直测策略函数（含 `..foo` 不是穿越、基目录自身被拒、空/非字符串入参），`ui/server/routes/commands.test.js` 直测两个路由的放行与拒绝。其中针对**真实 `$HOME`** 的两条用例是本次漏洞的直接锁：回退路由实现后这 4 条会变红（已作负控制验证），包括「指向真实 `$HOME` 下不存在的路径须返回 403 而非 404」这一条——它区分的是**策略拒绝**与**读了才发现不存在**。
- `os` 的导入随判定逻辑一并从 `commands.js` 移除（该文件不再直接使用 `os.homedir()`）。
- 遗留：`/load` 仍是零消费的死路由，且符号链接绕行仍可（理由见上）。两者都不影响本次「两路由同策略」的目标，分别由 #356 与该缺口自身跟进。
