# Agent Note: 工具级 alwaysAsk 硬门（自动放行抹不掉的确认）

Status: implemented

## Problem

`sati` 开箱即 `skipPermissions: true`（`src/permission/settings.ts:20`），即默认处于
`bypassPermissions` 模式。该模式有三个抹平点会把「工具想确认」改写成「直接放行」：
工具级 ask 被模式覆盖（`PermissionRuntime` 判定链的 bypass 分支）、plan 模式对只读
工具直通、以及用户/session allow 规则在 `tool.checkPermissions` 之前短路返回。

于是一批「工作单元大到不该无人值守」的动作——生成面向客户的交付物、对外发信、
消耗大量额度的批量调用——在默认配置下没有任何一次人类确认。工具作者无法表达
「这个动作无论什么模式都要问一次」。

另一个方向的缺口同样真实：`PermissionRequest` 生命周期 hook 可以把一次 ask 改写成
allow。声明式 hook（`command` 尤其）可由**被克隆的仓库自带**（项目级 `.sati/plugins`
hooks 无条件加载），因此「靠 hook 放行」在没有来源区分时等于没有这道门。

## Decision

`SatiToolDefinition` 新增可选字段 `alwaysAsk?: true`，语义是「该工具的每次调用都必须
由用户当面确认」，实现为 `PermissionRuntime.decide` 外的一层包装：

- 判定链本身**一行未改**：先按既有顺序算出结论，再由 `raiseAlwaysAsk` 对结论做单向
  抬升。`allow` → 提问；`ask` → 保留但补 `metadata.alwaysAsk` 并摘掉 `allow_session`
  选项；`deny` / `cancel` **原样返回**。因此 guard、deny 规则（含宪法 `action: block`
  的 policy 规则）、plan 模式对非只读工具的拒绝、工具级 deny 全部照旧生效——该标记只
  扩大「可以问什么」，不扩大「可以做什么」。
- 抬升前**必须先求一次** `tool.checkPermissions`：上面那些 allow 路径都在它之前就返回
  了，不求的话工具级硬拒（bash 的 `HARD_DENY_PATTERNS`）会从「永不允许」退化成
  「可批准一次」，是安全性倒退。
- 无法提问的会话（`canPrompt === false`：cron、team 成员唤醒、always-on）一律硬拒绝。
  fail-closed 是刻意的：无法获得确认的动作就不该发生，且拒绝是显式的结构化错误。

hook 侧引入**来源位**：`SatiHookEffect.permission_request_result.interactive`，由
`HookRuntime` 按 `hook.type === "callback"` 填写。只有宿主能注册 callback
（`parseHooksConfig` 拒绝磁盘声明 callback），因此这是唯一能代表「用户本人作答」的
hook 种类；声明式 hook 的 allow 不再能批准 alwaysAsk 工具。网关权限提示本身是 callback
hook，用户点击仍然有效——否则该标记会把工具变成不可用，而非「每次都要问」。

首个（也是唯一）被标记的工具是 `render_patent_document`：它是专利管线面向客户的终局
交付物渲染。

## Alternatives considered

- **把 alwaysAsk 分支插进判定链中间（deny 规则之后、ask 规则之前）** — 落选：需要同时
  在三个 bypass 抹平点加短路，且 deny 规则的「session allow 压 user deny」子分支仍会
  绕过它。包装式实现把同一性质用一处逻辑表达完整，改动面更小且不可能遗漏某个后续新增
  的 allow 路径。
- **直接忽略 alwaysAsk 工具的一切 hook allow** — 落选：会连用户自己的点击一起丢掉。
  网关权限提示走的就是 `permission_request_result.allow`，忽略它等于让被标记的工具在
  所有会话里都不可用（模型会看到 `permission_required` 并反复重试）。必须区分「谁在
  作答」，而不是「有没有人回答」。
- **在 effect 上不做来源位，改为解析 `pluginId` / matcher 声明来源** — 落选：effect 不带
  hook 身份，拍平后只剩 `pluginId` 字符串；且 callback 的注册方无从从声明推断。按
  「哪种执行器产生的」判定是当下唯一可靠的轴。
- **给 `ask_user_question` 也标记** — 落选：会在「批准提问」与「提问」之间形成循环
  （先要批准才有资格提问）。
- **用 `DoomLoop` 依赖槽位或新的全局计数器做协调** — 无关但相邻的诱惑；`DoomLoop` 槽位
  在 `src/` 内无人赋值，不可用作计数来源。
- **把字段做成 `alwaysAsk?: boolean` 而非字面量 `true`** — 落选：`false` 与省略语义重复，
  但多出一个「显式关闭」的假选项，会让读者以为存在继承/覆盖链。

## Consequences

- 默认体验在**被标记的工具**上从「全自动」变为「每次弹窗/等待批准」；`skipPermissions`
  仍默认开，只是压不住该标记。
- 被标记的工具在自主链路（cron / team / always-on）中直接不可用，报错文案显式说明原因。
  标记任何新工具前都要先确认它不被自主链路调用——这是一项按工具逐一的审查义务，不是
  一劳永逸的开关。
- 「本会话允许」入口对被标记的工具消失：`alwaysAsk` 的请求选项会摘掉 `allow_session`，
  网关权限 hook 也不再落会话级 allow 规则（否则界面会显示一条永不生效的授权）。
- 声明式 hook（含项目自带 hooks.json）从此不能自动放行被标记的工具。这**不等于**项目
  hook 的自动放行已被治理：未被标记的工具仍可被它放行——那是「项目级 hook 信任门」，是
  另一件独立的事。
- 多个 hook 同时给出结论时仍取第一条（既有语义，网关 callback 挂在磁盘声明之后）。因此
  若某条声明式 hook 对被标记的工具返回 allow，它会顶掉用户自己的点击，结果是这次调用
  以 `permission_required` 结束——偏保守的失败，不是绕过。
- `PermissionRequest` 相关区域（`createGatewayPermissionHook` / `GatewayPermissionBus`）
  此前无任何测试，本次一并补上来源位与「不落会话级授权」的用例。
