# 降级治理 runbook（degradation runbook）

> 定位：铁律 11「降级但不静默」与降级 registry 计划（`docs/degradation-registry-plan.md`）的**运行手册**——候选确认流程、误报处理、退出判据、与相邻口径的分工。
> 事实源分工：规则主文在 `docs/development-standards.md` §6；registry 条目格式与硬门禁在 `assets/degradation/registry.yaml` + `scripts/check-degradation-registry.mjs`；扫描器在 `scripts/gen-degradation-candidates.mjs`。

## 0. 三层防线（先看这张表）

| 层 | 工具 | 触发 | 语义 | 失败后果 |
|---|---|---|---|---|
| **硬门禁** | `pnpm check:degradation`（挂 `pnpm lint`） | 每次 lint | registry 内部一致性：五要素、component/drill 路径存在**且被 git 跟踪**、豁免理由必填、冗余豁免即红 | 阻塞合并 |
| **漂移扫描（informational）** | `pnpm gen:degradation-candidates` + CI job「降级候选漂移」 | 每次 CI | 模式扫描外部触点，与 registry + `candidates-baseline.yaml` 做差：新增候选 / 失效基线 | 报告 artifact + 注解；**当前不阻塞**（转硬判据见 §3） |
| **静默审计（DoD 工具）** | `pnpm audit:silent-catches` | 人工 / 计划回收 | catch 语义审计（档 A 无注释且无足迹 / 档 B 有注释但无足迹） | 仅输出清单，不设棘轮（见 §4） |

## 1. 候选确认流程（CI 告警时）

1. 打开 job「降级候选漂移（informational）」→ 下载 artifact `degradation-candidates-report`；
2. 对每个「新增候选」**三选一**：
   - **补登记**：真外部/软依赖 → 在 `assets/degradation/registry.yaml` 补条目（五要素 + observability + negativeDrill 或豁免），跑 `pnpm check:degradation` 校验；
   - **记基线**：无需单独立规（同族覆盖 / 模式误报 / dev 工具链）→ 记 `candidates-baseline.yaml` `waived`；真依赖但补登记进入待办队列 → 记 `known-unregistered`；
   - **修模式**：扫描模式本身误报（合法新形态）→ 改 `scripts/gen-degradation-candidates.mjs` 的 `PATTERNS` 或排除规则，并在 PR 说明；
3. 复核：`node scripts/gen-degradation-candidates.mjs --check` exit 0（新增 0 / 失效 0）；
4. 三类变更（登记 / 基线 / 模式）**同一 PR** 提交，事实源只有这两份 YAML 与脚本。

判决原则：

- 「谁漏了什么」答不出来的不许登记（`degradedImpact` 必填）；
- 基线条目必须是**文件级精确路径**，禁止目录 / glob 豁免（防止整树静默）；
- 豁免是「暂时没有」的书面承认：条目失效（文件删除/改名）或冗余（已被 registry 覆盖）会被扫描报出，`--check` 下失败。

## 2. 误报处理

模式扫描必然有误报（注释提及、类型定义、扫描器自命中、内部管道）。处理顺序：

1. **先问「能否修模式」**——能精确排除就不记基线；
2. 修不动的记 `waived`，理由写明误报形态（如「模式误报：仅 JSDoc 提及」），不写空泛理由；
3. **不因个别误报放宽整个模式**（防假阴性）；若某模式整体误报率持续过高，在 PR 中量化后调整模式集并重扫基线；
4. 已确认项若后来变成「真的该登记」——直接补登记并从基线移除（防两处事实源）；反向（登记失效）同理。

## 3. 退出判据（转硬门禁）

- **判据**：CI job「降级候选漂移」连续 **4 次**运行（约 2 周）报告 `新增候选 0` 且 `失效基线 0`；
- **量测主体**：CI artifact 留存（`degradation-candidates-report`），不以口头「看过是零」为准；
- **转换动作**（单一 PR）：
  1. `.github/workflows/ci.yml` 摘除该 job 的 `continue-on-error: true`；
  2. 扫描命令加 `--check`（有新增候选或失效基线即 exit 1）；
  3. 仓库设置把该 job 加入 required checks（branch protection，仓库管理员手动作）；
  4. 转换时刻与 4 次运行链接记录在该 PR 描述（计划 T6 要求）。
- 注意：`known-unregistered` 存量（`candidates-baseline.yaml`，当前 44 项）的补登记是**独立工作队列**，按 T5 模式分批深挖，**不阻塞转换**——转换防的是「未分类的新漂移」，不是「已书面记录的存量」。

## 4. 与相邻口径的分工（防两套口径长期分叉）

| 轴 | 工具 | 口径 | 棘轮 | 事实源 |
|---|---|---|---|---|
| catch 卫生（计数） | `scripts/measure-techdebt.mjs` → `docs/technical-debt/metrics.md` | **窄**：仅无参 catch（`catchEmpty` / `catchNoParam.undocumented`） | 有（双棘轮） | `docs/technical-debt/metrics.md` + `architecture-baseline.json` |
| catch 语义（静默审计） | `scripts/audit-silent-catches.mjs` | **扩展**：含带参 catch 与 `.catch` 回调；按「注释 × 可观测足迹」分档 | **无**（T6 决定：维持不设棘轮） | 脚本输出（DoD / 人工对账用） |
| 依赖登记（漂移扫描） | `scripts/gen-degradation-candidates.mjs` + registry | 模式触点 × registry/基线差集（文件级） | informational → §3 判据后转硬 | `registry.yaml` + `candidates-baseline.yaml` |

**T6 决策（静默审计是否升级为门禁）：维持不升级。** 理由：真实存量数百处（档 A/B 合计），设棘轮会把「存量可见」变成「红灯疲劳」；该工具的价值已在 T3 验证（修复后对应行从清单消失、分档计数进 PR 描述），继续作为 DoD/回收工具。若未来需要棘轮，须先做存量清理计划（与 metrics 双棘轮的口径关系见上表，不得互相顶替）。

三者互不替代：metrics 管「catch 形态是否恶化」（数量），静默审计管「catch 是否吞掉信号」（语义），候选扫描管「外部依赖是否未登记」（覆盖面）。同一变更可能同时触多轴（新增静默 catch + 新外部依赖），按各自流程分别处理。

## 5. 已知启发式局限（漏什么必须可见）

- **文件级匹配**：已登记文件**内部**新增的触点不会被报（逐行棘轮留待转硬门禁后评估）；
- 不剔除注释 / 字符串内命中（可记基线 `waived`）；
- 不解析动态 import / 间接调用（如经变量持有再调用的 `spawn`）；
- 不含裸 `exec(`（RegExp 误报多）——`child_process` import 已覆盖其调用文件；
- 跳过 `.d.*` 声明文件与 `*.spec.*` / `*.test.*`；
- 跳过 gitignore 的 vendored 编译输出 `src/context/memory/edgeclaw-memory-core/lib/`（CI 无构建、本地有——跳过防口径分叉；源码仍在 src 树内被扫）；
- 扫描范围：`src` / `ui/src` / `ui/server` / `scripts` / `apps/desktop/src`。
