# Agent Note: CLI 入口分发表化 + 项目运行时装配分层（#646 sweep P2.7）

Status: implemented

## Problem

计划条目 P2.7 的两处「读一遍才能改一处」：

1. **`src/cli/sati.ts` 的 `main` 是 642 行**（文件 1034 行，在 file-size 棘轮上，基线记录 1035 行）。
   它把**十一个子命令的实现**与**全部 server 启动编排**叠在同一个函数体里：`server` 分支一项就
   占约 490 行（动态 import → 四个渠道构造器 → alwaysOn/cron 构造 → gateway 装配 →
   配置订阅热重载 → 适配器热重载 → server 启动 → 关闭与信号处理 → 永久等待）。`--help` 里能看到的
   子命令与函数体里的 `if (command === "…")` 是两份需要手工同步的清单。
2. **`src/cli/projectRuntimeFactory.ts` 的 `createProjectRuntimeResolver` 是 428 行**（内嵌 `resolve` 320 行、
   `buildRouterEventBus` 80 行）。首次解析一个工作区时要一口气走完：模型/路由/插件 → 后台任务 →
   embedding/rerank 客户端 → 记忆 provider → 工具注册表 + 计划性域裁剪 → 知识库 resolver 组装 →
   运行时对象装配。改动任何一段都要穿过另外六段。

通过判据：计划条目原文「命令分发表化；两 file ≤600」。

## Decision

**sati.ts：分发表化 + 子命令外移；projectRuntimeFactory：装配层外移。**

`sati.ts` 由 1034 行降到 **14 行**（只剩 shebang + 触发），逻辑搬到 `src/cli/commandDispatch.ts`（144 行）：
`COMMANDS: Record<string, CommandHandler>` 查表分发，未命中键与无子命令一样回落交互式 CLI。
新增 `src/cli/commands/` 下的 `serverCommand.ts` / `serverChannels.ts` / `serverSubsystems.ts` /
`serverAdapterReload.ts` / `serverLifecycle.ts` / `serverRuntimeState.ts` / `tuiCommand.ts` /
`cronCommand.ts` / `updateCommand.ts` / `skillsCommand.ts` / `flagParsing.ts` / `fallbackGateway.ts`。
`projectRuntimeFactory.ts` 577 → **235 行**，装配三段外移到 `projectRuntimeKnowledge.ts`（201）/
`projectRuntimeTools.ts`（177）/ `projectRuntimeRouterEvents.ts`（141）。

关键决策点：

1. **分发表用 `Object.hasOwn` 查键，不写 `COMMANDS[command]`**。后者对 `toString` / `constructor` /
   `__proto__` / `valueOf` 这类原型链键返回真值函数，会让这些参数名走进子命令分支——与「未知命令
   回落交互式 CLI」的既有语义相悖。抽成 `resolveCommand()` 以便直测（负控制 1 证明必要）。
2. **`main` 与分发表放进 `commandDispatch.ts` 而非留在 `sati.ts`**。`sati.ts` 在模块顶层执行
   `main()`，任何测试 import 它都会真的跑起来；把它做成纯出口模块，才能对「帮助 ↔ 分发表不漂移」
   与「原型链键不命中」写断言。
3. **各子命令一律经动态 import 加载**（分发表里 `await import(...)`）。`sati --version` / `--help` /
   `chat` / `cron` 等不加载 gateway / adapters 全树；`serverCommand.ts` 内部再用静态 import
   （该模块本身只在 `server` 命令时动态加载），与原分支的加载时机等价。
4. **`sati tui` 的 TTY 检查保持在所有重模块 import 之前**。这是 A/B 首轮抓到的真实回归：把
   `loadPilotConfig` / gateway / session 提到模块顶层后，`session/index.js` 会拉起 `node:sqlite`，
   非 TTY 下先吐 `ExperimentalWarning: SQLite` 再报错。已改回「先检查、后 import」（负控制 7 复现
   该回归，并证明测试对此盲、A/B 能检出）。
5. **启动期可变绑定改用 `ServerRuntimeState` 具名属性**（`alwaysOn` / `cron` / `server` / `broadcast`）。
   原实现是 `main` 闭包里的 `let`：热重载整体替换 alwaysOn/cron，其余调用点在**事件发生时**读
   `serverRef` / `deferredBroadcast`。读取时机逐处不变——`broadcast` 在 server 就绪前是 no-op，
   等价于原 `deferredBroadcast?.()`；`buildCron` 的 `onResultDelivery`、适配器热重载、
   `setPrepareWeixinLogin` 读的仍是当时的最新绑定。
6. **`configStore.subscribe` 之前先建好重载回调**。原实现是两个函数声明（有提升，可写在订阅之后），
   工厂化后必须提前声明。工厂创建本身无副作用（只返回闭包），`subscribe` 也只是往 Set 里加监听
   （`PilotConfigStore.subscribe` 不立即回调），故不改变可观测行为。
7. **`updateCommand` 的仓库根推导是本次唯一非逐 token 改写**：原 `handleUpdateCommand` 在
   `dist/src/cli/sati.js`，`__filename` 的目录向上三级即仓库根；搬到 `dist/src/cli/commands/` 后
   必须向上四级。抽成 `resolveUpdatePaths(moduleUrl)` 直测钉住层数（负控制 2 证明：少一级会落到
   `dist/scripts/update.sh`）。该推导在**两种布局**下的行为与原实现一致（编译产物下正确；
   `tsx` 直跑源码时同样多上一级——原实现即如此，本改动未引入新差异）。
8. **`createProjectTools` 的「注册 → 并入 extraTools → 域裁剪」顺序保持原样**。域裁剪必须最后做
   （主会话/子代理/团队成员从同一份注册表派生），且 `patentVerdict` 与裁剪结果要一并回传，
   故两者留同一个函数里，不按「建表 / 裁剪」再切一刀。
9. **`buildRouterEventBus` 的 250ms 批量 flush 与三处 best-effort catch 原样保留**。events.jsonl
   仅供人工审计、无程序化消费路径，尾部丢失是显式取舍（每处 catch 都写明失败语义），
   本次不改变该契约。

## Alternatives considered

- **只把 `server` 分支整段搬进 `serverCommand.ts`（判据字面最小解）**：`sati.ts` 能降到 ~570 行、
  也满足 file ≤600，但会**原样搬出一个 490 行的新 god function**——`main` 642 消失、`runServerCommand`
  490 出现，M1（≥400 归零）一步没走。否决。
- **把 `main` 留在 `sati.ts`、只导出 `COMMANDS` 供测试**：`sati.ts` 顶层 `main()` 会随 import 执行，
  测试要么真的跑起 CLI、要么只能测「键集」而测不到 `resolveCommand` 的原型链守卫。否决。
- **按「一个子命令一个文件」细分 `gateway` / `config` / `browsers` / `chat` / `hooks` /
  `patent-search`**：这六个分支各 4–14 行，且已委派给 `commands/` 下的模块；再套一层文件只会
  增加模块数而不减少任何函数体。保留在分发表里内联。否决。
- **把 `ServerRuntimeState` 换成「传值 + 显式回写」**：需要把 `alwaysOn` / `cron` / `server` 的
  每次写入点都改成对调用者的写回调用，行数不减反增，且丢掉了「事件发生时读最新绑定」这一原始语义。
  否决（沿用仓库既有先例：`ProjectRuntimeFactoryDeps` 的 `getGateway` / `setRouterEventBus`）。
- **把 `serverCommand.ts` 的启动尾段也抽成 `runServerUntilExit`**：能再拆 ~90 行，但会为
  「线性编排尾段 + 关闭接线」这两件强耦合的事引入一层需要传 10 个依赖的间接。`runServerCommand`
  215 行已远离 M1/M2 红线。否决。
- **`createProjectTools` 再拆「建表」与「域裁剪」**：`patentVerdict` 是裁剪的输入、又要在运行时
  对象里留档，拆开就得把判据对象在两个函数间来回传；132 行不构成问题。否决。
- **顺手把 `patent-search` 补进 `--help`**：属用户可见输出变更（计划 §1.2 明确不做行为变更），
  改帮助文本会改变 `sati --help` 的逐字节输出（A/B 对照物即失效）。改为**登记**：见 Impact。

## Verification

- **CLI A/B 逐字节对拍**：/tmp harness（未入库，方法记录于此）对 **27 组调用** 分别跑 base 树
  （`main`，`f4d11e7d7`）与本次改动树，逐字节比对 stdout + stderr + 退出码，每棵树用独立临时
  `SATI_HOME`（内容相同的 `sati.yaml`）。**归一化后 27/27 全等**（归一化仅抹掉必然随树/进程变化的量：
  临时 home 路径、`node:<pid>`、git 短哈希、耗时）。覆盖：`--version` / `-v` / `--help` / `-h` / `help`、
  `gateway`（无子命令与错子命令）、`cron`（无 server / list / create 缺参 / delete 缺 id）、
  `skills`（无子命令 / 错子命令 / 未知来源 / dry-run `--json`）、`hooks`（无子命令 / list / 错子命令）、
  `chat`（无参 / 无命中查询）、`patent-search`（无参）、`browsers --json`、`config`（无子命令 /
  set 缺值）、`tui`（非 TTY）、`update --check`、未知命令。**首轮 A/B 曾报 3 处差异**：1 处真实回归
  （见决策点 4，已修）＋ 2 处噪声（临时路径 / PID，已归一化）。
- **项目运行时装配指纹 A/B**：临时脚本经真实 `createLocalGateway` 解析项目运行时，dump **25 行**
  指纹（工具名清单与域、工具数、专利判据、运行时键序、记忆/知识库/后台任务/路由存在性、
  `knowledgePaths` 归属、embedding/rerank 能力开关、`projectStorage`、快照的 agent.model /
  visibleDomains / builtinPluginsEnabled / diagnostics、二次 resolve 缓存同一性）。
  归一化临时路径后 **base 与改动树 25/25 逐行相同**；同树复跑亦相同（确定性校验通过）。
- **负控制 7 处**（前 6 处让**预期**用例转红，第 7 处暴露测试盲区）：
  1. 查表去掉 `Object.hasOwn` ⇒ `resolveCommand` 用例红（原型链键命中）；
  2. `update` 路径少一级 `..` ⇒ 该文件 2 条用例全红；
  3. `readStringFlag` 去掉「拒绝 `--` 开头值」⇒ 对应用例红；
  4. `broadcast` 去掉未就绪守卫（改 `state.server!`）⇒ no-op 用例红；
  5. `stop` 去掉 catch（改为抛出）⇒「失败可见」用例红；
  6. 未知 skills 来源改为静默 `continue` ⇒ 抛错用例红；
  7. **`sati tui` 的 TTY 检查挪到 import 之后**：测试复跑仍 **18/18 全绿**（盲区），而 CLI A/B 的
     `tui` 用例检出 `ExperimentalWarning: SQLite` 多出一行 ⇒ 证明 A/B 与测试覆盖不同失效类型。
  还原后复跑回到 18/18 全绿。
- **新增直测**：`tests/cli/cli-command-dispatch.spec.ts`（5 例：键集固定、帮助↔分发表不漂移、
  原型链键不命中、`--version` 短路的三种拼写、`--help` 的三种拼写）、
  `tests/cli/cli-flag-parsing.spec.ts`（5 例）、`tests/cli/update-command-paths.spec.ts`（2 例）、
  `tests/cli/cli-skills-command.spec.ts`（3 例）、`tests/cli/server-command-lifecycle.spec.ts`（3 例）。
  共 18 例；其中 `update-command-paths` 刻意只做算术（喂合成 `dist/` URL），不依赖测试跑在
  `src/` 还是 `dist/`——首版用 `import.meta.url` 现推，在 tsx 直跑源码时基线即红（负控制 harness 发现），
  已改为布局无关。
- **事件矩阵**：`pnpm gen:event-matrix` 后 `--check` 绿；diff **仅 2 行**，且都是**同一生产者换文件**
  （`agent_status`: `projectRuntimeFactory.ts:159` → `projectRuntimeRouterEvents.ts:128`；
  `error`: `sati.ts:971` → `commands/fallbackGateway.ts:13`），生产者/消费者计数与其余行逐条不变。
- **门禁**：`pnpm check` EXIT=0（含 `check:event-matrix` / `check:techdebt-metrics` /
  `check:architecture-boundaries` / `check:doc-claims` 全 fresh）；`pnpm test` EXIT=0
  （`# tests 5604 / # pass 5599 / # fail 0 / # cancelled 0 / # skipped 5`——5 条跳过为既有
  环境型跳过：本地法律库 schema 不匹配 1、非 CI 的 graphviz 门槛 1、未录制的
  `patent_drafting_v1` fixture 1，均未因本次改动变化）；`pnpm test:pr-tooling` 197/197。
- **指标**：`pnpm measure:update` → God function 榜移除 `sati.ts|main|642`、
  `projectRuntimeFactory.ts|createProjectRuntimeResolver|428`、`|resolve|320`，**无新增条目**：
  ≥300 行 **54 → 51**、≥400 行 **27 → 25**（300–399 档 27 → 26）。
  `check-architecture-boundaries --update-baseline` 打印存量豁免 **42 → 41**（`src/cli/sati.ts`
  脱离棘轮，其余条目行数未变）——即 M3「file-size 存量豁免 42 → ≤20」的 1/22。
  `src` TS 文件 1090 → 1106、行数 189499 → 189961；tests 文件 636 → 641；
  `docs/code-facts.md` 的 `src/cli/` 文件数 30 → 46。
- **函数行数（本次直接量测，TS AST）**：`sati.ts` 无 ≥40 行函数；`createProjectRuntimeResolver`
  428 → **77**、`resolve` 320 → **73**；新增最大函数为 `runServerCommand` **215**、
  `createProjectTools` 132、`createKnowledgeResolverLayer` 107、`createRouterEventBus` 80（原
  `buildRouterEventBus` 同尺寸）、`createSubsystemBuilders` 67、`createSubsystemReloader` 52。
  全部文件行数 ≤ **248**（`commands/serverCommand.ts`），远低于 600 判据与 800 棘轮。
- **未验证的部分**：真实 `sati server` 的端到端启动（起 gateway + web + 真 tmux/Chrome 依赖）
  未在本机跑；该路径由 `tests/cli/knowledge-env-threading.spec.ts`（经真实 `createLocalGateway`
  断言 env 穿透与知识库出口）、`tests/cli/project-runtime-registry-list-sessions.spec.ts`、
  `tests/cli/team-subsystem-scan-failure.spec.ts`、`tests/cli/task-resume-scan-logging.spec.ts`
  与全量 `pnpm test` 间接覆盖。CLI A/B 的 `unknown-command` 用例（会真的构造本地 gateway 并启动
  交互式 CLI）在两侧都在 30s 超时点被 SIGTERM 终止、输出一致——属「两侧同形」，不是「功能已验证」。

## Impact

- 计划条目：P2.7（`cli/sati.ts:main` + `cli/projectRuntimeFactory.ts`）交付；P2 批次剩
  P2.8（`TuiApp`）、P2.9（`webMessage` + `ToolRuntime`）、P2.10（`inventiveness`）。
- M3 进度：file-size 存量豁免 42 → 41（`src/cli/sati.ts` 脱离棘轮）。
- 遗留登记（未处置，交后续条目）：
  1. `sati patent-search` 可用但**不在 `--help`**（帮助文本 ↔ 分发表唯一的不一致，本次为
     保持 `--help` 输出逐字节不变而**不动帮助文本**，已在 `commandDispatch.ts` 头注释与本 note 留痕）。
  2. `sati update` 在 `tsx` 直跑源码（`pnpm server` / `pnpm skills:migrate` 的用法）时仓库根推导
     会多上一级——**原实现即如此**（三级推导只对编译产物布局正确），非本次引入，未顺手改。
