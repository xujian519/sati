# Agent Note: ink 8 升级与 stdout 尺寸读取收敛

Status: implemented

## Problem

`ink` 7.1.1 → 8.0.0（dependabot #781）把 `useStdout()` 暴露的 `stdout` 类型从
`NodeJS.WriteStream` 收窄为 `NodeJS.WritableStream`。运行时流仍是 TTY 流，但类型上
不再声明 `columns` / `rows`，于是 TUI 四处读取终端尺寸的代码 typecheck 失败：

- `TuiApp.tsx`、`SatiLogo.tsx`、`ToolOutputViewer.tsx`、`MessageResponse.tsx`
  直接访问 `stdout.columns` / `stdout.rows`；
- `useTuiActions.ts` 的入参声明为 `NodeJS.WriteStream`，与 `useStdout()` 的新返回类型不兼容
  （`TS2740`：缺 `clearLine`、`cursorTo`、`moveCursor` 等 83 个属性）。

这些读取都有 `?? 80` / `?? 24` / `?? 28` 兜底，真正依赖的只是两个数字，不是 `WriteStream`
的整套方法。

## Decision

- 新增 `src/adapters/channel/tui/app/terminal-size.ts`：`readTerminalSize(stdout)` 在流上
  防御性读取 `columns` / `rows`，缺失时返回 `undefined`，由调用点保留各自原有默认值。
- 四个组件改用该函数；`useTuiActions` 的 `stdout` 入参改为 `NodeJS.WritableStream`
  （它只用到 `.write()`），与 ink 8 的上下文类型对齐。
- 升级 `ink` 到 `^8.0.0`（依赖与 lockfile 来自 #781），不保留 ink 7。
- 新增 `tests/adapters/channel/tui/app/terminal-size.spec.ts` 覆盖三种形态：
  带尺寸的 TTY 流、无尺寸的普通可写流、无 stdout。

## Alternatives considered

- **在每个调用点把 `stdout` 断言成 `NodeJS.WriteStream`** — 落选：同一个不成立的假设
  复制四份，后人再读时无法从一处看出「ink 8 只删了类型声明、运行时属性仍在」。
- **改用 `process.stdout.columns` / `process.stdout.rows`** — 落选：绕过了 `useStdout()`
  注入的流。TUI 在测试或自定义 `render({ stdout })` 下拿到的是别的流，读 `process.stdout`
  会量错对象。
- **给 ink 做模块类型增强（declare module）把 `stdout` 改回 `WriteStream`** — 落选：
  覆盖上游的真实收窄，把「只有部分流有尺寸」这个事实重新藏起来；升级到再下一版时同样会炸。
- **留在 ink 7 不升级** — 落选：dependabot 已开出主版本升级，且 ink 8 的类型变化本身
  指出了代码里未声明的运行时假设；用一处分层读取就能对齐，没有冻结版本的理由。
- **把 `readTerminalSize` 做成 React hook** — 落选：四个调用点已经在组件内调用
  `useStdout()`，再包一层 hook 只增加一层间接；纯函数更容易单测。

## Consequences

- TUI 运行时行为不变：真实终端仍取 `columns` / `rows`，非 TTY 流继续落到各组件原有默认值。
- ink 的 stdout 类型变化从此只需要改 `terminal-size.ts` 一处；新增读取尺寸的组件也走同一入口。
- 无工具 `inputSchema`、事件面、磁盘格式变更，无需重录 llm-replay。
