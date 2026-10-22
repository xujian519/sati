# Agent Note: 可选频道在 ESM 下的惰性 SDK 加载

Status: implemented

## Problem

包声明了 `"type": "module"`，但 Discord、Matrix、DingTalk、Slack、Email、SMS、Telegram 七个可选
频道与 `resolveWebSocketImpl` 仍直接调用 CommonJS 的 `require`。在 ESM 下该全局不存在，`try/catch`
把 `ReferenceError` 吞成「SDK 未安装」：即使用户按需装了 `discord.js` 等依赖，频道也只会打印
`not installed` 并返回空 handle。`resolveWebSocketImpl` 症状更隐蔽——`require("ws")` 抛错后回退到
Node >= 22 的全局 WebSocket，连接仍能建立，但丢掉了 `ws` 的 EventEmitter 形态与相关能力。

## Decision

在 8 个惰性加载点各加一行模块级 `const require = createRequire(import.meta.url);`，并补
`node:module` 导入。`createRequire` 保持按需加载语义：SDK 未安装时仍是可捕获的模块解析错误，
不会把可选依赖变成启动期硬依赖。

回归判据分两层：`tests/adapters/channel-esm-require.spec.ts` 静态锁定 8 个文件都先声明
`createRequire` 再调用 `require(`；运行期断言 `resolveWebSocketImpl()` 返回 `ws.WebSocket`
（`ws` 是直接依赖，可区分 `ws` 与 Node 全局回退）。

## Alternatives considered

- **改为顶层静态 `import`** —— 会让可选 SDK 变成模块加载期的硬依赖，未安装时所有频道文件
  导入即失败，违背按需安装的设计。
- **改为顶层 `await import()`** —— 顶层 await 会把频道模块的求值变成异步，改变现有导出与
  启动顺序；且 `require.resolve` 等同步路径还得另找替代。
- **维持现状，依赖全局 WebSocket 回退** —— 七个频道仍不可用；`ws` 回退路径也拿不到库形态。
- **只修 `resolveWebSocketImpl`** —— `ws` 恰好是直接依赖，症状最轻；真正不可用的是七个可选
  频道，必须逐点修。

## Consequences

- **换来**：安装可选 SDK 后七个频道恢复惰性加载；`ws` 路径不再静默退回全局实现。
- **负控制**：回退 8 个源文件到修复前，新增 2 条用例均转红（首个失败点为 Discord 缺少
  `node:module` 导入；运行期为全局 WebSocket 与 `ws.WebSocket` 引用不等）；恢复后 2/2 绿。
- **未验证**：七个可选 SDK 不在仓库依赖内，CI 无法实际安装并建立连接；运行期行为仅由
  `ws`（直接依赖）覆盖，其余以静态约束与构建通过作保证。
