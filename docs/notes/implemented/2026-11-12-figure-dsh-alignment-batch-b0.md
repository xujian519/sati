# Agent Note: 附图对齐 deepseek-harness 批次 B（B-0：零 schema 可执行部分）

Status: implemented

## Problem

批次 B（`docs/research/patent-figure-dsh-alignment-2026-11.md` §6）的全部条目都落在
**同一个前置条件**上：改任一工具的 `inputSchema`（含描述文本）或新增/删除 builtin 工具
⇒ llm-replay 的 `toolSchemaDigest` 变化 ⇒ 既有 fixture（`tests/fixtures/llm-replay/
deepseek-v4-flash-basic/`）失配 ⇒ **必须重录**（AGENTS.md 第 6 条）。

本机**没有可用于重录的 provider 凭据**：环境变量里没有 provider key，`~/.sati/` 下没有
含 key 的 provider 配置，DSH profile 里也没有可供 Sati 模型层使用的凭据。因此
**重录在本环境不可行**，而「改 schema 不重录」会把 `llm-replay-real.spec.ts` 打红。

### 实测证据（不是推断）

1. 重放键的组成（`src/test-support/llm-replay/requestKey.ts:52-60`）：
   `provider / model / systemPrompt / messages / tools[{name, inputSchema}] / toolChoice /
   maxOutputTokens / outputSchema`。⇒ **工具的 `inputSchema` 变 ⇒ 键变**；
   **工具的输出变不影响键**（输出只进 `messages`，而本 fixture 的会话不调用制图工具）。
2. 探针实验：把 `patent_figure_generate` 的 `inputSchema` 里一个 description 改一个词
   （`"Total figure count in the case."` → `... (probe).`），重建后
   `node --test dist/tests/test-support/llm-replay-real.spec.js` ⇒
   `not ok 1 … the test never drove 1 recorded stream(s): 0`；改回后立即恢复 `# pass 1`。
   ⇒ 改 schema 确实会打红重放门禁（与 AGENTS.md 第 6 条一致）。

## Decision

把批次 B 拆成两段，本轮只落 **B-0（零 `inputSchema` 变更、零新增工具）**：

### B-0-1 落版旋转与字号（**生产可达**）

- `figuregen/submission-page.ts` 支持 `rotateDeg`（0/90/180/270）：90/270 交换落版后的
  占位宽高（横向图形借它落进竖向版心时缩得更小、图更大），旋转绕摆放框中心；
  **0/180 不加旋转组 ⇒ 默认产物逐字节不变**。
- 参数走**部署级环境变量**（`SATI_FIGURE_ROTATE_DEG` / `SATI_FIGURE_CAPTION_FONT_MM` /
  `SATI_FIGURE_CAPTION_GAP_MM` / `SATI_FIGURE_SHEET_FONT_MM`），解析在
  `patentFigureShared.ts` 的 `resolveSubmissionStyle`，非法值在**落盘前** fail-loud。
- ⚠️ 旋转会把图面文字一起转 90°，只适用于「图面无文字」或「文字随图转仍可读」的场合；
  默认关闭（0）。

### B-0-2 标号一致性归一（**生产可达**）

本仓此前有一个真实缺口：**可见标号在 label 文本里**（惯例「处理模块(20)」），
**机器标记在 `ref` 字段里**（渲染器只把它写进 `data-ref`）。两者可以不一致：

- 只写 label 不写 `ref` ⇒ 图上有可见标号、**没有 `data-ref`** ⇒ 图↔文双向核对
  （V2/V3）与跨调用占用核对拿不到这个标记；
- 写了 `ref` 却不写进 label ⇒ `data-ref` 有、**图面上看不到标号**。

归一动作（`figuregen/numeral-assign.ts` + 两处渲染器）：

- **回填**：label 尾部有可见标号而 `ref` 缺失 ⇒ 补 `ref`（`backfillRefsFromLabels`）；
- **补画**：`ref` 有值而 label 无该标号 ⇒ 渲染时在图面上补画 `(ref)`（先判定 label
  是否已含该标号，已含则不重复画，避免「(20)(20)」）；
- **自动分配**：`SATI_FIGURE_AUTO_NUMBERING=on` 时，给「既无 `ref`、label 也无可见标号」
  的节点按 100 系列（`100 + 100×(图号−1)`、步进 2）分配（移植 DSH 的 `assignNumerals`，
  含显式声明/保留号/同号冲突硬抛）。**已接线**（部署级开关，缺省 off）：归一只改 `ref`、
  不改 label 文本（可见标号的补画在渲染期做），发号结果在报告里逐条出声
  （「自动标号：N 个节点按 100 系列发号——id→号」）。

#### B-0-2 的实施结果（补充：一处渲染回归及其修法）

渲染器补画标号后，既有门禁用例「同一标记的两种书写形态（括号/裸数字）不判 V4 fail」
变红。根因（子代理 A/B 定位）：**补画发生在渲染期、盒宽预算在布局期**，两者不同源 ⇒
「处理模块20(20)」比布局预算宽 2.2px/侧 ⇒ 与框线相交 ⇒ RC1 fail ⇒ 交付门阻断。

两条修法同时采用：

1. **裸数字形态也算「这个号已经画在图面上」**（「处理模块20」里的 20 就是该节点的标记）：
   补画判据只用于**渲染面**；核验侧仍按括号形态判定（裸数字是说明书正文惯例，不算图面
   标记，与 `svg-annotate.ts` 的口径一致）。否则会补成「处理模块20(20)」这种重复标注。
2. **渲染前归一**：接线在布局之前调 `applyVisibleNumerals(figure)`（归一只作用于渲染面，
   sidecar 记录的仍是调用方声明的原始 spec）⇒ 盒宽预算与图面文字同源。

修完该用例恢复绿色（516/516）。

### B-0-3 交付物清单与时序门（**生产可达**）

- `figuregen/deliverable-manifest.ts`：交付物清单（角色 + 文件名 + sha256 + 字节数 +
  mtime）与校验（`file-missing` / `hash-mismatch` / `not-in-manifest` / `stale-output`）。
- 清单进 sidecar 的**可选**字段 `deliverables`（不升 sidecar 版本，旧 sidecar 仍可解析）。
- 核验侧（`patent_figure_check` 的 `svg_paths` 通路）比对清单 ↔ 当前文件，规则号
  `DR4`（哈希/缺文件 = fail，新增未登记/时序倒挂 = warn）；sidecar 无该字段 ⇒ **不判**
  且在报告里写明「清单一致性本次未核验」（不把「没登记」说成「已核验通过」）。

#### B-0-3 的实施结果（补充）

- 生成侧接线：清单在**文本转路径之后**计算（转路径会改写 SVG，哈希须取最终形态），
  **含图形/落版页/HTML**；**不含 sidecar 自身**（sidecar 承载清单，它的哈希在写入那一刻
  就变了 ⇒ 自指）。为此把 HTML 的落盘**前移到 sidecar 之前**（清单要把它算进去）。
- 核验侧：`patent_figure_check` 的 `svg_paths` 通路比对清单 ↔ 当前文件，规则号 `DR4`
  （哈希/缺文件 = fail；新增未登记/时序倒挂 = warn）；三种结局如实区分
  `verified` / `not-registered`（sidecar 无该字段 ⇒ 不判且报告写明「本次未核验」）/ `unavailable`。
- ⚠️ **时序门在核验入口未执行**：核验工具只拿到说明书**文本**，没有输入件的落盘时刻可比
  ⇒ 报告写明「时序门本次未执行」。要真正生效需在清单契约里带上输入件 mtime（属契约变更）。

### B-0-4 构造层级 ↔ 权利要求（RC8，纯能力模块）

`figuregen/hierarchy-check.ts`：从权利要求文本抽「<父标记>…的…<子标记>」式归属表述，
与声明的层级边核对；父标记须是子标记的祖先，否则报 RC8；成环边忽略但出说明。
**本轮未接线**（接入需给工具加 `hierarchy`/`claimText` 入参 ⇒ schema 变更）。

### B-0-5 生成 ↔ 识图比对（纯能力模块）

`figure/figure-comparison.ts`：比对「声明的附图」与「模型识图结果」，四类发现
（缺标记/多标记/同号异名/同号异类型）；只比对纯数字标记，空名不判冲突。
**本轮未接线**（暴露成工具需新增工具 ⇒ schema 变更）。

### B-1（**阻塞**）：一次合并的 schema 变更 + fixture 重录

以下条目**全部**需要改 `inputSchema` 或新增工具，统一留到重录窗口一次性合并：

1. A9 的补标号工具暴露（`add_patent_figure_references` 等价物）；
2. 自动标号的 **per-call** 参数（`numeral_start`/`numeral_step`/`reserved`）——
   本轮用部署级 env 顶替；
3. `figure_family` 跨图续号；
4. 多面板 `panels`（FIG.1A/1B 共享标号系列）；
5. 落版参数的 **per-call** 形态（`rotate_deg`/字号，本轮用部署级 env 顶替）；
6. 新图型（时序图 → 电路图 → 外观设计视图 → 2D 剖视）：`FigureKind` 扩枚举；
7. CAD `views[]` 多视图 + manifest；
8. 生成 ↔ 识图比对的工具暴露；
9. RC8 的工具接线（`hierarchy`/`claimText` 入参）；
10. 交付物清单的工具化暴露（可被独立调用）。

**解除条件**：拿到可用的 provider 凭据 → 在 main 上 `llm-replay-real.spec` 为绿时
一次性重录（`SATI_LLM_REPLAY_RECORD_ROOT` + 真实会话），并把上述条目合并成**一次**
重录（批内不得夹带第二个 schema 改动，否则出问题无法二分定位）。

## Alternatives considered

- **用手工改 key / 用别的模型重录来「绕过」重录** —— 否决。fixture 的 key 由请求内容
  确定性生成，`records.jsonl` 不持久化原始请求，手改 key 等于伪造录制证据；换模型重录
  会把「deepseek-flash 的真实回路」换成别的模型的行为，CI 的信号就变了。
- **直接改 schema、不重录** —— 否决：`llm-replay-real.spec.ts` 会红（实测），CI 断，
  且违反 AGENTS.md 第 6 条。
- **把 per-call 参数全部改成部署级环境变量** —— **部分采纳**。落版参数与自动标号是
  **体例/部署级**决策（不同事务所的提交体例不同），env 与既有的
  `SATI_FIGURE_RENDER_GATE` / `SATI_FIGURE_FONT_MM` 口径一致；但「每幅图不同旋转角」
  「本次调用要 100 系列起点」本质是 **per-call** 语义 ⇒ 留待重录窗口做 schema 形态，
  env 只是过渡形态（两者都保留，接线时 env 缺省、per-call 优先）。
- **RC8 / 比对模块不接线就交付** —— 采纳，但**必须显式记账**：在
  `docs/technical-debt/backlog.md` 登记（TD-PATENT-N37），避免重演 §5.5 第 5 条
  「已实现但生产不可达」的静默债务（两个模块头也各自写明边界）。
- **旋转默认值设为 90/270（自动适配横长图）** —— 否决。旋转会把图面文字一起转 90°，
  送审文件里出现侧躺的文字是新的合规风险；默认 0，启用需显式配置。
- **DR4 的清单漂移定 fail** —— 采纳（内容哈希不符 = 交付的不是你审过的那份）。
  但「新增未登记产物」与「时序倒挂」定 warn：前者可能是合法的附加产物，后者需要判断
  「输入件改动是否真的要求重生成」。

## Consequences

- 批次 B 的**可执行部分全部落地**（5 项），其中 3 项**生产可达**（落版旋转/字号、
  标号一致性归一、交付物清单与时序门），2 项为**边界写明的纯能力模块**（RC8、比对）。
- 本轮**零 `inputSchema` 变更、零新增工具** ⇒ llm-replay fixture 无需重录，
  `llm-replay-real.spec.ts` 保持绿（实测）。
- 新增 4 个模块文件 ⇒ `docs/technical-debt/metrics.md` 与 `docs/code-facts.md` 的
  文件数基线变化，已跑 `pnpm measure:update` 与 `pnpm gen:doc-claims`。
- 落版页默认产物**逐字节不变**（旋转角缺省 0 ⇒ 不加旋转组）；渲染器补画标号只影响
  「`ref` 有值而 label 无标号」的既有产物（这类产物此前是**声明了标记却没画出来**）。
- B-1 的 10 项条目已列清单并给出解除条件；**不得**在无凭据时擅自改 schema。

## Verification

- `pnpm exec tsc --noEmit`：零错误；`pnpm build`：通过。
- `pnpm lint` / `pnpm format:check` / `pnpm check:architecture-boundaries`：绿。
- `pnpm test`：见本批提交记录；新增用例：标号归一 12、交付物清单 14、RC8 16、比对 13。
- 体量门禁：`patent_figure_generate.ts` 因本批增长一度到 809 行（超 800 上限）⇒ 把报告
  文本构建抽到 `patentFigureReport.ts`（现 700 行）；`patentFigureCheck.ts` 因清单校验
  增到 755 行（离上限 45 行，后续若再加图相关能力需先拆）。
- 重放门禁：`node --test dist/tests/test-support/llm-replay-real.spec.js` ⇒ `# pass 1`
  （本轮零 schema 变更 ⇒ fixture 未受影响）。
