# Sati 技术债务活账本

> 定位：Sati 技术债务与异味代码的**唯一事实源**（活账单）。取代会过时的快照式报告（如 `docs/technical-debt-report.md`、`docs/code-refinement-report.md`）。
>
> 用法：审计时在 `backlog.md` 登记/更新条目；每季度（或大版本）跑 `node scripts/measure-techdebt.mjs --update docs/technical-debt/metrics.md` 刷新指标趋势；修复完更新条目状态与指标。

> **审计状态（2026-08-23）**：全仓库逐模块扫描完成（B1 agent/router/tool/gateway/session · B2 context/model/patent · B3 adapters/always-on/knowledge/mcp/rule/workflow · B4 小模块 · B5 ui/ui-server/tests+scripts/desktop · B6 横切收口）。`backlog.md` 共 **199 条**带证据条目，修复排期见 §29 横切收口 C 节。

## 目录

| 文件 | 内容 |
|---|---|
| `backlog.md` | 债务清单（活账本），按模块分节，每条含严重级/位置/影响/建议/状态 |
| `metrics.md` | 可复现指标基线与趋势（由 `scripts/measure-techdebt.mjs` 生成） |
| `next-batches-schedule.md` | 后续批次专项排期建议（阶段化顺序、爆炸半径、浏览器验证、硬截止） |
| `README.md` | 本文件：方法论、清分级规则、如何保持新鲜 |

## 审计方法论

**广度自动化 + 深度人工 双轨**。每类债务都必须给可复现命令与证据，不凭感觉下结论。

### 类别与检测手段

| 代码 | 类别 | 检测手段 |
|---|---|---|
| A | 体积/复杂度 | `wc -l` Top 文件；TS AST 单函数 > 阈值；平均行/函数 |
| B | 类型安全 | 类型位 `any`（TS AST）/ `@ts-expect-error` / `@ts-ignore` / `as unknown as` 双重断言（TS AST，独立口径）按模块聚合 |
| C | 错误 & 可观测 | 裸 `console.*`、空 `catch {}`、无参 `catch {}`（区分总数与**无注释隐患类**）、`TODO` |
| D | 架构/分层 | `ui/server→src` 深层导入、`src→ui`、循环依赖、protocol/runtime/config 三层符合度 |
| E | 测试 | 模块测试分布、主链路文件无直接单测、伪测试（`readFileSync`+正则扫源码） |
| F | 死代码/重复 | codegraph 可达性找未引用导出、品牌残留、同能力多套实现 |
| G | 依赖/安全 | `pnpm audit`、override 冗余、版本并存 |
| H | 文档漂移 | CLAUDE.md 声明 vs 实际、i18n en/zh-CN key 对齐、注释引用已删代码 |
| I | 性能 | 巨型组件、未虚拟化列表、每轮重复构建/未缓存检索、UI chunk 体积 |

### 复现命令

```bash
# 全量指标（JSON）
node scripts/measure-techdebt.mjs --json

# 刷新指标文档（记录历史趋势）
node scripts/measure-techdebt.mjs --update docs/technical-debt/metrics.md

# 校验基线是否与当前工作树一致（非 0 退出 = 已过期；`pnpm lint` 已挂接）
node scripts/measure-techdebt.mjs --check docs/technical-debt/metrics.md

# 依赖安全（可选，需 registry 可达）
pnpm audit --registry https://registry.npmjs.org/

# 静态门禁
pnpm typecheck && pnpm lint && pnpm format:check
```

### 指标口径说明（重要）

> **2026-09-16（#341）catch 口径纳入 `ui/server`、vendored 子包整体移出文件级指标**：两处缺口都会让排期建立在假数字上。
> ① **catch 口径漏掉整个 `ui/server`**（105 文件 / 31,483 行）——「空 `catch {}`」长期报 **0**，而 `ui/server/utils/plugin-loader.js:299` 实有一处；同为「错误 & 可观测」类的 `console` / `todos` 早已含 `ui/server`，**两套口径自相矛盾**。纳入后：空 catch `0 → 1`、无参 catch `517 → 684`（`ui/server` 持 175）、其中**无注释隐患类 `40 → 124`**（`ui/server` 持 84）。注意 issue 引用的「catch = `src + ui/src`」是**如实声明**（基线表口径），所以这不是实现与文档不一致，而是**口径本身选错了**。
> ② **`edgeclaw-memory-core` 是外部搬入的记忆内核**（自带 `package.json` / `tsconfig` / 独立 `build`·`test`，不随本仓演进），其 `src/` 与 `tests/` 下的 49 个 `.ts`（16,682 行）此前计入 `src`，并在「Top 大文件」「God function」两张**排期表**里各占 3 席。现按**路径前缀**（`VENDORED_SUBTREES`）整体移出文件级指标，改在 `metrics.md` 新增的「vendored 子包」节单列（规模 + 自身 Top 文件 + ≥300 行函数数）——**单列而非删除**，否则「已单列」与「该目录被删了」在输出上不可区分。规模随之 `1078 / 186146 → 1029 / 169464`。
> **跨此日期的同比须按同一口径重算**；`TD-METRIC-003` 已销项，决策见 `docs/notes/implemented/2026-09-16-metric-scope-fix.md`。
> - 勘误：issue 把 `lib/`（编译产物）与 `ui-source/app.js`（2324 行 memory-dashboard 资产）也列为污染源，实测**两者自脚本首版（`4d83bda7f`）起就由 `EXCLUDE_DIRS` 的目录名豁免覆盖**（`ui-source/app.js` 从未进过 Top-30）；真正在污染的只有 `src/` + `tests/` 下那 49 个 `.ts`。
> - **无注释无参 catch `40 → 124` 是口径变更而非新增债务**：#353 的治理目标据此上调为 124，其「回升超过 45 即立项」的触发条件随之满足（见该 issue 结论）。
> - 仍未覆盖：God function 表含测试文件的匿名箭头函数（`TD-METRIC-004`）；`ui/src` 的 `.js` / `.jsx` 未进入任何文件级扫描（C39 已记录）。

> **2026-09-15（#340）文件清单改为 git 感知**：所有指标此前用 `readdir` 遍历**工作树**，会把 `.gitignore` 忽略的文件计入（本仓实测 `tests/**.test.ts` 5 个、wiki 下若干 md），而它们在 CI 检出树里不存在——同一份代码在开发机与 CI 上算出**不同的数**（532 vs 527 个测试文件），指标不可复现。现统一走 `git ls-files --cached --others --exclude-standard`（= 已跟踪 ∪ 未跟踪但未被忽略），使「本机 = CI」。跨此日期的同比须注意：`tests 文件` 532 → 527、`测试覆盖合计` 515 → 510、`知识卡重复` 72 组 → 70 组。

> **2026-09-11（C42 终审）口径已对齐**：此前所有指标一律只扫 `src/`，与 `docs/code-refinement-plan.md` §六 基线表声明的 `src + ui/src` / `src + ui/server` 不一致——C40/C41 两张横切卡都不得不先自建扫描重建口径才能定目标（见 C41 note「遗留口径问题」）。现已按基线表对齐，`metrics.md` 顶部输出「指标口径」表，`--json` 亦可读出 `scopes` 字段。**跨 2026-09-11 的同比须按同一口径重算。**

- **`any` 指标已从裸正则改为 TS AST 精确统计**（`scanTypeEscapes`）：旧正则 `: any | as any | <any> | any[]` 两个方向都不准——**高估**（注释/字符串里的英文单词 "any"，如 `SnipEngine.ts:64` 的 "any tool_call"）且**低估**（泛型位 `Record<string, any>` 文本不含 `: any`，被漏掉）。现在只统计真正的类型位 `AnyKeyword` 节点 + `@ts-expect-error`/`@ts-ignore` 指令，`src + ui/src` 实测 **3 处**，与 C40 逐处 `SAFETY` 登记的保留清单完全一致（互为交叉验证）。真正的类型债是强转与断言（`as never`/`as unknown as X`/`as string[]`/`!`，见 `backlog.md` TD-TYPE-002）——其中 `as unknown as X` 已单列口径，见下条。
- **`as unknown as X` 双重断言：2026-09-15 起单列独立口径 `asUnknownAs`**（issue #339）。此前上条三口径（`AnyKeyword` 节点 + `@ts-*` 指令）**全部落在「类型位 / 指令」上**，而双重断言**两类痕迹都不留**——它既不是 `AnyKeyword` 节点，也不是 `@ts-` 指令，实测 `src + ui/src` **27 处一处未被计入**（`src` 8 · `ui/src` 19）。后果不是少一个数字：仪表盘曾把「类型纪律很好」（`any` 仅 3 处）与「27 处绕开全部类型检查」**并列**呈现，直接误导排期。**不与 `any` 合并计数**——`any` 至少会传染、可被 lint 规则捕获，双重断言一次性绕开全部检查且不留痕迹，属**更强**的逃逸，两者治理成本与语境不同。
  - **作用域与 `unsafe` 一致**（`src + ui/src`，含同址 `*.spec.*`），不含 `tests/`。**口径交叉核对（重要）**：`#339` 标题里的「329 处」来自 `grep -rEn 'as unknown as' src/ ui/src/`，但该命令**写错了作用域**——`tests/` 不在 `src/` 下，而 issue 正文的分布表列的恰是 `tests/*`（`tests/tool 49`、`tests/gateway 46`…）。按正确作用域实测为 `src` **8** · `ui/src` **19** · `tests/` **294**（合计 321）——issue 的 329 是「`src` + `ui/src` + `tests/`」的合数，与工具声明的 `src + ui/src` 口径本就不可比（数字亦随 09-14 之后的提交漂移）。若日后要把测试文件的逃逸也纳入治理，应比照 `todos` 另立作用域，而非改动本口径。
  - **口径变更（0 → 27）来自度量口径变更，而非新增债务**——趋势图据此标注，勿与历史快照直接同比。
- **无参 `catch {`** 拆成两个数：**总计**（未绑定错误变量；仓内 try 体几乎全是 `JSON.parse`/`fs.*`/`new URL`，删 try 会改变行为，故该计数在行为不变前提下不可降）与 **无注释**（隐患类，唯二治理目标）。判定「有注释」认三种形态：catch 行内、catch 上一行、体内（独立注释行或代码行尾注释）。
- 旧版「静默吞错 catch（体仅注释/空白）」指标**已废弃**：它把**已在函数 JSDoc 说明意图的防御式**与真无说明的静默回退混计（C41 发现并修正）。无参 catch 的意图注释形态统一为「失败模式 → 回退语义」。
- **裸 `console.*` 仍是正则上界**：会把**注释掉的**调用计入（如 `ui/server/sessionManager.js` 5 处 `// console.error(...)`）；C39 刻意建立的两处收束入口（`ui/server/utils/consoleLogger.js`、`ui/src/utils/logging.ts`）已豁免。收束后 `src/` 真实裸调用 143 处全部按设计豁免（CLI 交互/二维码/`debug.ts`/telemetry 入口）。
- i18n / 测试覆盖 / 分层边界为精确值，可直接使用。

## 严重级定义

| 级别 | 含义 | 处置 |
|---|---|---|
| P0 | 堵塞：阻塞合入、可致错误决策或数据损坏 | 立即 |
| P1 | 高：主链路性能/可维护性明显受损 | 短期排期 |
| P2 | 中：局部可维护性/可观测性受损 | 按 Sprint 排期 |
| P3 | 低：风格/文档/次要卫生 | 顺手清理 |

**这张表是唯一事实源，issue 模板不另立一套**：`.github/ISSUE_TEMPLATE/tech_debt.md` 的「严重级」勾选项就是上表四行（级别词 + 含义 + 处置），由 `scripts/classify-issue.mjs` 翻译成 `priority: pN` 标签（#406）。模板与标签词表的双向一致由 `pnpm check:issue-labels` 守（写成 `P4` 会被拦下而不是静默丢弃），因此**改本表就要同 PR 改模板**——两处是同一份词表的两个落点，不是两份设计。

## 工作量定义

`S` ≤ 半天 · `M` 1–2 天 · `L` > 2 天（专项，需单独排期）

## 状态机

`new` → `triaged`（已复核/分级）→ `in_progress` → `done` / `wontfix`

- `done`：附对应 commit/PR。
- `wontfix`：写明理由；若属设计使然（非缺陷），按 AGENTS.md 铁律 7 在 `docs/notes/` 记一条 decision note（含 `## Alternatives considered`）。

## 如何保持新鲜

1. **门禁强制（2026-09-15 起，issue #340）**：`pnpm lint` 链尾挂着 `pnpm check:techdebt-metrics`
   （= `measure-techdebt.mjs --check docs/technical-debt/metrics.md`）。它把**当前工作树的重算结果**
   与磁盘上的基线正文逐行比对，不一致即非 0 退出。**改了任何会影响指标的代码（含新增 i18n key、
   新增测试文件、口径变更）后，须在同一 PR 内跑 `pnpm measure:update` 刷新基线**——否则 CI 会红。
   - 比的是**整篇正文**而非少数几个数：正文全部由本脚本生成，全量比对最简单也最严，且新增指标时
     不必再维护「关键指标白名单」（白名单本身会成为下一个漂移点）。
   - 快照时间戳与「历史快照」段不计入比对（前者隔日必变、后者是历史记录）。
   - **口径变更须与基线刷新同 PR 落地**：改了 `SCOPE_DOC` / 指标定义却不同步刷新基线，会让门禁
     在下一个人的 PR 上才炸，届时难以定位。
2. 每季度或大版本重跑一次 `pnpm measure:update` 复核趋势（门禁已保证「不静默失真」，这一步是
   为了**留档趋势**而非防止失真）。
3. 新功能引入新债时顺手在 `backlog.md` 加一条（或触发一次测量对比）。
4. 修复项标注 `done` + commit/PR；指标随脚本复核回落。
5. **计划文档的状态也要回填**（2026-09-18 起，issue #359）：`docs/superpowers/plans/*`、`openspec/changes/archive/*/tasks.md`、`docs/*-plan.md` 是任务推进的历史快照，**任务交付时同 PR 把对应条目的勾选与实施备注回填**。不回填的代价是可复现的：审计者读到「未勾选」会以为没做，于是每条线索都要「文档说没做 → 去代码核实 → 发现做了」往返一次，成本随文档数量线性增长（2026-09-18 的批量复核在 21 份文档里清出 559 处悬空勾选）。若一份文档已整体失效（被后续方案取代），在文件头写清「被谁取代」，而不是留着旧勾选。约定正文见 `docs/issue-management.md` §6。
6. **账本条目标注「最后复核」日期**（2026-09-23 起，issue #528）：**新增或复核过的条目**须写 `最后复核：YYYY-MM-DD`（表格列或严重级行）。**为什么**：账本的失效形态不是「写错了」，而是「**没人知道它多久没被核过**」——2026-09-23 的复扫实证了 ≥8 条状态滞后（条目仍标 `new` 而 issue 已交付、代码已修）与 3 条影响数量级失准（如把判例语料的「~4ms/行」平移到只有 96 部法规的语料上），而这些条目的滞留时长在账本里不可见，任何后续审计都无法区分「上周核过」与「半年前核过」。**字段不追认历史**：不补写过去的日期，只从 2026-09-23 起对新增/复核条目生效——否则会伪造出成片的复核记录。约定首节见 `backlog.md` §37.5，载体归属见 `docs/issue-management.md` §6.1（「交付即回填」的分流清单），决策记录见 `docs/notes/implemented/2026-09-23-techdebt-backlog-recheck.md`。

> **为什么上这道门禁**：基线此前只能手工触发刷新，没有任何机制保证它与工作树同步。2026-09-14
> 的审计实证了后果——基线停在 09-11，`src/cli/createLocalGateway.ts` 声称 2696 行而实际 448 行，
> `createLocalGateway`/`prepareSessionRuntime`/`createReadFileTool`/`handleModelError` 四条 god function
> 表项早已不存在，而债务排期的优先级正是建立在这些数字上。

## 边界与约束（审计时遵守）

- **只读登记**：审计只登记、不修改源码；避免破坏 llm-replay fixture（任何工具 inputSchema 改动含描述都会使 replay fixture 失配）。
- **内部文案**：新用户可见文案必须提取到 `ui/src/i18n/locales/{en,zh-CN}/`（AGENTS.md 铁律 4）；审计只登记缺失，不擅自补译文。
- **安全项**：既有设计（令牌比较非常时、WS 无 Origin 校验等）只登记风险与决策，不改行为。
