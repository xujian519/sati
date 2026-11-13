# Agent Note: 附图对齐 deepseek-harness 批次 B-1（重录窗口：9 项 schema 变更 + 一次重录）

Status: implemented

## Problem

批次 B-0（`docs/notes/implemented/2026-11-12-figure-dsh-alignment-batch-b0.md`）把批次 B
拆成两段：零 schema 变更的可执行部分（B-0）当轮落地，其余 10 项**全部**卡在同一个前置
条件上——改任一工具的 `inputSchema` 或新增 builtin 工具 ⇒ llm-replay 的
`toolSchemaDigest` 变化 ⇒ 既有 fixture（`tests/fixtures/llm-replay/deepseek-v4-flash-basic/`）
失配 ⇒ 必须重录（AGENTS.md 第 6 条）。B-0 写下解除条件：**拿到可用的 provider 凭据 ⇒
在一次窗口里把 10 项合并成一次 schema 变更 + 一次重录**。

本轮拿到了凭据（`~/.sati/sati.yaml` 的 `model.providers.deepseek`，`GET /v1/models`
返回 200，模型 `deepseek-flash` 与原 fixture 同源），窗口开启。

## Decision

### B-1-1 本轮落地 9 项（1 次 schema 变更 + 1 次重录）

| # | 项 | 落地形态 | 位置 |
|---|---|---|---|
| 1 | 补标号工具暴露 | **新工具** `patent_figure_annotate`（写可见标号 + 回读核验，三态：written / already_present / unmatched） | `src/tool/builtin/patentFigureAnnotate.ts` |
| 2 | 自动标号 per-call | `patent_figure_generate` 增 `auto_numbering` / `numeral_start` / `numeral_step` / `reserved`（**入参优先于 env**） | `patentFigureGenerate.ts` + `numeral-assign.ts` |
| 3 | `figure_family` 跨图续号 | 同一次调用的多幅图**共享一个连续号段**（族内第一幅 100/102，第二幅接着 104/106），而不是每幅各占一个 100 号段 | `numeral-assign.ts` 的 `assignFamilyNumerals` |
| 4 | 落版参数 per-call | `submission{rotate_deg, caption_font_mm, caption_gap_mm, sheet_font_mm}`，**generate 与 project 同款**（CAD 通路一并透传到落版页/拼版页） | `patentFigureShared.ts` + `cad/artifacts.ts` |
| 5 | CAD `views[]` 多视图 | `patent_figure_project` 增 `views[]`（入参优先于 `SATI_CAD_VIEWS`；非法视图名报 `invalid_tool_input`，**不**与部署配置写错的 `setup_required` 混同） | `cad/views.ts` + `patentFigureProject.ts` |
| 6 | 生成 ↔ 识图比对工具暴露 | **新工具** `patent_figure_compare`（缺标记 / 多标记 / 同号异名 / 同号异类型；两侧都空 ⇒ `invalid_tool_input`，零比对不是「通过」） | `src/tool/builtin/patentFigureCompare.ts` |
| 7 | RC8 工具接线 | `patent_figure_check` 增 `hierarchy[{parent, child}]`；正文取 `claims_text ?? spec_text`（**不新增第二个文本入参**，省预算且语义不歧义） | `patentFigureCheck.ts` |
| 8 | 交付物清单工具化 | **新工具** `patent_figure_manifest`（`mode=build|check`；三态 `verified` / `not-registered` / `unavailable`，未核验时 `ok=false`） | `src/tool/builtin/patentFigureManifest.ts` |
| 9 | 预算重排 | 制图三工具的入参描述收成短标签（省约 1 500 字符）；总量上限 40 000 → **46 000**（见下） | `patentFigureSchema.ts` 等 + `tests/tool/output-schema-validation.spec.ts` |

新增用例 38 个（3 个新工具各 10/14/14 + 本轮 per-call 接线 8）。

### B-1-2 预算：从 39 991 到 45 720，天花板 40 000 → 46 000

R-06 门禁（`tests/tool/output-schema-validation.spec.ts`）度量 patent 域全部工具的
`description + JSON.stringify(inputSchema)` 合计。实测：本轮前 39 991（余 9 字）、本轮后
**45 720**。

- 已做的**真实压缩**（不是只调数字）：制图三工具的入参描述收成短标签（`FigureSpec list.` /
  `cn|us|pct.` / `Total figures in case.` …），本仓制图域省出约 1 500 字符；三个新工具的
  描述按既有制图工具的长度上限（顶层 ~400–450、属性 15–30）对齐。
- 仍差 3 600 ⇒ 上限随契约面同步到 **46 000**（40 000 × 1.15，实测增幅 +14.3%）。
- **门禁强度未降**：单工具描述上限（1200）与属性描述上限（200）**一字未动**，
  总量天花板只是与契约面同步。仍能挡住「无节制加描述」。

### B-1-3 本轮**不做**的两项（有意推迟，不是遗漏）

原 B-1 清单还有两项需要**新写渲染器**，不是「把已有能力暴露出来」：

- **新图型**（时序图 / 电路图 / 外观设计视图 / 2D 剖视）：要扩 `FigureKind` 枚举就得有
  对应渲染器，否则模型传 `kind: "sequence"` 会走到默认分支出错图——**只扩枚举不实现
  渲染 = 接口欺骗**，比不做更糟。
- **多面板 `panels`**（FIG.1A/1B 共享标号系列）：需要多面板渲染器。本轮用
  `figure_family` 达成「同族共享号段」这一实质目标（族内两幅图各自成图、号段连续），
  但**不是**「一幅图两个面板」。

两项转入 `TD-PATENT-N39`，下一轮（同样是重录窗口）处理。

### B-1-4 重录（一次）

- 凭据：`~/.sati/sati.yaml` 的 `model.providers.deepseek`（`api.deepseek.com/v1`，
  模型 `deepseek-flash`——与原 fixture 同源，provider/model 属请求键的一部分）。
- 命令：
  `SATI_LLM_REPLAY_RECORD_ROOT=tests/fixtures/llm-replay/deepseek-v4-flash-basic node --import tsx scripts/record-real-fixture.ts "请用一句话介绍你自己，以及你能为专利工程师提供哪些帮助。"`
  ——任务文本必须与原 fixture 逐字相同（消息进请求键）。
- ⚠️ **必须先清空 `records.jsonl`**：录制脚本是**追加**语义，直接重录会出现
  `duplicate record index 0 in records.jsonl`（本轮实测踩到，删掉旧文件后重录即通过）。
- 产物：`records.jsonl`（1 条 stream）+ `manifest.json`（工具清单含 3 个新工具；
  `eventCount` 151 → 495，因本轮模型回答更长）。
- `pnpm record:replay <dir>` ⇒ `fixture valid`；`node --test dist/tests/test-support/llm-replay-real.spec.js`
  ⇒ `# pass 1`。

## Alternatives considered

- **逐项重录（10 次小窗口）** —— 否决。每改一次 schema 就要重录一次（真实模型调用），
  成本与失败面都放大；且一旦某次重录后 CI 红，无法二分定位是哪一项引起。合并成一次是
  B-0 就写明的解除条件。
- **改 schema 但不重录（让 fixture 失配）** —— 否决，与 B-0 同因（实测会让
  `llm-replay-real.spec` 报 `the test never drove 1 recorded stream(s)`）。
- **用别的模型重录** —— 否决。fixture 的意义是「deepseek-flash 的真实回路」；换模型等于
  把 CI 的信号换掉。
- **手改 fixture 的 key** —— 否决。key 由请求内容确定性生成，`records.jsonl` 不持久化
  原始请求；手改等于伪造录制证据。
- **把三个新工具的 schema 描述写长（写足 1 000 字自解释）** —— 否决。描述是**模型可见
  的契约预算**，不是文档；长描述挤占其它工具的预算，且仓库既有制图工具的顶层描述都只
  400 上下。本轮按同一长度基线对齐。
- **把 B-1 清单一次做满（含新图型与多面板）** —— 否决。那两项是新渲染器工程，与「暴露
  已有能力」的改动风险量级不同；混进同一次重录会让「这次重录到底包含了什么」不可回溯。
  推迟到下一轮并登记载体（TD-PATENT-N39）。
- **RC8 再加一个 `claim_text` 入参（与 `claims_text` 并列）** —— 否决。正文文本
  `claims_text` 已经存在（V10 用途），RC8 直接复用（缺省回落 `spec_text`），少一个入参
  就少一份语义歧义与预算。
- **把上限提到 50 000 一劳永逸** —— 否决。放宽幅度应与契约面增幅相当（实测 +14.3% ⇒
  46 000），而不是留出无依据的空间；否则门槛失去约束力。

## Consequences

- **B-1 的 10 项里落地 8 项 + 预算重排 1 项**；新图型与多面板 2 项转入 TD-PATENT-N39。
- **TD-PATENT-N37（三个模块生产不可达）已清零**：RC8、生成↔识图比对、补标号三个模块
  全部有了生产调用方（`patent_figure_check` / `patent_figure_compare` /
  `patent_figure_annotate`）。
- **TD-PATENT-N38（预算顶格）部分处置**：制图域描述已压缩，总量天花板随契约面同步到
  46 000；但「长描述下沉到 SKILL/references」的彻底重排仍未做（那是跨 30 个工具的工程）。
- 三个新工具的 `outputSchema` 均声明并被 `requireOutputSchema: true` 强制校验。
- **fixture 已重录**：请求键变化（工具集 + 3 个工具的 schema），`eventCount` 151 → 495。
  旧 fixture 已备份在 `/tmp/fixture-backup-*`（不入库；git 里有历史版本）。
- 落版参数首次对 **CAD 通路**生效（此前 CAD 的落版页不读 env、不支持旋转）。

## Verification

- `pnpm check`：exit 0（含 R-06 描述预算门禁、架构边界、技术债棘轮、doc-claims）。
- `pnpm format:check`：绿（3 198 文件）。
- `pnpm build`：通过。
- `pnpm test`：**6 708 用例 / 6 703 通过 / 2 失败 / 3 跳过**。两处失败是**环境性**且与本轮
  改动无关：① `系统 Chrome 存在时可生成 PDF`（无头 Chrome 在本机沙箱不可用：
  `GPU process isn't usable`）；② `配置 downloadDir 含 ~/ 前缀`（沙箱禁止写工作区外的
  `/Users/xujian/pdf-tilde-test`）。
- 重放门禁：`node --test dist/tests/test-support/llm-replay-real.spec.js` ⇒ `# pass 1`。
- `pnpm record:replay tests/fixtures/llm-replay/deepseek-v4-flash-basic` ⇒ `fixture valid`。
- 本轮新增用例：`tests/patent/figuregen/figure-b1-per-call.spec.ts`（8）、
  `patent-figure-annotate.spec.ts`（10）、`figure-comparison-tool.spec.ts`（14）、
  `patent-figure-manifest.spec.ts`（14）。
