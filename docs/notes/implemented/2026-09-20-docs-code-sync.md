# Agent Note: 文档↔代码一致性审计与「文档事实层」门禁

Status: implemented

## Problem

仓库的文档体系是**分层失配**的：

- **有门禁的层是新鲜的**——`docs/event-producer-consumer.md`、`assets/workflows/patent/generated/*.yaml`、`docs/technical-debt/metrics.md`、协议台账 `version.ts`、`skills/**`、`.github/labels.yml` 均由 `--check` 门禁守着，2026-09-20 实测 9 个门禁全绿。
- **没有门禁的叙述层在漂移**——根 `README.md` 的版本号停在 `0.1.4`（实际 `0.2.2`）、`CLAUDE.md` 把协议写成 `1.8`（实际 `1.10`）、把专利域工具写成「23 个」（实际 26）、把输出门禁加载的规则集写成「仅 `compliance.yaml`」（实际已接入 nuo 的 9 条 `keyword_blocklist` 规则，**语义写反**）、`docs/src-directory-structure.md` 的模块清单漏列 5 个实际存在的模块并保留已删除的 `workflow`、多篇 plan 文档的状态头与自身勾选表冲突。

根因不是「谁忘了改」，而是**这些事实没有唯一的机器可读来源**：版本号散落在 3 处 package.json + README + CHANGELOG，计数靠人手抄，目录清单靠人手维护。

顺带发现两处**代码**缺陷（非文档问题）：`ui/src/i18n/config.js` 的 zh-CN 资源表漏注册 `tasks` 命名空间（`ns` 列表与两个语言包都声明了它；该命名空间当前**无消费者**，所以没有可见症状——但只要有人第一次用 `t(k, { ns: "tasks" })` 就会静默回落英文）；`scripts/gen-event-matrix.ts` 的 `EVENT_TYPE_FILES` 里 `WsFrame` 条目指向不存在的类型名（静默无效果，门禁全绿但覆盖为零）。

## Decision

1. **建立「文档事实层」并纳入门禁**：新增 `scripts/gen-doc-claims.ts` + `scripts/doc-claims/resolvers.ts`，生成 `docs/code-facts.md`（版本矩阵 / 计数矩阵 / `src/` 模块索引 / 门禁与 CI 清单）。工具数与专利域工具数取**运行期注册结果**（无参 `createBuiltinRegistry().list()`），不靠 AST 近似；协议与事件数解析既有门禁的产物（不重复实现校验逻辑）。`pnpm check:doc-claims` 挂进 `pnpm lint` 链，`--check` 报出「哪个文件第几行过期」。
2. **叙述文档用行内 claim 标记引用事实层**，不再手写数字（`README.md` / `README.zh.md` / `AGENTS.md` / `docs/development-standards.md` / `docs/src-directory-structure.md` 首批接入）。
3. **模块索引改为生成 + 强制登记**：新增 `src/` 模块若未在 `MODULE_NOTES` 登记一行职责，解析直接抛错——模块清单不可能再漏列。
4. **只登记低频事实**：刻意**不**把 `AgentLoop.ts` 行数、测试文件数这类几乎每个 PR 都会变的数字进表（会让无害改动被门禁拦下）；行数基线继续由 `metrics.md` + `measure:update` 负责（`docs/technical-debt/metrics.md`）。
5. **修代码缺陷**：补 zh-CN `tasks` 资源注册（含 `ui/src/i18n/config.i18n.test.ts` 断言三方一致 + `scripts/check-i18n-namespaces.ts` lint 门禁 + 负控制 `tests/scripts/i18n-namespaces.spec.ts`）；修 `gen-event-matrix.ts` 的死条目并让表头从单一 callee 列表派生（消掉第二份手写副本）。
6. **domain 双约定只锁现状、不做批量改写**：26 个专利域工具中 19 个 creator 自标、9 个依赖注册表 `annotate`，实测**无冲突**，故只加一致性对拍（`tests/tool/registry/domain-annotation-parity.spec.ts`：AST 声明数 == 运行期 `domain==="patent"` 数）+ 文档写明「以注册表 annotate 为唯一判定源」，不为了统一去改 19 个文件。
7. **状态回填**：8 篇 plan 文档的状态头（含「只做设计，不实施」而实际已落地 3 篇）、6 处 openspec `## Purpose: TBD`、`docs/notes/proposed/` 唯一一条已落地的提案迁入 `implemented/`、技术债账本与 `next-batches-schedule` 加数字口径说明。

## Consequences

- 版本/计数/模块索引三类漂移此后**改一处即红**：`pnpm check:doc-claims` 会指名文件与行号，`pnpm gen:doc-claims` 一键回填。
- 新增 `src/` 模块多了一道登记手续（写一行职责），换来模块索引不再漏列。
- 新增测试文件、改 `AgentLoop.ts` 等高频改动**不会**触发文档门禁（刻意排除）。
- `CLAUDE.md` 仍不入库、仍不受门禁覆盖；它的头部现在声明「事实层以 `docs/code-facts.md` 为准」，本地数字与事实层冲突时以事实层为准。
- 附带发现但未处置：`locales/{en,zh-CN}/tasks.json`（各 94 键）当前**无任何消费者**（无 `useTranslation("tasks")`、无 `tasks:key` 引用），疑为已下线的 TaskMaster UI 残留；是否删除属产品判断，未在本次动手。
- 未做（明确留给后续）：`docs/` 信息架构重构（索引/归档/front-matter）、README 与 README.zh 内容重复的处置、技术债账本各节的逐条数字回填（只加了口径说明与实测样例）。

## Alternatives considered

1. **只手工改数字（不改机制）**——最小改动，但审计已证明同类漂移反复发生（协议版本落后两个 MINOR、工具数落后 3 个、模块清单漏 5 个），改完下次照旧。
2. **把所有文档都改成生成物**——叙述性文档的正文是判断与背景，生成器写不出来；只把数字层抽成生成物 + 标记引用是可行的最大公约数。
3. **用 AST 静态计数代替运行期实例化**——`createBuiltinRegistry` 有 20 个条件分支（`options?.x !== false` 与 opt-in 两种语义），静态近似会随分支增删悄悄失真；实测运行期实例化只需约 10ms，代价可忽略，且由 `tests/scripts/doc-claims.spec.ts` 对拍 AST/运行期两侧。
4. **把 `CLAUDE.md` 收进仓库并纳入门禁**——与既有约定「本地全量指南不入库」冲突（`.gitignore:220`），且会让本地笔记类内容进入 PR 流程；改为「入库事实层 + 本地指南引用」。
5. **把测试文件数 / AgentLoop 行数也做成 claim**——实现时试过，`pnpm check:doc-claims` 立刻因「新增一个 spec 文件」而红；这类数字的收益远小于每次无害改动的摩擦，故移除（行数交由 `metrics.md`）。
6. **统一 19 个 creator 的 `domain` 自标注**——现状无行为差异，批量改写属「动不该动的代码」；只加对拍门禁锁住「自标不得与注册表标注冲突」这一真实风险。
