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

## 已处理项（2026-08-04 ~ 08-06，后续跟进）

- **`.reasonix` 入库**（原 P2-6）：已 `git rm --cached` 并加入 .gitignore（`ccc2d582 chore(cleanup)`）。
- **edgeclaw-memory-core 包内嵌包**（原 P1-2）：已移入 `pnpm-workspace.yaml`（`src/context/memory/edgeclaw-memory-core`），消除 `file:` 依赖与 npm/pnpm 构建混用；`prebuild`/`predev` 统一经 `pnpm --filter edgeclaw-memory-core build` 重建，构建竞态已修复（`bd303462`）。
- **测试覆盖「中偏差」**（原 P2-1）：router / cron / always-on / permission 等原零测试模块已补齐测试（`tests/` 现有 router 3、cron 2、always-on 5、permission 3、knowledge 28、patent 47 等）；依赖对齐与权限模块测试（`33364962`）、knowledge.db 复用测试（`40de3523`）。
- **i18n en/zh-CN 不同步**（原 P2-4）：三份 JSON key 已对齐（`20e9218c` 同步 i18n）。
- **README.zh.md 品牌矛盾**（原 P2-5）：README.zh.md 已与 README.md 统一为 Sati/专利定位；CLAUDE.md 目录结构已按 26 模块补齐、测试命名（`.spec.ts`/`.test.ts`）与 `ui/e2e/` 路径已修正（2026-08-03 会话）。
- **build-knowledge-vectors 空路径 bug 与方案废弃**（原审计附注）：脚本已标注 **deprecated**，被 knowledge.db embeddings 复用取代（`fc472b90` / `b9eb337e`，见 `docs/design/import-xiaonuo-knowledge.md`）。

---

## 已处理项（2026-08-13，技术债务清理会话）

- **lint 残留清零**（原"立即"1）：`src/patent/evaluate/evaluator.ts:121` 未使用变量 `overall` 已删除，`pnpm lint` 0 error / 0 warning。
- **依赖安全 27 → 1**（原"立即"2）：`pnpm.overrides` 补齐 6 类漏洞包（tar ^7.5.21、js-yaml@>=4 4.3.1、brace-expansion 按主版本 1.1.18 / 2.1.4 / 5.0.9、nanoid 3.3.17 / 5.1.16、form-data@>=4 4.0.6、ip-address ^10.3.1、esbuild ^0.28.1）；`pnpm audit` 27 → **1**（仅 extract-zip，无可用修复版本，electron 安装期依赖）。全部为同大版本 semver 兼容升级，经 `pnpm-lock.yaml` 实测解析验证。
- **ui-source 删除：评估后不执行**（原"立即"3）：详见 Sprint Backlog 第 3 项——ui-source 为 `/memory-dashboard` 活跃资产，非死代码，已回滚。

## 已处理项（2026-08-14，A 档低风险清理会话）

- **UI 死代码删除**（BFS 可达性 + 全量引用确认后）：`app-shell/AppShellContext.ts`、`app-shell/VersionBadge.tsx`、`components/ui/scroll-area.tsx`（共 310 行）已删除，`ui` typecheck 通过；级联孤儿 `hooks/useGitVersion.ts`（VersionBadge 唯一消费者，109 行）随审查一并删除。
- **命名颠倒标注**（B 档）：`main-content/view/MainContent.tsx`（活跃路由壳）与 `chat-v2/ChatInterfaceV2.tsx`（活跃组合壳）头部加注释，说明"v1/v2 目录名不代表新旧"（视图在 `main-content-v2/`、聊天基础层在 `chat/`）。重命名目录未做（中风险，需专项）。
- **nuo-*.yaml 处置决策**（B 档）：2026-08-14 决策为**激活（评审后接入）**，已登记为 Sprint Backlog 中期项 #9（前置：31 条 `action: block` 逐条评审；接入路径：scope=patent 合并 或 domains pack）。
- **C 档验证**：CI 串行确认——`.github/workflows/ci.yml` quality job 中 `Build & test (backend)` 与 `Test (ui)` 为同 job 顺序 step，同 runner 串行，08-02 报告所述并发竞态在 CI 不存在（无需修改）。`pnpm audit` 复跑发现 **nanoid 3.3.17 → 3.3.18**（`ui>postcss>nanoid`，官方 patched `>=3.3.18`，08-13 override 值 3.3.17 偏旧），override 更新 + `pnpm install` 后 **audit 2 → 1**（仅剩 `extract-zip`，electron 安装期依赖，`Patched: <0.0.0` 无修复版本，保留）。
- **测试覆盖修正（此前粗筛误报）**：`atomicChecker`（atomic-checker.spec.ts 15 用例）、`slop-engine`（slop-engine.spec.ts 19 用例）、`graph/node-policy`（node-policy.spec.ts 7 用例）、`workflow-dag`（workflow-dag.spec.ts）、镜像一致性（quality-gate-mirror.spec.ts，PAT-RISK/APPROVAL/ABS 三组关键词 vs quality-gate.ts 三数组）**均有测试**——此前"新增 patent 模块无测试"为假阴性（测试文件 kebab-case 命名 + barrel 间接引用）。真实无直接测试的仅剩 `evidence/claimBinding.ts`、`evidence/rule-loader.ts`、`graph/domains/shared.ts`（低风险辅助模块，可后续补或豁免）。

---

## 已处理项（2026-08-02，审计当日）

- **Docker 技术栈确认已放弃，全部资产已删除**：`Dockerfile`、`docker-compose.yml`、`docker-entrypoint.sh`、`.dockerignore`、`README_DOCKER*.md`、`.github/workflows/docker-build.yml` 及文档中的 Docker 部署章节已随提交 `8c0d0eca chore(docker): remove abandoned Docker deployment assets` 移除。原 P0 两条（Docker 入口引用不存在的 `pilotdeck.js`、Gateway 端口三处不一致）随之消除，不再构成债务。审计时两条均属实（前者本地复现 `MODULE_NOT_FOUND`，成因是 rebrand 提交将 `src/cli/pilotdeck.ts` 重命名为 `sati.ts` 但未同步 entrypoint；后者为 `Dockerfile:88` 18789 vs compose/代码默认 19789，成因是端口迁移提交漏改 Dockerfile）。
- 原 P0 段删去后，当前债务按 P1/P2 两级组织（见下）。

---

## P1 — 结构性债务（重构成本高、影响面大）

> 以下为 2026-08-12 二次审计时的现状快照；个别条目已被后续提交解决（如"品牌双轨"已于 2026-08-13 收尾，见 `docs/brand-unification-plan.md`，P1-1 中 `pilotdeck-bridge.js` 等描述为审计时状态）。

### 1. 双后端并存：`ui/server` 是第二套手写 JS 后端（最重的一项）

> ✅ **决策保留（2026-08-14）**：双后端为**有意设计**，不再列为债务。`ui/server` 是独立 Express 桥接层，经 WebSocket 连 gateway 协议通信（见 `ui/server/sati-bridge.js` 头部注释：进程内网关会造出第二个分叉的 agent 运行时，不共享 `~/.sati/projects/<id>/chats/*.jsonl` 写入与权限状态）；非聊天执行能力（项目/文件/git/mcp/skills/taskmaster/记忆/cron 管理）本就是本地磁盘操作，无需 agent 运行时。历史上统一尝试后系统难用。后续审计不再催收；若未来要动，只关注其中**可分离的卫生子项**（见下），不动架构本身。

- `ui/server/` 共 **95 个文件、约 1.1MB 手写 JS**（无 TypeScript、无 protocol/runtime/config 分层），其中 `index.js` 130KB、`pilotdeck-bridge.js`/`sati-bridge.js` 各 80KB、`routes/{taskmaster,git,agent,config}.js` 各 37–56KB。
- 它**直接深层 import `src/` 内部实现**（≥10 个文件，如 `ui/server/discovery-plans.js:20-27` → `src/always-on/web/DiscoveryPlanService.js`、`projects.js:26` → `src/web/server/legacySessionPresentation.js`），违反 CLAUDE.md"ui/ 不得直接导入 src/"的边界声明——**绕过 gateway 协议，编译期耦合核心实现**。
- 由此产生**同能力多套实现**：
  - 双 WebSocket 协议栈：`src/gateway/server/websocket.ts` 手写帧解析 vs `ui/server/index.js:412` 的 `ws` 库 `WebSocketServer`
  - 双记忆运行时：`src/context/memory/EdgeClawMemoryProvider.ts`（agent 主链路）vs `ui/server/services/memoryService.js` **直接 import edgeclaw 编译产物**并自建 60s 调度器
  - 三重会话/项目列表：gateway 协议层 + `src/web/server/listProjects.ts` + `ui/server/projects.js` 各自实现 `getProjects`
  - 双 `repairToolName`：`src/model/streaming/repairToolName.ts` 与 `src/tool/execution/repairToolName.ts` 两套并行算法
  - 双品牌 bridge/config：`pilotdeck-bridge.js` 与 `sati-bridge.js` import 列表逐行相同；`satiConfig{Config,Watcher,Reloader}.js` 与 `pilotdeckConfig{...}.js` 同构复制两份

#### 可选卫生项（2026-08-14 决策保留后登记，纯卫生不动架构，做不做都行）

1. **深层 import 收口**：`ui/server → src/` 深层 import 实测 18 处（含测试文件；排除测试 15 处；08-12 审计为 20 处/9 文件），改为统一走 `src/<module>/index.ts` barrel——纯防御，防止未来核心重构（如模块内文件移动）静默破坏桥接层。
2. **停用编译产物直连**：`ui/server/routes/memory.js:5` 直接 import `edgeclaw-memory-core/lib/index.js` 编译产物，源码改动需手动重编译才生效（漂移风险点），可改用子包源码入口。
3. **`ui/server/index.js` 机械分片**：3839 行纯拆分（routes / middleware / services / websocket 四类），不改逻辑 → DoD：拆后单文件 ≤ 500 行，entry 只做组装，`pnpm --filter sati-ui test` 全绿。

### 2. 内嵌子包 `edgeclaw-memory-core`：包内嵌包 + 双构建 + 产物入库

> ✅ **已处理（2026-08）**：子包已移入 `pnpm-workspace.yaml`，统一 pnpm 构建，见"已处理项（2026-08-04 ~ 08-06）"。以下为审计时的原始描述，保留作历史记录。

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
5. **文档系统性过时**：> ⚠️ **大部分已处理（2026-08）**：CLAUDE.md 目录结构已补齐 26 模块并重写（见"已处理项"）；README.zh.md 已统一为 Sati 品牌；`docs/` 专项文档（知识库/判例/专利数据层/协议版本化等）已随代码更新。剩余持续项：文档随代码漂移的管理机制（可考虑文档 CI 检查）。
6. **仓库卫生小债**：`.reasonix/`（4 个文件，含本机绝对路径与会话索引）**被 git 追踪且 .gitignore 漏配**——✅ 已处理（`ccc2d582` untrack + 加 .gitignore）；`install.sh`（60KB）前后两段重复定义了 11+ 个同名函数（历史分支拼接证据）；git 对象库有一个 191MB 历史 pack；`ui/package.json` 的 `sharp` devDep 全仓无引用。

---

## 健康面（避免误判为"烂项目"）

- **零 `@ts-ignore`**、零 TODO/FIXME 注释（三个文件里的"TODO"经核实全是 `todo_write` 工具/plan 校验的业务语义）、无空 `catch {}` 无注释吞错的主流。
- **测试断言质量普遍真实**：`assert` 具体行为而非空壳；专利域（patent/rule/workflow/knowledge）覆盖相对扎实——说明测试是被业务压力驱动积累的。
- `src/` 下无 `.old/.bak/__mocks__` 残留、无 `dist/` 导入污染（历史 dist/src 切换问题已清理干净）、gitignore 对 dist/node_modules/.DS_Store/.env 等覆盖完整、二进制经 LFS 管理、CI 覆盖 typecheck/lint/format/test。
- 新模块（mcp、cron、rule、workflow）分层质量高、barrel 完备；ui 的 v1/v2 并非重复组件树，而是"v1 基础层被 V2 复用"的合理中间态（已逐文件核实）。

---

## 建议修复优先级

> 截至 2026-08-06 的跟进状态：✅ 已完成 / ⏳ 进行中 / ⬜ 未启动。

1. **立即（半天内，可验证）**：`.reasonix` 加入 .gitignore 并 `git rm --cached`。 — ✅ 已完成（`ccc2d582`）
2. **短期**：把 `edgeclaw-memory-core` 移入 `pnpm-workspace.yaml`、删除独立 `package-lock.json`、`lib/` 产物改为构建时生成不入库；为 `router/`、`cron/`、`permission/` 补最小行为测试；统一 i18n 三份 JSON 的 key。 — ✅ 大部分已完成（子包入 workspace、测试补齐、i18n 对齐均已落地；`lib/` 产物入库问题仍待处理）
3. **中期**：确定 `ui/server` 的演进方向（要么收敛到 `src/` 的 TS 分层并只 import barrel，要么逐步迁到 gateway API）——这是消除双后端/双 WebSocket/双记忆运行时的唯一路径；拆分 `AgentLoop.ts` 与 `InProcessGateway.ts`；完成全仓品牌收敛（README.zh.md、products 示例、pilotdeck-* 文件）。 — ⏳ 部分（S1 冻结增量已落地，见 `docs/design/gateway-protocol-versioning.md` Part B；品牌收敛✅ 已完成（2026-08-13 收尾：pilotdeck 双轨死代码删除、provider 标识统一、兼容层标注 `legacy(pre-rebrand)`，见 `docs/brand-unification-plan.md`）；AgentLoop✅ 已拆解（2026-08-14 v0.0.28：4685 行拆为 8 模块 + phase4 再增 requestInvariant/repeatToolReminder，见 `docs/agentloop-refactor-plan.md`）；`InProcessGateway` 拆分为剩余工作；双后端按 2026-08-14 决策保留，不列为债务）
4. **持续**：建立统一 logger 接入 telemetry；治理 130+ 静默 catch；统一 React/Express/katex 版本策略；重写 CLAUDE.md 使其与实际一致（否则会持续误导后续修改）。 — ⏳ 部分（CLAUDE.md 已重写对齐实际；logger / 静默 catch / 版本策略未启动）

---

# 2026-08-12 二次审计快照（当前状态验证）

- 审计日期：2026-08-12
- 审计基线：`pnpm typecheck` ✅ 0 错误；`pnpm lint` ⚠️ 1 warning（`evaluator.ts:121` unused var）；`pnpm audit --registry npmjs` 🔴 26 vulns（1 critical / 17 high / 7 moderate / 1 low）
- 方法：**只读实证**（`tsc --noEmit`、`eslint`、`pnpm audit`、`find + wc -l` Top 大文件、`grep` 模式扫描、`git ls-files` 追踪状态），与 2026-08-02 首次审计结果逐项交叉比对

## 本次基线（可复现命令）

```bash
pnpm typecheck                        # → 0 错误（含 edgeclaw-memory-core 子包）
pnpm lint                             # → 1 warning：src/patent/evaluate/evaluator.ts:121
pnpm audit --registry https://registry.npmjs.org/   # → Severity: 1 low | 7 moderate | 17 high | 1 critical
```

## 一、总体判断（对比 2026-08-02）

| 维度 | 08-02 | 08-12 现状 | 变化 |
|---|---|---|---|
| TypeScript 严格检查 | 全绿 | ✅ 全绿 | 保持 |
| ESLint | 后端 0 / UI 0 | ⚠️ 后端 1 warning / UI 0 | 新增 1 处未使用变量 |
| 依赖安全漏洞 | 16（生产链清零） | 🔴 **26（1 crit + 17 high + 7 mod + 1 low）** | ⚠️ **恶化 10 条**，需重新审核 overrides 覆盖范围 |
| React 版本并存 | 18 + 19 双版本 | ✅ 仅 19.2.8 | 已修复 |
| Express 版本并存 | 4 + 5 双版本 | ✅ 仅 5.2.1 | 已修复 |
| edgeclaw 产物入库 | 部分追踪 | ✅ lib/node_modules 均不入库 | 已修复 |
| `ui/server` 深层 import `src/` | 存在 | ⚠️ **20 处 / 9 文件，未收敛** | 无进展 |
| 品牌双轨（pilotdeck / sati） | 双轨完整 | ✅ **已收尾（2026-08-13）：11 个双轨死代码文件已删除，仅剩 legacy(pre-rebrand) 兼容层** | 已修复 |
| 裸 console | 135 处 | ⚠️ **225 处 / 29 文件**（增幅 67%，热点 `sati.ts` 54 处） | 恶化 |
| `any` / `@ts-ignore` 类逃逸 | 未测 | ⚠️ **111 处 / 74 文件** | 新测量项 |

---

## 二、P1 结构性债务 — 2026-08-12 现状

### 1. 双后端并存（未收敛 / 与 08-02 一致）

- `ui/server/`：**92 JS 文件，72 个裸手写无类型 JS（无对应 .ts/.tsx）**
- `index.js` **3808 行**（首次审计时 130KB，按 250 行/KB 估算约 3250 行，当前实测 3808 行 → 增长约 17%）
- 跨边界深层 import 20 处（9 文件），典型路径：
  - [sati-bridge.js](file:///Users/xujian/projects/Sati/ui/server/sati-bridge.js) → `src/cli/proxy.js`、`src/gateway/index.js`、`src/status/agentStatus.js`、`src/web/client/eventMapping.js`、`src/context/budget/compactBudget.js`
  - [routes/config.js](file:///Users/xujian/projects/Sati/ui/server/routes/config.js) → `src/model/providerEndpoint.js`、`src/model/ollama/probe.js`、`src/network/fetch.js`
  - [routes/memory.js](file:///Users/xujian/projects/Sati/ui/server/routes/memory.js) → **直接 import `edgeclaw-memory-core/lib/index.js` 编译产物**（绕开 TS 层）
  - [routes/commands.js](file:///Users/xujian/projects/Sati/ui/server/routes/commands.js) → `src/adapters/channel/protocol/ChannelCommandRegistry.js`、`src/cli/commands/chatSearch.js`

### 2. 品牌双轨 PilotDeck→Sati 迁移（✅ 已收尾，2026-08-13）

> ✅ **已处理（2026-08-13）**：按 `docs/brand-unification-plan.md` 完成收尾——`ui/server/pilotdeck-bridge.js`、`pilotdeckConfig{Config,Reloader,Watcher}.js` 及各自 test、`ui/src/hooks/usePilotDeckConfig.ts(.test.tsx)`、`scripts/bootstrap-pilotdeck-config.mjs` 共 11 个双轨死代码文件已删除；`readSessionMessages.ts` 12 处历史消息帧 `provider` 标识统一为 `sati`；13 处升级兼容层统一标注 `legacy(pre-rebrand)`。以下为审计时的原始描述，保留作历史记录。

- 仍 **38 个文件** 含 `pilotdeck` 字样（`grep -ri pilotdeck --include='*.{ts,tsx,js,jsx,json,md,html}'` 实测）
- `ui/server/` 内部完整双轨：
  - [pilotdeck-bridge.js](file:///Users/xujian/projects/Sati/ui/server/pilotdeck-bridge.js) 1862 行 ↔ [sati-bridge.js](file:///Users/xujian/projects/Sati/ui/server/sati-bridge.js) 1971 行（import 列表逐行一致，仅常量 / 注释差异）
  - [pilotdeckConfig.js](file:///Users/xujian/projects/Sati/ui/server/services/pilotdeckConfig.js) 699 行 ↔ [satiConfig.js](file:///Users/xujian/projects/Sati/ui/server/services/satiConfig.js) 728 行（`deepMerge/clone/isRecord/normalizeString` 工具函数逐字复制；Watcher / Reloader / test 同样成对）
  - Hooks 仍未改名：[usePilotDeckConfig.ts](file:///Users/xujian/projects/Sati/ui/src/hooks/usePilotDeckConfig.ts)（含 `usePilotDeckConfig.test.tsx`）

### 3. 上帝文件与巨无霸函数（略有恶化）

#### Top 大文件 > 1000 行（src/ + memory-core 子包，共 12 个）

| 文件 | 08-02 行数 | 08-12 实测 | 变化 |
|---|---|---|---|
| [llm-extraction.ts](file:///Users/xujian/projects/Sati/src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts) | 未单独统计 | **3737 / 106 fns** | 新增入榜 |
| [AgentLoop.ts](file:///Users/xujian/projects/Sati/src/agent/loop/AgentLoop.ts) | 3569 | **3546 / 67 fns** | ↓23（小幅清理） |
| [InProcessGateway.ts](file:///Users/xujian/projects/Sati/src/gateway/client/InProcessGateway.ts) | 2180 | **2341 / 40 fns** | ↑161（净增功能） |
| [sqlite.ts](file:///Users/xujian/projects/Sati/src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts) | 未单独统计 | **2024** | 新增入榜 |
| [createLocalGateway.ts](file:///Users/xujian/projects/Sati/src/cli/createLocalGateway.ts) | 1583 | **1823** | ↑240 |
| [WeComChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/wecom/WeComChannel.ts) | 1757 | **1760** | 持平 |
| [file-memory.ts](file:///Users/xujian/projects/Sati/src/context/memory/edgeclaw-memory-core/src/core/file-memory.ts) | 未单独统计 | **1632** | 新增入榜 |
| [providers.ts](file:///Users/xujian/projects/Sati/src/model/catalog/providers.ts) | 未单独统计 | **1579** | 新增入榜 |
| [WeixinChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/weixin/WeixinChannel.ts) | 未单独统计 | **1417** | 新增入榜 |
| [FeishuChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/feishu/FeishuChannel.ts) | 未单独统计 | **1332** | 新增入榜 |
| [RouterRuntime.ts](file:///Users/xujian/projects/Sati/src/router/RouterRuntime.ts) | 1293 | **1293** | 持平 |
| [DiscoveryFire.ts](file:///Users/xujian/projects/Sati/src/always-on/runtime/DiscoveryFire.ts) | 未单独统计 | **1252** | 新增入榜 |

#### 单函数超 300 行（1 fn / file，真正的巨无霸函数异味）

| 文件 | 行数 | 函数数 | 平均行/函数 |
|---|---|---|---|
| [reasoning-rules.ts](file:///Users/xujian/projects/Sati/src/patent/checker/reasoning-rules.ts) | 439 | 1 | **439.0** |
| [McpClient.ts](file:///Users/xujian/projects/Sati/src/mcp/client/McpClient.ts) | 426 | 1 | **426.0** |
| [kg-store.ts](file:///Users/xujian/projects/Sati/src/knowledge/shared/kg-store.ts) | 404 | 1 | **404.0** |
| [legal-search.ts](file:///Users/xujian/projects/Sati/src/knowledge/legal/legal-search.ts) | 389 | 1 | **389.0** |
| [WhatsAppChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/whatsapp/WhatsAppChannel.ts) | 322 | 1 | **322.0** |
| [workflow.ts](file:///Users/xujian/projects/Sati/src/patent/workflow.ts) | 642 | 2 | **321.0** |
| [SmsChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/sms/SmsChannel.ts) | 315 | 1 | **315.0** |
| [AlwaysOnRuntime.ts](file:///Users/xujian/projects/Sati/src/always-on/runtime/AlwaysOnRuntime.ts) | 306 | 1 | **306.0** |
| [DiscordChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/discord/DiscordChannel.ts) | 275 | 1 | **275.0** |
| [JsonlTranscriptWriter.ts](file:///Users/xujian/projects/Sati/src/session/transcript/JsonlTranscriptWriter.ts) | 270 | 1 | **270.0** |
| [SlackChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/slack/SlackChannel.ts) | 268 | 1 | **268.0** |
| [schema.ts](file:///Users/xujian/projects/Sati/src/router/config/schema.ts) | 267 | 1 | **267.0** |
| [RemoteGateway.ts](file:///Users/xujian/projects/Sati/src/gateway/client/RemoteGateway.ts) | 262 | 1 | **262.0** |

---

## 三、P2 工程欠账 — 2026-08-12 新测数据

### 1. 依赖安全：26 漏洞（较 08-02 的 16 条增长 10 条）

| 级别 | 数量 | 典型漏洞包 | 是否生产链路 |
|---|---|---|---|
| **Critical** | 1 | node-tar（解压缩 DoS / 负数大小无限循环） | 大概率打包/dev（electron-builder 链） |
| **High** | 17 | js-yaml（!!omap 二次方 CPU、merge-key 二次方）× 2 链；brace-expansion（ReDoS 指数膨胀）× 6 链；form-data CRLF 注入；nanoid 自定义生成器死循环；ip-address IPv4 前导零解析歧义 | js-yaml / brace-expansion 多为打包链；form-data / ip-address 需复核是否进入生产 MCP/邮件通道 |
| **Moderate** | 7 | node-tar PAX 崩溃 × 4；JS-YAML merge key DoS；ip-address CIDR/NAT64 误判 × 2 | 同上 |
| **Low** | 1 | esbuild Windows dev 任意文件读 | 非 macOS 生产 |

> 建议：在 `package.json` `pnpm.overrides` 中补齐 `node-tar / js-yaml / brace-expansion / nanoid / form-data / ip-address` 6 类 patched 版本后再跑一次 audit，验证是否能清到只留 dev 链。

### 2. 可观测性：225 处裸 console / 29 文件（增幅 67%）

Top 5 热点（本次 `grep -c` 实测）：

| 文件 | 次数 | 典型 pattern |
|---|---|---|
| [sati.ts](file:///Users/xujian/projects/Sati/src/cli/sati.ts) | **54** | CLI 入口启动 / 关闭日志 |
| [createLocalGateway.ts](file:///Users/xujian/projects/Sati/src/cli/createLocalGateway.ts) | **24** | 网关启动调试 |
| [WeixinChannel.ts](file:///Users/xujian/projects/Sati/src/adapters/channel/weixin/WeixinChannel.ts) | 10 | 微信通道事件 |
| [gatewaySetup.ts](file:///Users/xujian/projects/Sati/src/cli/commands/gatewaySetup.ts) | 8 | 网关配置向导 |
| [chatSearch.ts](file:///Users/xujian/projects/Sati/src/cli/commands/chatSearch.ts) | 4 | 命令输出 |
| [streamModel.ts](file:///Users/xujian/projects/Sati/src/model/streaming/streamModel.ts) | 4 | **含生产热路径 `[model-debug] Request dumped`** |

### 3. 类型逃逸：111 处 any / @ts-expect-error（74 文件）

热点模块（grep 实测次数）：

| 位置 | 次数 | 风险 |
|---|---|---|
| [planMode.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/planMode.ts) | 6 | 工具计划模式参数解析（主链路） |
| [llm-extraction.ts](file:///Users/xujian/projects/Sati/src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts) | 6 | memory-core LLM 结构化输出 |
| [MessageProjector.ts](file:///Users/xujian/projects/Sati/src/context/projection/MessageProjector.ts) | 5 | context 消息投影（主链路） |
| [RouterRuntime.ts](file:///Users/xujian/projects/Sati/src/router/RouterRuntime.ts) | 4 | 路由决策（主链路） |
| [InProcessGateway.ts](file:///Users/xujian/projects/Sati/src/gateway/client/InProcessGateway.ts) | 3 | 进程内网关消息路由（主链路） |

### 4. 测试覆盖分布不均（49 patent vs 1 browser/fs/lifecycle）

`find tests -name "*.spec.ts" -o -name "*.test.ts" | awk -F/ '{print $2}' | sort | uniq -c | sort -rn` 实测：

| 深度 | 模块（测试文件数） |
|---|---|
| ✅ 深覆盖 | patent(49) · tool(39) · knowledge(31) · context(22) · model(14) |
| ⚠️ 中覆盖 | gateway(12) · session(11) · always-on(11) · agent(10) · router(9) · rule(8) · mcp(8) · literature(8) |
| 🔴 极薄 | extension(7) · cron(7) · pilot(5) · cli(5) · workflow(4) · web(4) · permission(3) · adapters(3) · telemetry(2) · task(2) · skills(2) · network(1) · **status(1)** · **scripts(1)** · **lifecycle(1)** · **fs(1)** · **methodology(1)** · **desktop(1)** · **browser(1)** |
| ⚫ 零测试 | **shared/**（[ttl-cache.ts](file:///Users/xujian/projects/Sati/src/shared/ttl-cache.ts) 通用基础设施） |

> 零直接单测的高风险文件：[AgentLoop.ts](file:///Users/xujian/projects/Sati/src/agent/loop/AgentLoop.ts)（3546 行主循环）；[InProcessGateway.ts](file:///Users/xujian/projects/Sati/src/gateway/client/InProcessGateway.ts)（2341 行核心网关）

### 5. ESLint 唯一残留（1 warning）

- [evaluator.ts:121](file:///Users/xujian/projects/Sati/src/patent/evaluate/evaluator.ts#L121-L121)：`'overall' is assigned a value but never used.`

### 6. edgeclaw-memory-core 残留

- ✅ `lib/` 已不再被 git 追踪、✅ 独立 `package-lock.json` 已移除、✅ 已加入 `pnpm-workspace.yaml`
- ⚠️ 仍残留 [ui-source/](file:///Users/xujian/projects/Sati/src/context/memory/edgeclaw-memory-core/ui-source) 旧 UI 目录（历史遗留 `app.js` 94KB）
- ⚠️ 子包本地仍有 `node_modules/`（8KB，说明依赖提升不完整但无实际影响）

---

## 四、2026-08-12 健康面（更新版）

新增 / 更新项：

- ✅ React 18/19 并存已修复（锁文件仅 19.2.8）；Express 4/5 并存已修复（仅 5.2.1）
- ✅ 零 `@ts-ignore`（维持）；无裸 TODO/FIXME（维持；本次扫描出现的「TODO」均为业务语义：计划合同校验 / `todoWrite` 工具名）
- ✅ `pnpm workspace` 规范化：`edgeclaw-memory-core` 通过 workspace 挂载，`prebuild/predev/typecheck` 均走 `pnpm --filter`
- ✅ 新模块（mcp / cron / rule / always-on）`protocol/runtime/config` 三层 + barrel 维持
- ✅ 格式化统一：`biome.json` lineWidth=120、2 空格、双引号；lint-staged 自动化

---

## 五、2026-08-12 建议修复优先级（Sprint Backlog 就绪）

### 立即（< 半天，可独立验收，Definition of Done 可写）

1. **[evaluator.ts](file:///Users/xujian/projects/Sati/src/patent/evaluate/evaluator.ts#L121-L121) unused var 清理**：删除 `overall` 变量或加 `_` 前缀 → DoD：`pnpm lint` 0 errors / 0 warnings。
2. **pnpm overrides 补齐 6 类漏洞包**：`node-tar / js-yaml / brace-expansion / nanoid / form-data / ip-address` → DoD：`pnpm audit --registry npmjs` 清到 ≤ 10 条（剩余均在 dev/build 链，标注不触及生产）。
3. **删除 `edgeclaw-memory-core/ui-source/`**：~~`grep -r ui-source` 确认无引用后 `git rm`~~ → ⏸️ **评估后不执行（2026-08-13）**：审计假设"无引用的历史遗留"不成立——`ui-source/` 是 `/memory-dashboard` 内存仪表盘的活跃资产（`release.sh:566-575` 强制检查并打包进 sati-memory-core bundle、`ui/server/index.js:779-808` 静态服务、`MemoryPanel.tsx:51` iframe 加载、`auth.js:30` 鉴权豁免）。删除属 feature 级决策（需同步清理 5 处引用），已回滚保留；如需废弃该功能另立专项。

### 短期（1–2 天，不碰架构）

4. **极薄测试模块补最小烟雾 spec**：`browser/backend`、`lifecycle`、`fs`、`shared/ttl-cache`、`methodology`、`desktop` 各 1 个 spec，覆盖 public API 主路径 → DoD：`find tests/$module -name "*.spec.ts" | wc -l` ≥ 2，`pnpm test` 全绿。
5. **品牌双轨增量冻结**：给 [pilotdeck-bridge.js](file:///Users/xujian/projects/Sati/ui/server/pilotdeck-bridge.js)、[pilotdeckConfig.js](file:///Users/xujian/projects/Sati/ui/server/services/pilotdeckConfig.js)（含 Watcher/Reloader/test）、[usePilotDeckConfig.ts](file:///Users/xujian/projects/Sati/ui/src/hooks/usePilotDeckConfig.ts) 文件顶部加 `@deprecated` 注释，并在引用点统一标注 `// TODO(brand-migrate): replace with sati* equivalent` → DoD：`grep -c TODO(brand-migrate)` 输出数与引用点一致。 — ✅ 已被 2026-08-13 品牌统一收尾取代（死代码直接删除，见 `docs/brand-unification-plan.md`，无需再冻结）

### 中期（3–7 天专项，单独 Sprint 排期）

6. **巨无霸函数拆解 Top 5**：[McpClient.ts](file:///Users/xujian/projects/Sati/src/mcp/client/McpClient.ts) / [reasoning-rules.ts](file:///Users/xujian/projects/Sati/src/patent/checker/reasoning-rules.ts) / [legal-search.ts](file:///Users/xujian/projects/Sati/src/knowledge/legal/legal-search.ts) / [kg-store.ts](file:///Users/xujian/projects/Sati/src/knowledge/shared/kg-store.ts) / [workflow.ts](file:///Users/xujian/projects/Sati/src/patent/workflow.ts) 各拆成 ≥ 3 个职责清晰的函数或独立文件 → DoD：拆后平均行/函数 ≤ 100，对应 spec 全绿。
7. **`AgentLoop.ts` 按阶段拆分 + 补阶段单测**：拆出 `PlanStage / ActStage / ReflectStage` 三个模块（每块 ≤ 300 行）；每阶段写 ≥ 2 个单元测试 → DoD：`src/agent/loop/` 新增 3 文件，`tests/agent/loop/` 新增 6 个 describe 块，`pnpm typecheck` + `pnpm test` 全绿。
8. **`ui/server` 跨边界 import 增量冻结方案落地**：~~二选一作为专项，方案确定后写设计文档并在下一轮审计验收。~~ — ✅ **取消（2026-08-14 决策）**：双后端为必要设计，暂不收敛。仅保留可分离卫生子项：深层 import 改走 `src/<module>/index.ts` barrel、`routes/memory.js` 停用编译产物 `lib/index.js` 直连（可选用源码路径）、`index.js` 3839 行机械分片——均不动架构。
   - ~~**方案 A（协议层收敛）**：`ui/server` 所有 `import from ../../src/` 改为连 `ws://localhost:<gatewayPort>` 走 gateway 协议，仅保留 `parseGatewayConfig`（纯函数）例外~~（历史方案，随条目取消）
   - ~~**方案 B（TS 化 + barrel 约束）**：`ui/server` 迁 TS 写类型，所有对 `src/` 的 import 限定为 `src/<module>/index.ts` barrel，禁止 2、3 级子路径；写 eslint rule `no-restricted-imports` 强制执行~~（历史方案，随条目取消）
9. **nuo-*.yaml 激活专项（2026-08-14 决策：激活，评审后接入）**：`rules/patent/nuo-*.yaml`（7 文件 96 条，XiaoNuo 移植，源在 `assets/patent-rules/`、可由 `scripts/port-nuo-rules.ts` 重新生成）当前生产零加载。前置评审：**31 条 `action: block` 逐条评审**（拦截工具调用，拦截面最大；domain 分布：patent_inventiveness 18 / patent_general 18 / patent_claims 15 / patent_disclosure 13 / patent_procedure 11 / patent_oa_response 8 / patent_infringement 8 / patent_novelty 4…），评审结论落 `rules/README.md`。接入路径二选一（分层加载器 `loadRulePack` 已就绪）：(a) 并入 `rule_check` scope=patent 加载（改 `patent-compliance.ts` 或 ruleCheck resolve）；(b) 挂入 `rules/domains/*` pack.yaml 清单经 scope=pack 加载。→ DoD：`rule_check` scope=patent 规则数 = compliance + 评审通过后的 nuo 规则数；输出门禁新规则生效且全量测试绿。
   - ✅ **已实施（2026-08-16）**：见 `docs/nuo-rules-activation-plan.md`。评审结论落 `rules/README.md`（31 条 block 逐条：2 保留 block / 1 review / 15 warn / 13 log；48 warn + 17 log 全量接入），评审调整落 `rules/patent/activation-overrides.yaml`（轻量补丁）。接线两链：A 链 `rule_check` scope=patent-full（100 条，存量 scope=patent 不变）；B 链 `RuleOutputGate` + `selectGateRules()` 接入输出门禁（只保留 nuo 9 条 keyword_blocklist，structural「缺失即违规」对任意输出海量误报故排除）。C 链（policy-bridge 工具拦截）为可选二期未接线。**DoD 达成**：patent-full 规则数 = compliance 4 + nuo 96 = 100；输出门禁 block/review 挂起 + warn 提示生效；patent 355 + rule 104 用例全绿。

### 持续工程（跨 Sprint 滚动，每 Sprint 清理一块）

10. **裸 console 按模块收束到 `src/telemetry/` wrapper**：从 `sati.ts`（54 处）→ `createLocalGateway.ts`（24 处）→ `streamModel.ts`（4 处，主链路最关键），每 PR 只改 1–2 个模块 → DoD：每 Sprint 末 `grep -c console.log src/$module` 计数下降可验证。
11. **111 处 any 主链路收敛**：优先级 `tool/builtin/planMode.ts(6)` → `context/projection/MessageProjector.ts(5)` → `router/RouterRuntime.ts(4)` → `gateway/client/InProcessGateway.ts(3)` → 其余 60 外围模块 → DoD：主链路 any 清零，外围 any 加 `// SAFETY: ...` 注释说明原因并附类型守卫位置。
12. **`ui/server/index.js` 3839 行分片**：按 routes / middleware / services / websocket 四类拆出独立文件，纯机械拆分不改逻辑 → DoD：拆出后单文件 ≤ 500 行，`ui/server/index.js` ≤ 400 行（作为 entry 只做组装），`pnpm --filter sati-ui test` 全绿。
