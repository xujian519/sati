# Consolidate bare console.* to telemetry logger (2026-08-24)

## Status

Implemented

## Problem

`src/` 散落约 275 处裸 `console.*`（tech-debt issue **#162 / TD-CONSOLE-001**）。
裸用 `console` 导致线上日志无法按模块/级别结构化降噪，且 `console.debug` 在
Node 是 `console.log` 别名、无法真正屏蔽。catch 侧已由 PR #187（86 处补注释）
完成，本改动处理 console 侧的 B/D 类（带 `[module]` 前缀的内部错误/运行日志，
约 130 处 / 42 文件）。A 类（CLI 面向用户的 banner/向导/命令输出，约 150 处，
含 `gatewaySetup.ts`、`sati.ts` banner、weixin banner）**保留不改**；C 类
（已走 `debugLog` 门控）不重复处理。

## Decision

新增本地结构化日志 helper `src/telemetry/logger.ts`：`createLogger(namespace)`
→ 带 `[namespace] ` 前缀的 logger，`info→console.log`、`warn→console.warn`、
`error→console.error`、`debug→debugLog`（`SATI_DEBUG` 门控，修复裸
`console.debug` 无法屏蔽的问题）。barrel 经 `src/telemetry/index.ts` 导出
`createLogger / logger / Logger / LoggerLevel / CreateLoggerOptions`，配套
`tests/telemetry/logger.spec.ts`（10 例）。

迁移规则保证字节一致：namespace 取自方括号内容（`[Sati]`/`sati:` 归一为
`[sati]`），`] ` 之后文本原样保留；不改 stream、不改消息文本、不重构字符串
拼接（`JSON.stringify(data)` 内嵌保留）；`createLogger("")` 用于顶层无前缀
error（`sati.ts` `main().catch`），防破坏 CI/脚本 grep。

## Alternatives considered

- **保留裸 console + 加 no-console lint 门禁**: rejected;只提示不收敛，且
  `console.debug` 仍无法门控、无法按模块降噪。
- **引入 pino/winston/chalk**: rejected;仓库零第三方日志/终端库、既有 mono
  纯文本约定、无落盘需求（落盘已由 analytics queue + 桌面端
  `server-manager.ts` 双流镜像负责）。
- **`createLogger` 默认开 `levelTag`/`timestamp`**: rejected;会改变全部既有
  输出格式、破坏任何依赖现格式的 grep/解析。
- **`debug` 级不走 `SATI_DEBUG` 门控**: rejected;与既有 `debugLog` 语义冲突，
  `console.debug` 在 Node 无门控等于常开。
- **satiServer.ts 的 `consoleLogger` DI wrapper**: deferred;非裸 console、
  独立 DI 面，标注后续用 `createLogger("")` 统一。

## Consequences

- 新增 `src/telemetry/logger.ts`（+ barrel 导出 + `tests/telemetry/logger.spec.ts`）。
- 迁移 42 个 src 文件：移除 125 处裸 `console.*`，新增 102 处 `logger.*` 调用。
  关键场景：`createLocalGateway.ts` 的 `logKnowledgeCapabilities` 传
  `createLogger("")` 防双重前缀；`memoryDiagnostics.ts` 结构化 JSON 行仅换
  接收端、结构不变；`SessionTitleGenerator.ts` 裸 `console.debug` → `logger.debug`
  自动纳入 `SATI_DEBUG` 门控；model stream 系列 `[model-debug]` 等降噪。
- `docs/event-producer-consumer.md` 随行号漂移重新生成（迁移改变事件 emit/消费
  点行号，`pnpm check:event-matrix` 门禁须同步）。
- **循环依赖修复（CI 驱动）**：`PilotConfigStore` 顶层 `createLogger` 在
  Vite（UI Vitest）下解析为 undefined——`telemetry/context` →
  `gateway/authToken` → `pilot/index` → `PilotConfigStore` → `telemetry/index`
  形成静态循环，Vite SSR 转译的 barrel 按声明顺序加载、`logger.js` 排在
  `context.js` 之后导致绑定未就绪（Node 原生 ESM live binding 后端测试不受
  影响）。修复：`authToken.ts` 的 `resolvePilotHome`/`DEFAULT_SATI_HOME`
  本就定义于 `shared/paths/pilotPaths.ts`，改从 `shared/paths/index.js` 直接
  引用消除循环（`ui` 侧 599/599 测试转绿）。
- 剩余 ~150 处裸 console 为 A 类（CLI 面向用户输出）+ 注释 + satiServer.ts DI
  wrapper，保留待后续 issue。
- 验证全绿：`pnpm typecheck`、`pnpm lint`（含 check:event-matrix /
  check:patent-sop / check:patent-workflow-docs / check:html-templates /
  check:skills）、`pnpm format:check`、`pnpm test`（3760 pass / 0 fail）。
- 不触碰工具 `inputSchema` → llm-replay fixture 不失配；不改事件声明/emit 面
  → 无需协议版本变更。
