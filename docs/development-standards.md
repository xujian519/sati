# Sati 开发规范

> **定位**：本文件是 Sati 项目的开发规范**明细层**——把"规则是什么、家在哪、谁机器验证、理由是什么"一次性讲清楚。根级 standing orders 见 `AGENTS.md`（每会话必读）；日常操作流程见 `CONTRIBUTING.md`；本地 AI 助手详细指南见 `CLAUDE.md`（不入库）。
>
> **来源**：本文件基于对 Sati 实际代码库的逐项盘点，并融合两份外部参考底稿——`new-project-standards-template.md`（最小门禁集：3 门禁 + 负控制 + 元规则）与 `deepseek-harness-dev-standards.md`（四层可执行规范系统 + 阶段化迁移骨架）。两条参考的精华收敛为一句：**规范不是文档，是"文档 + 机器检查 + 决策记录"三件套**——每条规则立刻回答三个问题：它的家在哪？谁能机器验证？理由（含放弃的备选）记在哪？三者缺一就不是规范，是愿望。
>
> **状态**：本文档 §3 的"现状"列标注 `✅ 已落地` / `⚠️ 部分` / `❌ 缺口`。缺口对应的落地动作集中在 §7 的分阶段清单中。

---

## 0. 一分钟总览

四个门禁 + 三个配套纪律。现状：**已有 4 道门禁**，但缺"负控制"与"决策记录"两块底座。

| 门禁 | 命令 | 机器上保证什么 | 现状 |
|---|---|---|---|
| typecheck | `pnpm typecheck` | `strict` + `noFallthroughCasesInSwitch` + ES2022 + NodeNext | ⚠️ 缺 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` |
| lint | `pnpm lint` | 未用 import、import 顺序、react 规则 + 领域门禁 | ⚠️ 非类型感知、`any`=warn |
| format | `pnpm format:check` | Biome 格式（2 空格、双引号、分号、120 列） | ✅ |
| test | `pnpm test` + `cd ui && pnpm test` | 后端 node:test + UI vitest | ✅（无覆盖率） |

配套三件（本规范的灵魂，见 §4、§5）：

1. **负控制**：每个门禁要有一份"必须变红"的测试——证明门禁**真的在拦**，不是配置写错悄悄失效。
2. **元规则**：例外显式、事实清单生成或可验证、本地窄 / CI 全。
3. **决策记录**：非平凡变更带一条 `docs/notes/` note，强制 `## Alternatives considered`。

---

## 1. 规范分层模型（一条事实只有一个家）

融合 harness 的四层模型与 Sati 的现状。核心纪律：**同一个事实只写在一个地方**，其他层只放一行链接，防重复、防漂移。

| 层 | Sati 实际载体 | 职责 | 明确不放 |
|---|---|---|---|
| 陈述层（standing orders） | `AGENTS.md`（根，入库，每会话必读） | 每条 1–3 行的铁律 + 链接其详述家 | 故事、worked examples、从链接家重复的内容 |
| 本地 AI 指南 | `CLAUDE.md`（**不入库**，见 .gitignore） | 面向 AI 助手的全量细节：目录、命令、架构约束、历史专项结论 | 不提交；不是规范权威家 |
| 明细层（规范本身） | `docs/development-standards.md`（本文件）+ `CONTRIBUTING.md`（贡献流程） | 规则是什么、边界是什么、为什么 | 运行时/版本理由（→ 决策记录） |
| 决策层 | `docs/notes/`（`proposed/` `implemented/` `rejected/`） | 决策背景、放弃过什么、后果（防重新争论） | 迁移计划、验收清单、spec-speak |
| 实施计划层 | `docs/*-plan.md`（god-function-refactor-plan、patent-drafting-sop-plan 等） | 一次性的落地实施计划 + 验收报告 | 不是规范的长期家；计划完成即归档性质 |
| 执行层 | `scripts/*`（check-* / gen-* 门禁）+ `simple-git-hooks` + `.github/workflows/ci.yml` | 机器拒绝违规，不靠自觉 | — |
| 生成参考 | `docs/event-producer-consumer.md`、`assets/workflows/patent/generated/*.yaml` | 从源码**生成**的穷举清单，新鲜度门禁 | 手编；改了源必须重生成 |

**内容纪律**（沿用 harness，逐条适用）：

- 只写**当前状态**，不写历史：禁 "previously / now / no longer / used to / renamed"；变更故事放 commit / PR / 决策记录。
- 禁实现状态注释（"implemented!"、"future: …"）——状态会腐烂，仓库布局与 manifest 才是状态载体。
- 禁手编目录/JSDoc 复述——源或生成器是权威（Sati 已有 `event-producer-consumer.md` 与 `patent/generated/*.yaml` 两个生成器门禁）。
- 强调需要克制：bold / CAPS 到处都是等于没有；把强调留给改变行为的子句。

---

## 2. 现状盘点（调查结论）

对 Sati 仓库逐项核对两份参考底稿后的结论。**已有的门禁质量不低，缺的是"门禁的门禁"（负控制）与"决策记忆"（notes）两块底座，以及 typecheck/lint 的最后一公里。**

### 2.1 已有且机器强制（✅）

| 机制 | 载体 | 强制什么 |
|---|---|---|
| 类型 | `tsconfig.json` | `strict`、ES2022、NodeNext、`skipLibCheck` |
| Lint | 根 `eslint.config.mjs` + `ui/eslint.config.js` | 未用 import（unused-imports）、import 顺序（import-x/order）、react/hooks、`no-explicit-any`=warn |
| 格式 | `biome.json` | 2 空格、双引号、分号、trailing comma、120 列、LF |
| 提交信息 | `scripts/check-commit-msg.mjs`（commit-msg hook） | Conventional Commits（含 `release` 类型） |
| 提交前 | `scripts/lint-staged.mjs`（pre-commit hook） | staged 文件 biome format + eslint --fix，按 ui/root 分流 |
| 边界 | `scripts/check-ui-server-boundary.mjs`（挂 ui lint） | `ui/` 不 import `src/`（.js specifier 下 eslint 规则失效，用纯路径静态校验） |
| 领域门禁 | `check:event-matrix` / `check:patent-sop` / `check:patent-workflow-docs` / `check:html-templates` / `check:skills`（均挂 `pnpm lint`） | 事件矩阵新鲜度、专利 SOP 引用、workflow 文档幂等、HTML 模板、skill frontmatter |
| 测试 | 后端 `node:test`（~2800 用例）+ UI `vitest`（~500）+ Playwright e2e + `llm-replay` 无 key 重放 seam | 单元/集成/回路级 |
| 版本 | `scripts/bump-version.mjs` | 根 / ui / apps-desktop 三处 version lockstep |
| CI | `.github/workflows/ci.yml`（2 job） | typecheck/lint/format/test（root+ui）+ Windows desktop build&lint |

### 2.2 缺口（❌ / ⚠️，对应 §7 分阶段落地）

| # | 缺口 | 模板对应 | 影响 |
|---|---|---|---|
| G1 | tsconfig 缺 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`（`noFallthroughCasesInSwitch` 已于 2026-08-22 开启） | 门禁 1 | 类型系统第一道防线不全：数组越界 / 可选属性语义模糊两类缺陷不报 |
| G2 | lint 非类型感知：无 `no-floating-promises`、`no-unsafe-*` | 门禁 2 | "丢失的 promise"是 harness 全仓最高价值 lint 缺陷类，Sati 现在抓不到 |
| G3 | `no-explicit-any` 是 `warn` 非 `error`（存量 ~170 处） | 门禁 2 | 新代码可无感引入 `any` |
| G4 | 无覆盖率门禁（`test:coverage` / 阈值） | 门禁 3 | 没有"死代码探测器" |
| G5 | 无负控制（门禁自测 / verify-config / lint-contract） | 负控制 | 门禁可能配置写错而悄悄失效，无人知晓 |
| G6 | 无 pre-push typecheck；无 `check` 聚合脚本 | hooks | 推送前不校验类型；门禁无单一入口 |
| G7 | 无决策记录系统（`docs/notes/`） | 决策层 | 决策被反复争论，放弃过的备选无据可查 |
| G8 | 无入库的根级 standing orders（只有不入库的 `CLAUDE.md`） | 陈述层 | 跨工具（Claude Code / Cursor / Codex）没有共同的每会话规则家 |

> 注意：G1/G2 一旦开启会一次性暴露大量存量类型/lint 错误，**不能盲翻**——必须走 §7 的分批收敛（先门禁后清存量，或先清存量后开门禁）。这是 harness §11 明言的"基础期拒绝兼容垫片"与"宁可门禁少而每道真执行"的折中。

---

## 3. 门禁细则

### 门禁 1：typecheck（`pnpm typecheck`）

**现状**（`tsconfig.json`）：`strict: true` 已开。**目标底线**（分两档）：

- **必开（✅ 已落地 2026-08-22）**：`noFallthroughCasesInSwitch: true`——switch 穿透几乎总是不经意的 bug。
- **需分批收敛（G1，高成本）**：
  - `noUncheckedIndexedAccess: true`——数组/索引访问返回 `T | undefined`，消除"读越界 undefined"类缺陷；
  - `exactOptionalPropertyTypes: true`——可选属性不能显式赋 `undefined`，消除"存在但 undefined"语义模糊。

**负控制**：`tests/development-standards/verify-config.spec.ts`（✅ 已落地）断言这些开关为 true，防止"顺手关掉 strict"而 CI 不红。

**理由**：类型系统是第一条防线；缺这些开关时 typecheck 名存实亡（参考底稿明确列出为底线）。放弃的备选：靠人工 review 抓索引越界——不可靠且不可扩展。

### 门禁 2：lint（`pnpm lint`）

**现状**：ESLint 9 flat config（根 + ui 双份，规则偏好保持一致），代码格式交由 Biome。已有 unused-imports、import-x/order、react、react-hooks。

**目标（分档）**：

- **保持**：`no-explicit-any` 暂为 `warn`（存量 ~170 处，治理中）。治理纪律：PR 评审把关**新引入**的 any，按模块分批收敛（优先 context/agent/router）。**不设** `--max-warnings 0`（存量 warning 会立即全红、阻断一切合入，反而无人清理——这是已在 eslint.config.mjs 注释中记录的显式决策）。
- **增开类型感知（G2，高价值）**：`no-floating-promises`（丢失的 promise 是最高价值缺陷类）、`no-unsafe-assignment/member-access/return`、`no-non-null-assertion`。需要为根 config 接入 `projectService`（type-aware），同样须分批：先开规则 → 收敛存量 → 再升 error。
- **负控制**：新增 `scripts/lint-contract.spec.ts` + `scripts/lint-fixtures/`，对含 `any` / 含浮动 promise 的 fixture 跑 lint 断言 exit 非零。

**两条配套纪律**：

1. `any` 用行内窄范围抑制 + 一句理由；**禁止文件级 / 全局关规则**（Sati 现状已有大量 `off` + 注释理由的模式，保持）。
2. 规则冲突用 "off + 注释理由"，不用静默（见 eslint.config.mjs 内 `no-case-declarations: off` 等既有注释）。

### 门禁 3：format（`pnpm format:check`）

**现状（✅ 已落地）**：Biome 2，仅格式化（linter 关闭，lint 归 ESLint）。2 空格、双引号、分号、`trailingCommas: all`、`arrowParentheses: asNeeded`、120 列、LF。忽略清单含 `.pnpm-store`、`skills/`、`products/`、`vendor/`、`tests/fixtures/` 等单一事实源资产。

**纪律**：提交前 `pnpm format`；`format:check` 挂 CI。**lint-staged 顺序** biome→eslint（eslint --fix 后需重新 biome 化）——这是 Sati 既有实战教训。

### 门禁 4：test + coverage（`pnpm test`）

**现状（✅ 已有测试，❌ 无覆盖率）**：

- 后端 `node:test`（`tests/` 镜像 `src/` 结构），先 `pnpm build` 再跑 `dist/tests`；**务必带 `--test-force-exit`**（有句柄/定时器泄漏，裸 node --test 会挂）。
- UI `vitest`（`ui/src/**/*.test.tsx`）+ Playwright e2e（`ui/e2e/`）。
- LLM 回路级优先走 `src/test-support/llm-replay/` 重放 seam（无 key、CI 可跑）；真实 fixture 更新走 `record-real-fixture.ts`，不录 key。
- 单测必须 mock 外部网络/服务（`fetchImpl` 注入）；真实知识库只读测试很快，勿复制大库进 fixture。

**缺口（G4）**：无 `test:coverage`、无阈值。**目标**（§7 第二阶段）：

- 后端覆盖：node:test 需接 `c8` 或 `@vitest/coverage-v8`（Sati 后端是 node:test 非 vitest，`@vitest/coverage-v8` 不能直接套——这是与本模板"vitest 全覆盖"不同的现实，需单独选型）。
- UI 覆盖：`ui/` 有 vitest，可直接接 `@vitest/coverage-v8` + 阈值。
- **信条**（比阈值更重要）：未覆盖行**优先判断为死代码删除**，不是补测试——写进规范，防"为覆盖率写空测试"；覆盖是必要非充分；禁止 `--passWithNoTests`、禁止收窄 include 藏文件、禁止降阈值。

### 领域门禁（Sati 特有，✅ 已落地，维持）

`pnpm lint` 末尾已挂接 5 个领域门禁，任何事件面/专利 SOP/模板改动漏改即红。**这些是 Sati 相对模板的"超额资产"，保持并继续维护**：

| 门禁 | 生成器 | 保护什么 |
|---|---|---|
| `check:event-matrix` | `gen-event-matrix.ts --check` | `docs/event-producer-consumer.md` 与源码事件声明/emit/订阅一致（改事件漏订即红） |
| `check:patent-sop` | `check-patent-sop-references.mjs` | 手册/YAML 五类引用存在性 |
| `check:patent-workflow-docs` | `gen-patent-workflow-docs.ts --check` | `assets/workflows/patent/generated/*.yaml` 幂等 |
| `check:html-templates` | `check-html-templates.mjs` | HTML 交付模板约束 |
| `check:skills` | `validate-skills.mjs` | skill frontmatter 一致性 |

> **`check:skills` 语义**：该门禁**警告即阻断**——`validate-skills.mjs` 对 `hard`(exit 1) 与 `warn`(exit 2) 均返回非零；因 lint 用 `&&` 链式，任意 skill 触发告警（如描述 <20 字符）都会让 `pnpm lint` 变红。这是有意的严格策略，改 skill 时需保证其 frontmatter 描述达标。

**事件矩阵教训**（已入 CLAUDE.md 记忆）：事件矩阵按 `file:line` 硬编码，任何跨文件行号移动（含 lint-staged 的 eslint --fix 删 import）后必须 `pnpm gen:event-matrix`。

---

## 4. 负控制（本规范的灵魂）

> 直接来自两份参考底稿的核心教训：把铁律写进文档但没配门禁，全仓审计时发现它们被逐个击破。负控制 = "每条规则必须有证明它拦得住的东西"。

三层负控制，映射到 Sati：

**(a) 门禁自测**：每个门禁有 fixture 证明它会红（G5，待落地）。**会误报的门禁比没有更糟。**

| 门禁 | 负控制 |
|---|---|
| typecheck 底线 | `tests/development-standards/verify-config.spec.ts` 断言开关为 true（✅ 已落地） |
| lint 规则 | `scripts/lint-contract.spec.ts` 对 fixture 跑 lint 断言非零 |
| 边界门禁 | `check-ui-server-boundary.mjs` 已有（可加反向 fixture：伪造 ui→src import 断言非零） |

**(b) 铁律必须有门禁或 lint，不能只是散文**。Sati 的既有铁律逐条给"可机械执行"方案：

| 铁律 | 至少这样做 |
|---|---|
| `ui/` 不 import `src/` | ✅ 已有 `check-ui-server-boundary.mjs`（eslint 规则对 .js specifier 失效，这是真实门禁） |
| 事件改版漏订即红 | ✅ 已有 `check:event-matrix` |
| 版本 lockstep | ✅ 已有 `bump-version.mjs`（可加反向 spec 断言三处一致） |
| inputSchema 改动破坏 llm-replay fixture | ⚠️ 靠文档记忆；可加 `record:replay` 校验清单门禁 |
| 注册必须可释放（HMR 安全） | ⚠️ 逐个资源/监听器加 dispose 测试 |

**(c) 负控制测试流程**："一个守卫只有当回归真的会撞红它才算守卫"——引入回归 → 看红 → 回退。写关键守卫（边界门禁、配置非零退出、清理断言）时都用这个步骤验证一遍。

---

## 5. 元规则（管规范本身的规范）

1. **每条规范三件套**：写一条规则时立刻回答——它的**家**在哪（哪个文件）？谁**机器验证**？**理由**（含放弃的备选）记在哪？三者缺一就不是规范。
2. **例外必须显式**：每条规则的例外写在规则旁边，像规则一样可检索。系统性例外（如 "types.ts 允许 brand 函数"）必须写进规则，不许游离在外。
3. **事实清单必须生成或可验证**：目录、分组表、默认值表——要么从源码生成、要么给它 verify 门禁（Sati 已有 event-matrix / patent-workflow-docs 两个生成器，沿用此原则）。
4. **本地窄 / CI 全**：pre-commit 只做秒级（staged lint fix + 空白），pre-push 只 typecheck（G6，待加）；CI 跑全量。**不要因为全量检查瘫痪每次提交。**
5. **覆盖率是死代码探测器，不是考核**：见 §3 门禁 4。
6. **按变更面选最小证据**：提交前先看变更面，选能拦住该回归的最小检查；不重复跑已通过的检查；只有显式要求 / 诊断 CI / 全域变更才全量排练。
7. **决策记录强制 Alternatives**：非平凡变更必须带 note，且必须写 `## Alternatives considered`（没记录打败过什么的决策会被重新争论）。

---

## 6. 测试哲学（三条，防三类经典漏检）

已在 `CONTRIBUTING.md` 与 `CLAUDE.md` 落地，此处收敛为三条，与参考底稿一致：

1. **真实现优先**：只 mock 昂贵/非确定边界（网络、时钟、外部服务、LLM 适配器），其余保持真实。mock 绿 ≠ 产品能跑。
2. **测真实入口**：产品可见行为走真实入口（真实 Loader / bin / HTTP），别只测手挂的单元组合；`bin` 测 built 产物用 plain node（构建器会掩盖模块解析错误）。
3. **验证世界，不是自述**：断言外部状态（重跑命令 / 重读文件 / 字节一致），不信被测对象自己的报告。

---

## 7. 分阶段落地清单

映射 harness §11 的阶段化骨架，适配 Sati（solo maintainer、单体+双 workspace、已 0.1.5 的 pre-release）。**原则：宁可门禁少而每道真执行，也不要清单长而全靠自觉。**

### 第 0 步（本回合已做）

- [x] 明细层规范落地：`docs/development-standards.md`（本文件）
- [x] 根级 standing orders 落地：`AGENTS.md`（入库，跨工具每会话规则家；替代"只有不入库 CLAUDE.md"的现状，G8）
- [x] 决策记录制度落地：`docs/notes/README.md` + `proposed/implemented/rejected/` 目录（G7）

### 第 1 步（✅ 已落地，2026-08-22）

- [x] **G6-a**：新增 `pnpm check` 聚合脚本 = `typecheck && ui typecheck && lint && format:check`（test 慢，不进 check；与 CI quality job **手工对齐**，非生成——门禁增多时考虑单一聚合器，如 harness 的 run-gates）。
- [x] **G6-b**：`simple-git-hooks` 加 `pre-push: pnpm typecheck && pnpm --filter sati-ui typecheck`（推送前类型兜底）。
- [x] **G5-a**：`tests/development-standards/verify-config.spec.ts` 断言 tsconfig 底线开关（根 `strict`/`noFallthroughCasesInSwitch` + UI `strict`）。
- [x] **G1-a（低）**：开 `noFallthroughCasesInSwitch`，清存量，CI 回归。
- [x] **决策记录试运行**：首条 note `docs/notes/implemented/2026-08-22-development-standards.md` 落地。

### 第 2 步（需分批，成本高，逐项单独 PR）

- [ ] **G1-b（高）**：开 `noUncheckedIndexedAccess`——先评估存量错误量，分模块收敛后开；或先开 + 逐模块 `@ts-expect-error`/收窄再清零。
- [ ] **G1-c（高）**：开 `exactOptionalPropertyTypes`，同上分批。
- [ ] **G2（高）**：根 eslint 接 `projectService`，开 `no-floating-promises` + `no-unsafe-*`，分批收敛后升 error。
- [ ] **G3（中）**：`any` 存量清完一批后，把 `no-explicit-any` 升 error（须先过 G2 类型感知，否则 error 会淹掉所有 PR）。
- [ ] **G4（高，先选型）**：后端 node:test 覆盖接 `c8`，UI vitest 接 `@vitest/coverage-v8`，定阈值（每文件 100% 是 harness 目标，Sati 可先定 package 级 80% 起步）；信条写进规范。
- [ ] **G5-b**：`scripts/lint-contract.spec.ts` + fixtures（随 G2 落地）。

### 稳定后按需（不做，除非有需求）

- 跨包去重门禁（语义等价，不止文本克隆）；per-file 行数/内聚护栏；平台矩阵扩展（当前仅 Windows desktop job）；双语配对基础设施（Sati 已有 en/zh-CN i18n，但缺 sidecar 配对校验——仅当规模要求时加）。

---

## 附录 A：命令速查

```sh
pnpm check            # 聚合门禁：typecheck + ui typecheck + lint + format:check（不含 test）
pnpm typecheck        # tsc --noEmit（根）+ edgeclaw-memory-core typecheck；先 build 子包
pnpm lint             # eslint src tests scripts apps/desktop + ui lint + 5 个领域门禁
pnpm format:check     # biome check（格式）
pnpm format           # biome format --write
pnpm test             # build + node --test dist/tests（后端，~2800 用例）
cd ui && pnpm test    # vitest（UI，~500 用例）
pnpm gen:event-matrix / pnpm check:event-matrix   # 事件矩阵生成/校验
pnpm record:replay    # llm-replay fixture 校验/清单
node scripts/bump-version.mjs patch|minor|major   # 版本 lockstep
```

## 附录 B：关键文件地图

| 路径 | 内容 |
|---|---|
| `AGENTS.md` | 根级 standing orders（每会话必读，1–3 行/条 + 链接家） |
| `CLAUDE.md` | 本地 AI 助手全量指南（**不入库**） |
| `docs/development-standards.md` | 本文件：规范明细层 |
| `CONTRIBUTING.md` | 贡献流程：环境/分支/提交/PR/代码规范/测试/视觉验证 |
| `docs/notes/README.md` | 决策记录规范（生命周期/格式/Alternatives） |
| `tsconfig.json` | 编译器配置（strict + ES2022 + NodeNext） |
| `eslint.config.mjs` / `ui/eslint.config.js` | 根 / UI 双份 lint（规则偏好一致） |
| `biome.json` | 格式（仅格式化，linter 关闭） |
| `scripts/check-commit-msg.mjs` | Conventional Commits 校验（commit-msg hook） |
| `scripts/lint-staged.mjs` | staged 文件 biome + eslint 分流（pre-commit hook） |
| `scripts/check-ui-server-boundary.mjs` | ui→src 边界门禁（挂 ui lint） |
| `scripts/gen-event-matrix.ts` | 事件矩阵生成器（--check 挂 lint） |
| `scripts/bump-version.mjs` | 三处 package.json 版本 lockstep |
| `.github/workflows/ci.yml` | CI（quality + desktop 两 job） |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 模板（含视觉验证强制节） |
