# Sati 技术债务深度分析报告

- 审计日期：2026-08-02
- 审计范围：`src/`（641 个 TS 文件，约 11.9 万行）、`tests/`（104 个测试文件）、`ui/`（397 个 TS/TSX 文件，59 个测试文件）、`ui/server/`（95 个 JS 文件，约 1.1MB）、构建链（pnpm-workspace / install.sh）、文档（README / CLAUDE.md / i18n）
- 方法：6 路并行只读调查 + 关键结论逐行交叉验证（src/index.ts 存在性、上帝文件行数、ui/server 对 src 的深层导入、git 追踪产物）

## 总体结论

存在显著技术债务，且呈结构性而非表面性。债务主线是一条清晰的演变轨迹：**PilotDeck 改名/转型为 Sati 的迁移只完成了一半**——核心代码已 rebrand，但部署层、中文文档、设计资产、以及一套"第二后端"仍停留在旧形态。叠加扩展过快导致的大文件、内嵌子包双构建、测试盲区，形成了多级债务。

必须客观说明：**代码卫生基本面不差**（详见"健康面"），问题集中在架构与工程组织，而非代码质量散乱。

---

## 已处理项（2026-08-03，全面修复会话）

- **依赖安全**：root/ui 批量升级 20+ 包（larksuite 1.65→1.72、mcp-sdk 1.29→1.30、sharp 0.34.5→0.35.3、undici 8.3→8.9、genai 2.10→2.15、shell-quote 1.8.4→1.10 等）；新增 `.npmrc` `audit-registry` 指向 npm 官方（npmmirror 已下线 audit 端点）；`package.json` 增加 overrides（axios/hono/fast-uri/protobufjs/js-yaml/uuid/prismjs/@hono/node-server/body-parser）。audit 83→16，**生产运行时链清零**；残留 16 条均属 dev/打包链（eslint、tsx、electron-builder）与 react-router（RSC-only，npmmirror 未同步 8.x）。
- **Lint 清零**：后端 25→0、UI 93→0（删死代码、`_` 前缀占位参数、修 hooks 依赖与 Tailwind 类冲突；fast-refresh 告警按「context+hook 捆绑」架构模式做文件级豁免并注明理由）。
- **测试补齐**：router（parseTier/decideScenario）、cron（CronSchedule/CronTimezone）、always-on（DiscoveryGates/ChannelLeaseRegistry/PlanContract）新增 7 个 spec、67 用例；后端 806→873 全绿，UI 445 全绿。
- **类型收敛**：移除 Feishu/Weixin `logger as any`（结构与 CommandExecContext 兼容）；Mattermost/HomeAssistant `globalThis as any` WebSocket 兜底改为 `typeof import("ws").WebSocket` 类型化并显式报错。
- **文档/数据**：CLAUDE.md 目录结构补齐 26 模块、修正测试命名（`.spec.ts`/`.test.ts`）与 `ui/e2e/` 路径；i18n en/zh-CN 三份 JSON（common/chat/settings）key 完全对齐。

## 已知残留（未处理，需专项排期）

- **ui/server 双后端收敛**、AgentLoop（3643 行）/InProcessGateway（2180 行）拆解：中期重构，单会话强做必然半成品。
- **TS7 / ESLint10 跨大版本迁移**、react-router 8 升级（漏洞仅影响 RSC 模式且 npmmirror 未同步 8.x）：需专项迁移。
- **logger 统一**（135 处裸 console）、**130+ 无参 catch 治理**：持续工程。
- **UI chunk >1MB**（vite 构建警告）：需代码分割。
- **测试基建竞态**：root `pnpm test`（重建 dist）与 ui `pnpm test` 并发会偶发失败，CI 需串行执行。

---

## 已处理项（2026-08-02，审计当日）

- **Docker 技术栈确认已放弃，全部资产已删除**：`Dockerfile`、`docker-compose.yml`、`docker-entrypoint.sh`、`.dockerignore`、`README_DOCKER*.md`、`.github/workflows/docker-build.yml` 及文档中的 Docker 部署章节已随提交 `8c0d0eca chore(docker): remove abandoned Docker deployment assets` 移除。原 P0 两条（Docker 入口引用不存在的 `pilotdeck.js`、Gateway 端口三处不一致）随之消除，不再构成债务。审计时两条均属实（前者本地复现 `MODULE_NOT_FOUND`，成因是 rebrand 提交将 `src/cli/pilotdeck.ts` 重命名为 `sati.ts` 但未同步 entrypoint；后者为 `Dockerfile:88` 18789 vs compose/代码默认 19789，成因是端口迁移提交漏改 Dockerfile）。
- 原 P0 段删去后，当前债务按 P1/P2 两级组织（见下）。

---

## P1 — 结构性债务（重构成本高、影响面大）

### 1. 双后端并存：`ui/server` 是第二套手写 JS 后端（最重的一项）

- `ui/server/` 共 **95 个文件、约 1.1MB 手写 JS**（无 TypeScript、无 protocol/runtime/config 分层），其中 `index.js` 130KB、`pilotdeck-bridge.js`/`sati-bridge.js` 各 80KB、`routes/{taskmaster,git,agent,config}.js` 各 37–56KB。
- 它**直接深层 import `src/` 内部实现**（≥10 个文件，如 `ui/server/discovery-plans.js:20-27` → `src/always-on/web/DiscoveryPlanService.js`、`projects.js:26` → `src/web/server/legacySessionPresentation.js`），违反 CLAUDE.md"ui/ 不得直接导入 src/"的边界声明——**绕过 gateway 协议，编译期耦合核心实现**。
- 由此产生**同能力多套实现**：
  - 双 WebSocket 协议栈：`src/gateway/server/websocket.ts` 手写帧解析 vs `ui/server/index.js:412` 的 `ws` 库 `WebSocketServer`
  - 双记忆运行时：`src/context/memory/EdgeClawMemoryProvider.ts`（agent 主链路）vs `ui/server/services/memoryService.js` **直接 import edgeclaw 编译产物**并自建 60s 调度器
  - 三重会话/项目列表：gateway 协议层 + `src/web/server/listProjects.ts` + `ui/server/projects.js` 各自实现 `getProjects`
  - 双 `repairToolName`：`src/model/streaming/repairToolName.ts` 与 `src/tool/execution/repairToolName.ts` 两套并行算法
  - 双品牌 bridge/config：`pilotdeck-bridge.js` 与 `sati-bridge.js` import 列表逐行相同；`satiConfig{Config,Watcher,Reloader}.js` 与 `pilotdeckConfig{...}.js` 同构复制两份

### 2. 内嵌子包 `edgeclaw-memory-core`：包内嵌包 + 双构建 + 产物入库

- 它**不在** `pnpm-workspace.yaml` 中，靠根 `package.json:67` 的 `file:` 依赖挂载；`prebuild` 里 `cd ... && npm run build`（`package.json:18`）用 **npm**（主仓用 pnpm），且自己的 devDeps 不随 pnpm install 安装，依赖隐式提升到根 `node_modules`——构建链脆弱。
- **32 个 `lib/` 编译产物文件被 git 追踪**（`git ls-files` 实测），同时根 `tsconfig.json` 会把子包 `src/` 再编译一遍进 `dist/`——同一包被编译两次，产物与源码双份入库，任何源码改动必须手动重编译提交，极易漂移。
- 内部还残留 `ui-source/`（旧 UI：`app.js` 94KB）和独立 `package-lock.json`（npmmirror registry）。

### 3. 上帝文件：20 个超 800 行的文件

实测 Top5：

| 文件 | 行数 |
|---|---|
| `src/agent/loop/AgentLoop.ts` | 3569 |
| `src/gateway/client/InProcessGateway.ts` | 2175 |
| `src/adapters/channel/wecom/WeComChannel.ts` | 1757 |
| `src/cli/createLocalGateway.ts` | 1583 |
| `src/router/RouterRuntime.ts` | 1293 |

最大单点 AgentLoop 是系统主循环，却无直接测试（见 P2-1），重构成本与收益都是最高。

### 4. 模块分层声明与实际脱节

CLAUDE.md 宣称的"protocol/runtime/config 三层 + index.ts barrel"：26 个顶层模块中仅 mcp/cron/always-on/rule/agent/lifecycle/methodology 符合；**`src/index.ts` 根本不存在**（实测）；tool/session/gateway/context/knowledge/patent/network/telemetry 扁平或半分层。另存在 4 对模块级循环依赖（agent↔tool、session↔agent 是运行时值依赖环，不只是 type-only）。

---

## P2 — 工程欠账（单点可修、累积量大）

1. **测试覆盖「中偏差」，且集中在非核心区**：26 个 src 模块中 **8 个完全零测试**（router 24 文件、always-on 40 文件、cron 17 文件、permission/task/telemetry/lifecycle/status 约 20 文件）；`AgentLoop.ts`（135KB）、`ToolRuntime.ts`（21.8KB）、`GatewayWsConnection.ts`（11.9KB）均无直接测试。质量两极：`tests/workflow/WorkflowEngine.test.ts`、`tests/session/turn-file-artifacts.spec.ts` 是高质量集成测试，但 `tests/gateway/weixin-settings-runtime-flow.spec.ts` 有 4 个用例是用 `readFileSync` + 正则**扫描源码字符串**的伪测试，重构即碎。
2. **无统一 logger，可观测性靠裸 console**：无独立 logger 模块；`src/` 约 135 处 `console.log/error`，其中 model streaming 与 router 的热路径（如 `streamModel.ts:158` `[model-debug] Request dumped`）是生产诊断信号却无级别/无关联 ID；**130+ 处无参 `catch {}` 静默吞错**（部分有注释属防御式，可接受；无注释的如 `ApiServerChannel.ts` 多处是隐患）。全局错误处理只存在于 `cli/sati.ts:456-463` 的 server 入口。
3. **依赖版本爆炸**：`react@18.3.1` 与 `react@19.2.6` 并存（ui 声明 ^18 供 React DOM、根声明 ^19 供 Ink）、`express@4` 与 `express@5`（后者是 `@modelcontextprotocol/sdk` 硬依赖）、`katex@0.16.47` 与 `0.18.1`（`@types/katex` 只匹配旧版）——同一进程树跑双版本运行时。
4. **i18n en/zh-CN 不同步**：文件一一对应（9 namespace），但 `common.json` en 472/zh 470、`chat.json` en 421/zh 413、`settings.json` en 1170/zh 1119，互有缺失 key——CLAUDE.md 的 i18n 强制规则实际未被执行到现状。
5. **文档系统性过时**：CLAUDE.md 目录结构只列了 13/26 个目录；声称测试为 `*.test.ts` 而实际 93 个 `.spec.ts` vs 10 个 `.test.ts`；声称组件 feature-folder 而 20 个组件目录仅 3 个符合；`README.md`（Sati/专利定位）与 `README.zh.md`（PilotDeck 品牌、指向 OpenBMB）内容互相矛盾。
6. **仓库卫生小债**：`.reasonix/`（4 个文件，含本机绝对路径与会话索引）**被 git 追踪且 .gitignore 漏配**——唯一确认的工具残留入库；`install.sh`（60KB）前后两段重复定义了 11+ 个同名函数（历史分支拼接证据）；git 对象库有一个 191MB 历史 pack；`ui/package.json` 的 `sharp` devDep 全仓无引用。

---

## 健康面（避免误判为"烂项目"）

- **零 `@ts-ignore`**、零 TODO/FIXME 注释（三个文件里的"TODO"经核实全是 `todo_write` 工具/plan 校验的业务语义）、无空 `catch {}` 无注释吞错的主流。
- **测试断言质量普遍真实**：`assert` 具体行为而非空壳；专利域（patent/rule/workflow/knowledge）覆盖相对扎实——说明测试是被业务压力驱动积累的。
- `src/` 下无 `.old/.bak/__mocks__` 残留、无 `dist/` 导入污染（历史 dist/src 切换问题已清理干净）、gitignore 对 dist/node_modules/.DS_Store/.env 等覆盖完整、二进制经 LFS 管理、CI 覆盖 typecheck/lint/format/test。
- 新模块（mcp、cron、rule、workflow）分层质量高、barrel 完备；ui 的 v1/v2 并非重复组件树，而是"v1 基础层被 V2 复用"的合理中间态（已逐文件核实）。

---

## 建议修复优先级

1. **立即（半天内，可验证）**：`.reasonix` 加入 .gitignore 并 `git rm --cached`。
2. **短期**：把 `edgeclaw-memory-core` 移入 `pnpm-workspace.yaml`、删除独立 `package-lock.json`、`lib/` 产物改为构建时生成不入库；为 `router/`、`cron/`、`permission/` 补最小行为测试；统一 i18n 三份 JSON 的 key。
3. **中期**：确定 `ui/server` 的演进方向（要么收敛到 `src/` 的 TS 分层并只 import barrel，要么逐步迁到 gateway API）——这是消除双后端/双 WebSocket/双记忆运行时的唯一路径；拆分 `AgentLoop.ts` 与 `InProcessGateway.ts`；完成全仓品牌收敛（README.zh.md、products 示例、pilotdeck-* 文件）。
4. **持续**：建立统一 logger 接入 telemetry；治理 130+ 静默 catch；统一 React/Express/katex 版本策略；重写 CLAUDE.md 使其与实际一致（否则会持续误导后续修改）。
