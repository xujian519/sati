# Agent Note: Lint safety gates — type-aware no-floating-promises + disallowed-methods

Status: implemented

## Problem

对照外部规范《AI 原生开发规范》后确认,`docs/development-standards.md` 把「G2 lint 非类型感知」与「G5-b lint 负控制」列为待办:agent loop 里丢失的 promise 是参考项目里**最高价值**的缺陷类,Sati 此前抓不到;同时 child_process 的命令注入面(exec/execSync)没有禁令。这两条在此前只有散文、没有门禁。

## Decision

1. **类型感知 lint(G2 的部分落地)**:`eslint.config.mjs` 对 `src/**/*.ts|tsx|mts|cts` 接入 `parserOptions.projectService`,开启 `@typescript-eslint/no-floating-promises: error` 与 `no-misused-promises: error`。存量 10 处全部修复:
   - 4 个渠道 `stop()` 里未等待的 `disconnect()/destroy()/stop()` → `await`(符合「Dispose 必须达静止」);
   - Slack `app.error` 事件回调去掉 `async`(函数体无 await,且回调期望 void);
   - Telegram `bot.start()` 显式 `void`(长轮询挂起,不能 await);
   - `InProcessGateway.recordGatewayStatusMessage`、`GatewayElicitationChannel.dispatchHook`、`FileHistoryStore.cacheMtime` 显式 `void`;
   - TuiApp `onSubmit={handleSubmit}` 包装为 `() => void handleSubmit()`。
2. **危险 API 禁令(disallowed-methods)**:`no-restricted-imports: error` 禁 `child_process.exec`/`execSync`(经 shell 解释,存在命令注入面),**仅对核心后端 `src/` 生效**;保留 `execFile`/`execFileSync`(数组参数,不经 shell)与 `spawn`(调用方负责 scrub 环境变量/管理生命周期)。`apps/desktop`(桌面壳 + release 脚本,刻意的同步 shell 构建/平台命令)与脚本层豁免——`server-manager.ts` 自身已在注释里声明要从 `execSync` 迁移到 `execFile`。
3. **负控制(G5-b)**:新增 `tests/development-standards/lint-fixtures/{float-promise,danger-import,ok}.ts` + `lint-contract.config.mjs`(test-only)+ `lint-contract.spec.ts`,用 node:test 对违规 fixture 跑 eslint 断言非零、对合规 fixture 断言零;fixtures 已加入根 eslint ignore 不污染常规 lint。
4. 先只对 `src/` 开 type-aware;`tests/scripts` 暂不 type-aware(分批收敛)。

## Alternatives considered

- **用 no-restricted-syntax 禁整个 child_process(spawn/exec)**:被拒。会误伤 5 处刻意的 `shell: true`(bash 工具、Windows 兼容)与大量合法 `spawn`;Sati 的 mkdtemp/execFile 数组用法本身就是合规的。
- **同时开 no-non-null-assertion / no-unsafe-\***:被拒。存量 289 / 132,会一次性淹掉所有 PR;留到后续批次,与 `2026-08-23-type-assertion-cleanup-priority.md` 收敛序列并进。
- **负控制只做配置断言(读 eslint.config 断言规则=error)**:被拒。弱于「真的拦得住」;改为对真实 fixture 跑 eslint 断言非零(与 `verify-config.spec.ts` 同构)。
- **对 tests/scripts 一并开 type-aware**:被拒。先把成本控制在 src 起步(全量 type-aware 约 30s),避免本地 `pnpm lint` 过慢。
- **开 no-floating-promises 而不同步清存量**:被拒。会让 `pnpm lint` 立即全红、阻断合入。

## Consequences

- agent loop / 渠道关闭路径里丢失的 promise 现在会被 lint 拦截(最高价值缺陷类);`exec`/`execSync` 回退也被禁止。
- `pnpm lint` 对 `src/` 变慢(约 +30s 的全量 type-aware),`tests/scripts` 未 type-aware;CI 与本地均为一次性成本。
- 未改任何工具 `inputSchema`,llm-replay fixtures 不受影响;未改事件面,事件矩阵无变化。
- 后续可按同一模式开启 `no-unsafe-*` 与 `no-non-null-assertion`,以及把 type-aware 扩到 `tests/scripts`。
