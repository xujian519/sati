# Agent Note: 低成本阻塞项批量处置（Windows 打包资产 / TRIZ fail-safe / 门禁测试挂载）

Status: implemented

## Problem

三条独立缺陷，共同点是「后果真实且严重，但修复面很小」——单独开 PR 会各自付一次
10–15 分钟的 CI 与串行合并代价（main 为 `strict: true` + `enforce_admins: true`），
故合为一个 PR、三条 commit。

### 一、#349 Windows 打包缺 `dist/assets`、`skills`、`rules`

`sati-main-bundle.tar` 的清单（`build-win.bat:396`）是
`src dist\src scripts node_modules vendor package.json tsconfig.json`，
而 macOS 侧 `release.sh:554` 的 `PDM_ITEMS` 是
`src/ dist/src/ dist/assets/ scripts/ skills/ rules/ node_modules/ vendor/`。

**核对后发现问题比 issue 描述的更靠下**：这不止是「清单少列三项」。macOS 走的是根
`pnpm run build`（`release.sh:430-431`），而后者的脚本体里含 **11 处 `cpSync`**——
把 `assets/templates/patent`、`assets/patent`、`assets/prompts/html`、`skills`、
`src/methodology/runtime/components/data`、`src/knowledge/patent/wiki`、
`src/knowledge/patent/ipc-standards.yaml`、`src/patent/figure/symbols/electrical-symbols.yaml`
等**非 TS 资产**搬进 `dist/`。`tsc` 只处理 `.ts`/`.tsx`。

而 Windows 的 Step 7 只跑裸 `npx tsc` + 一处 `xcopy`（`extension/plugins/builtin`）。
于是 Windows 上 `dist/assets` 与 `dist/src/**/data` **根本不存在**——即使把三个目录名
加进 tar 清单，`dist/assets` 仍是空的。

运行时消费点（均从 `dist/` 的模块位置解析）：

- `src/patent/document/templateResolver.ts:12-25`：候选 1 即 `dist/assets/templates/patent`，
  以 `manifest.json` 存在为准。Windows 缺 → `render_patent_document` 的 5 个文书模板全失效。
- `src/rule/runtime/asset-location.ts:34,49,69`：`packageRoot()` 向上找 `package.json`，
  打包后即 bundle 根，取 `<root>/rules/patent`。Windows 缺 `rules/` → 输出门禁规则链
  **静默**退化为纯关键词匹配（合规性质降级，且用户零提示）。

### 二、#361 TRIZ 数据读取无 fail-safe，打断整轮对话

`triz.ts` 的 `loadMatrix` / `loadPrinciples` 直接 `readFileSync` + `JSON.parse`，
无 try/catch；注入链 `methodologyInjection.ts:47` → `modelRequest.ts:156` 全程无守卫。
数据缺失或损坏时异常穿透到模型请求构造，**整轮对话失败**。

这是本次审计中唯一「用户发一句话、整个回合失败」的缺陷，且与同仓既有约定矛盾：
`modelRequest.ts:76-79` 的账本读有 try/catch 且注释写明 `Ledger read must never block the request`。

### 三、#333 `test:pr-tooling` 无 CI 挂载点

`.github/workflows/ci.yml` 的 `quality` job 只单独跑 `check-pr-issue.test.mjs`；
`pr-tooling` 中的另外 4 个文件（`open-pr` / `sync-labels` / `classify-issue` / `measure-techdebt`）
**在 CI 中永不执行**。门禁本体在 CI 里、**门禁的负控制不在**。

## Decision

### 一、把资产复制收敛为单一事实源

新增 `scripts/copy-build-assets.mjs`，以一份 `COPIES` 清单承载那 11 处 `cpSync`；
根 `build` 脚本与 `build-win.bat` **都调用它**。`build-win.bat` 的 tar 清单补
`dist\assets skills rules`，并在清单旁写明它与 `release.sh` 的 lockstep 关系与缺失后果。

两平台从此由同一处定义产物布局——漂移这一根因被消除，而不只是补上这一次的缺口。
脚本额外做了 `mkdirSync(dirname(target), { recursive: true })`，使单文件复制不再依赖
tsc 恰好建出目标目录。

### 二、双层 fail-safe

1. **根因层**：`triz.ts` 新增导出的 `readTrizData<T>(file)`，捕获读取/解析异常，
   返回 `undefined`，调用方退化为空矩阵/空原理 → 自然落到该方法自文件头注释起就声明的
   「未识别到参数对时回退为 prompt 引导 LLM 自行查表」路径。两个设计细节：
   - **失败不写入缓存**（`matrixCache`/`principlesCache` 只在成功时赋值），避免一次瞬时读失败
     被固定为进程级空态；
   - 告警**按文件去重**（`warnedDataFiles`），因为 `buildLookupLines` 会两两查表、调用次数是 O(n²)。
2. **纵深防御**：在 `computeMethodologyAddendum` 内包住 `inject` 调用。这里而非 issue 建议的
   `agentSessionConfig.ts:154-159`，理由是该函数是**全部 8 个 `MethodologyComponent` 的唯一必经点**，
   一处守卫同时覆盖 `modelRequest` 与 `cli` 两条构造链；后者只是其中一条链上的一个实现点。

### 三、整体挂载而非逐个单文件

`ci.yml` 的 `Self-test PR traceability gate`（单文件）替换为 `pnpm test:pr-tooling`，
位置从 install **之前**移到**之后**——`measure-techdebt.test.mjs` 依赖 `typescript`，
install 前跑不起来。整体挂载的直接收益是：今后新增脚本测试文件会自动进 CI，
不会再出现「测试写了但从不执行」这个同源问题。

## Alternatives considered

- **只补 tar 清单三项（即 issue 原文的处置口径）** — 落选；核对后确认 `dist/assets` 在
  Windows 上从未被生产，补清单只会让 tar 里出现一个空目录，缺陷依然存在。若不核对代码就照
  issue 描述执行，会得到「看起来改了、其实没好」的结果。
- **让 `build-win.bat` 直接调 `pnpm run build`** — 落选；根 `build` 首步是
  `rmSync('dist')`，而 `build-win.bat` 的 Step 7 先构建 `edgeclaw-memory-core` 再构建 sati-main，
  引入一次全量清空会打乱它既有的分步结构，且 `prebuild` 会重复跑 memory-core 构建。抽出复制
  脚本是更小的等价改动。
- **在 tar 里加根 `assets/` 而非修构建步骤** — 落选；`templateResolver` 的候选 2 确实会命中
  根 `assets/`，看似能用，但这会让 Windows 与 macOS 的产物布局不一致，反而制造新的漂移面。
- **两平台各写一份复制清单（保持现状，只补 Windows 那份）** — 落选；本次缺陷的根因正是
  「两份手写清单天然漂移」，再写一份只是把下一次漂移推后。
- **给 `triz.ts` 的数据目录加环境变量/注入 seam 以便测试** — 落选；为一个辅助只读路径新增
  可配置面不值当。改为导出 `readTrizData` 直接驱动失败分支（与既有的 `lookupMatrixCell` 同例）。
- **只做 `computeMethodologyAddendum` 的守卫，不改 `triz.ts`** — 落选；守卫能保证「不阻断请求」，
  但会让 TRIZ 在数据缺失时**静默失效**（连降级后的提示都没有）。两层各解决一半问题：根因层
  负责「降级到已声明的路径」，收口层负责「任何组件的任何抛错都不阻断请求」。
- **把 `triz.ts` 的告警做成每次调用都输出** — 落选；O(n²) 查表会刷屏。改为按文件去重，
  并让失败不缓存以保留「下次还能重试」的语义。
- **把 `test:pr-tooling` 挂在独立 CI job** — 落选；它会重复 `pnpm install`（本 job 已是瓶颈），
  而该测试仅约 8s，挂在 install 之后成本可忽略。
- **反向收紧：删掉 `test:pr-tooling`、只保留门禁自身的单文件测试** — 落选；
  `sync-labels.test.mjs` 是标签门禁的**全部**负控制，删掉等于让门禁继续不可信。

## Consequences

- **Windows 产物首次具备完整资产布局**：5 个专利文书模板、内置 skills、宪法规则资产。
  仍需在下次 Windows 发版流程中实跑 `build-win.bat` 验证（本机无法执行 `.bat`），
  验证点是 tar 内存在 `dist/assets/templates/patent/manifest.json`、`rules/patent/compliance.yaml`、
  `skills/`。
- **`dist/` 布局的修改点从两处收敛为一处**（`scripts/copy-build-assets.mjs`）。今后新增
  「非 TS 但运行期需要」的资产只需改这一份清单。
- **`build-win.bat` 未加 `dist/` 清理步骤**（macOS 侧由 `build` 脚本的 `rmSync('dist')` 承担）。
  残留旧产物理论上可能被打进 tar，但属既有行为、不在本次范围，另议。
- **TRIZ 在数据不可读时不再阻断请求**，行为退化为 prompt 引导；`readTrizData` 成为新的
  可测 seam（`tests/methodology/triz.spec.ts` 2 条失败分支用例）。
- **方法论注入的容错是全局的**：8 个组件中任一 `execute` 抛错都只丢弃本轮 addendum，
  不再让模型请求构造失败（`tests/agent/loop/methodologyInjection.spec.ts` 3 条用例，
  含非 Error 抛值与「一次失败不影响后续请求」）。
- **`pnpm test:pr-tooling` 全 83 用例进 CI**（此前仅 1 个文件）。该门禁在本 PR 内**立刻生效**：
  首次本地跑即红，报 `基线过期——请跑 pnpm measure:update 后重试`——因为本 PR 改了 `src/` 行数。
  已按 #340 的约定在同一 PR 内刷新 `docs/technical-debt/metrics.md`
  （`src TS 行数 184746 → 184790`，其余指标面未变：新增的是带参 `catch`，不入「无参 catch」口径）。
- **不涉契约面**：未改任何工具 `inputSchema`/`outputSchema`、`AgentEvent` 或 gateway frames，
  LLM replay fixtures 与事件矩阵不受影响（`pnpm check:event-matrix` 通过）。
