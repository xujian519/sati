# 专利执行链补齐实施计划

> 日期：2026-11-07
> 状态：部分实施（2026-11-07）。M0–M7 已落地并有测试，并按独立代码审阅补齐了 claim 来源、答复状态、补检失败、程序类型识别与证据模式图节点；M8 跨表用词、M9 CAD C13/C14、M10 夹具未做。决策记录见 `docs/notes/implemented/2026-11-07-patent-execution-chain.md`。
> 来源：开源专利技术对照后的四项建议
> 关联：`docs/plans/2026-11-02-patent-drafting-enhancement-import.md`（撰写增强计划）
> 范围：`src/patent/`（anchor、oa、procedure、search/recall、graph 开关、atoms、workflow manifests、figuregen/cad）、`tests/patent/`、`assets/workflows/patent/generated/`、`docs/code-facts.md`（经生成器）、`docs/notes/`
> 非目标：见第 2 节。不改 UI，不改 gateway 协议，不新增工具 `inputSchema` 字段。

## 0. 第一稿审阅后改了什么

独立审阅对照源码后裁决不通过。第二稿按阻塞项改口，不扩大范围。

| 第一稿错误 | 源码事实 | 第二稿口径 |
|---|---|---|
| 无原子阶段在自动路径得到空输出 | `manifestRun.ts` 对无原子阶段回写 `input.input`；只有 `dispute_framing` 写成「未识别争点」 | 不再把「挂上原子」描述成「从空输出变成有输出」。原子必须自己读 `text` |
| 自动路径能产出修改对照 | `buildWorkflowRunContext` 只有 `input` / `text` / `source_text` / `extraction_input` / `claim` / `chart_targets` / `max_results`。工具 schema `additionalProperties: false` | 原申请与拟修改限定用 `input` 内的两段标题携带。缺段则 `not_checked`，不得写成已有依据 |
| M0 交付后撰写增强计划从 M2 继续 | 该计划 M1 还要跨段匹配、章节、未命中返回空数组 | M0 只做连续子串。撰写增强计划 M1 仍未完成 |
| 函数名 `evaluateSearchQuality` | 实际是 `checkSearchQuality(text, options?)`，选项只有 `sourceCount` | 改名，可选参数加在 `SearchQualityOptions` |
| 新颖性图可能要新补一条跳过检索的边 | `novelty.ts` 已有：有 keywords 则 `keywords → compare`，否则 `extract → compare` | 不新增节点。`supplied` 在 handler 存在时仍走这两条已有边 |
| 用状态字段 `procedure` 切换 `chart_mode` | `runStageOnce` 用 `stage.params` 覆盖状态；运行上下文没有 `procedure` | 本计划保持静态 `chart_mode: "invalidity"`。复审模式另开入口，不在本计划 |
| 期限字段叫 `absentReason`，整份报告可直接展示 | 待定原因在 `PendingDeadline.reason`。同一次求值还会算出带日期的年费等条目。无效请求没有对应规则 | 只读 `id === "reexamination-request"` 的 pending `reason`。不渲染 `computed`。无效清单写「无对应期限条目」 |
| 验收使用 visited 节点 | 轨迹在 `GraphRunResult.nodeDurations[].node` | 图跑起来时用 `nodeDurations`。空证据在编译前返回，用检索器调用次数断言 |

## 1. 必须达成的结果

| 编号 | 结果 | 判定方式 |
|---|---|---|
| R1 | 审查意见答复的自动路径能区分「已核对的修改」和「没给原文所以没核对」 | 夹具含两段标题时，`amendment_diff` 给出 `anchored` 或 `unsupported`。缺任一段时状态为 `not_checked`，输出不含「已有依据」「实质支持」 |
| R2 | 申请撰写的检索阶段有界补检；特征仍未覆盖或召回失败时质量门失败 | `tests/patent/search-recall.spec.ts`：补检命中、轮次用尽、模型失败、`retrieval_rounds` 为数字 0（仍检索 1 次且不补检） |
| R3 | 无效分析在对照表没有目标时不调用检索；有目标时执行轨迹不含 `search` | 空 `targets`：假检索器 0 次。有目标：`nodeDurations` 的 `node` 列表不含 `search` |
| R4 | 复审程序清单只引用驳回决定期限的待定原因；无效清单不套用该期限 | 无送达记录时输出含「需要驳回决定的送达记录，本查询未提供该通知。」且不含其它期限算出的日期。`kind: "invalidation"` 的期限行是「无对应期限条目」 |
| R5 | 行为变更有决策记录；manifest、原子计数与文档事实层一致 | `pnpm check:patent-workflow-docs` 与 `pnpm check:doc-claims` 绿。`tests/patent/atoms.spec.ts` 的原子计数与新增个数一致 |

### 1.1 指标

| 指标 | 现状（2026-11-07） | 目标 |
|---|---|---|
| OA 的 `draft` | 无 atom，自动路径回显整份 `input` | atom 为 `draft-oa`，主输出是 `oa_statement` |
| 撰写 `search` | `SearchHandler` 一次 `provider.search` | 同一阶段 1 次，或 1 + 最多 2 次补检 |
| 无效的新颖性/创造性 | 无 atom，自动路径回显 `input` | atom 为 `invalidity-analysis`，证据模式 |
| 中国附图字高 | cnipa `practicalMinCharHeightMm` 为 2.0 | 保持 2.0 |
| 工具 `inputSchema` | — | diff 不改 `patentWorkflowRunTool.ts` 的 schema |
| 内置原子注册数 | `registerBuiltinAtoms` 19 次，`docs/code-facts.md` 的 `patent_atom_count` 为 19 | 加上本计划实际注册的原子后，测试与 `pnpm gen:doc-claims` 同步 |

## 2. 明确不做

1. 不把外部技能仓库并进 `patent_drafting_v1`。
2. 不微调，不引入 PatRe、PARIS、PatentBench 的数据或榜单。
3. 不生成可提交的复审请求书或无效请求书。
4. 不把中国附图字高改成 3.5 mm，不改 PCT/US 的 3.2 mm。
5. 不做爆炸图压叠，不做 DXF。`FigureKind` 只有 flowchart、block、state、hierarchy、chart。CAD 视图白名单没有爆炸图。
6. 不改创造性图在召回解析失败时进入 `converge_prior_art` 的行为。撰写侧失败是 `not_evaluated`，两套口径并存并写入决策记录。
7. 不调用 `recordRevision`。空 `answered`、对不上缺口、轮次到顶或案卷不是 `open` 都会抛 `DocketError`。
8. 不新增工具入参。`retrievalRounds` 已在图模式的工具入参上，本计划的撰写补检用 manifest 阶段参数，不改 schema。
9. 不在本计划切换 `chart_mode` 到 `reexamination`。类型里已有该值，但静态 params 会盖掉状态，运行上下文也没有程序类型字段。
10. 不把 `search-recall` 用到披露分析、新颖性图或创造性图。那些阶段继续用 `search` 原子或图内节点。

## 3. 约束

1. 降级不静默。未核对、未评估、无证据、缺送达记录，都要写出漏了什么。禁止渲染成通过。
2. 一个 PR 一个里程碑。
3. 锚点、差分、程序清单、CAD 计数是纯函数。模型只用于召回覆盖判断和意见陈述里的争辩段落。
4. 改 manifest 后运行 `pnpm gen:patent-workflow-docs`。
5. 新增 `globalAtomRegistry.register` 后，更新 `tests/patent/atoms.spec.ts` 的计数，并运行 `pnpm gen:doc-claims`。原子还要在 `src/patent/atoms/handlers/builtin/index.ts` 导出。`AtomCategory` 只用已有的 `search`、`extract`、`compare`、`reason`、`gate`。
6. 降级原因写进该原子 `outputSchema[0]` 的文本。只返回 `{ _error }` 时，阶段 `output` 仍是空串，自动路径会丢掉原因。
7. 同 PR 写 `docs/notes/`，含 `## Alternatives considered`。
8. 测试不访问网络。无 UI 改动，不改 i18n。

## 4. 工作分解

| ID | 里程碑 | 优先级 | 依赖 | 落点 | 预计 |
|---|---|---|---|---|---|
| M0 | 连续子串锚点 | P0 | — | `src/patent/anchor/` | 1.5d |
| M1 | 理由分型（规则，不调用模型） | P0 | — | `src/patent/oa/grounds.ts` | 1d |
| M2 | 修改差分，输入来自 `text` 的两段标题 | P0 | M0、M1 | `src/patent/oa/amendment-diff.ts` | 2d |
| M3 | `draft-oa` 接入 OA 清单 | P0 | M2 | `atoms/handlers/builtin/oa.ts`，`manifests.ts` | 2d |
| M4 | 轮次快照到 `data/cases/<caseId>/oa-rounds` | P1 | M3 | `src/patent/oa/round-snapshot.ts`，`paths.ts` | 1d |
| M5 | 撰写检索补检 | P0 | — | `src/patent/search/recall.ts`，`search-recall` 原子 | 2.5d |
| M6 | 证据模式 | P0 | — | graph 选项 + `invalidity-analysis` 原子 | 3d |
| M7 | 程序清单 | P1 | M1、M6 | `src/patent/procedure/checklist.ts` | 1.5d |
| M8 | 两张对照表的用词差异 | P2 | M0 | 纯函数，不改 `ArgumentGapSource` | 1d |
| M9 | CAD 的 C13、C14 | P2 | — | `figuregen/cad/checks.ts` | 1.5d |
| M10 | 8 个 JSON 夹具由 spec 读取 | P1 | M3、M6 | `tests/patent/fixtures/oa/`，`tests/patent/oa/fixtures.spec.ts` | 1d |

```
Wave 1   M0 → M2 → M3 → M4
         M1 ─────────↗
         M5（与 M0/M1 无依赖）

Wave 2   M6 → M7 → M10

Wave 3   M8    M9
```

单人顺序：M0 → M5 → M1 → M2 → M3 → M4 → M6 → M7 → M10。M8、M9 可在 R1–R4 之后推迟。

---

## 5. 逐项方案

### M0 连续子串锚点

**问题。** 仓库没有 `src/patent/anchor/`。撰写增强计划的 M1 想要归一化、跨段、章节和空数组，那些还没做。

**决策。** 本里程碑只做连续子串，供修改差分使用。不实现跨段，不调用 `splitSpecSections`，不声称撰写增强计划的 M1 已完成。

**契约。**

- 归一化：全角/半角、Unicode 空白折叠、中英文标点统一，并保留到原文的偏移。
- 「包括」不等于「包含」。
- `matchFeature(text, feature)` 返回 `{ feature, hit: { start, end } | null }`。未命中是 `hit: null`，不抛错。
- 命中条件是归一化后的特征作为连续子串出现。

**验收。** 全角特征命中半角正文，区间映射回原文。同义改写不命中。

### M1 理由分型

**问题。** `parseDisputeFraming` 只收字符串。自动路径上 `dispute_framing` 阶段固定是「未识别争点」，不能当作理由来源。

**决策。** 不改 `disputeFraming.ts`。新函数 `classifyGrounds(text: string)` 直接读材料全文（原子里用 `getStateString(state, "text")`）。

| 代码 | 规则 |
|---|---|
| `novelty` | 「新颖性」或「第22条第2款」 |
| `inventiveness` | 「创造性」或「第22条第3款」 |
| `clarity` | 「不清楚」或同时出现「第26条第4款」与「清楚」 |
| `enablement` | 「公开不充分」或「第26条第3款」 |
| `amendment_scope` | 「修改超范围」或「第33条」 |
| `unity` | 「单一性」或「第31条」 |
| `other` | 有文本但没有上表命中 |
| `unidentified` | 空白，或文本就是「未识别争点」且没有其它命中 |

一条里可以有多个代码。不调用模型。

**验收。** 「未识别争点」得到 `unidentified`。同时含新颖性与创造性的句子得到两个代码。

### M2 修改差分

**问题。** 意见陈述需要修改依据。自动路径没有单独的 `original_text` 字段。

**决策。** 从 `text` 里读两段，标题固定为：

```text
## original_application
## proposed_limitations
```

`proposed_limitations` 一段一行一条限定。解析器遇到其它 `#` 标题结束当前段。缺任一段：返回一条记录 `{ status: "not_checked", reason: "输入中没有 original_application 或 proposed_limitations，修改超范围检查未执行" }`。不得生成 `anchored`。

两段都在时，对每条限定调用 M0：

```ts
type AmendmentDiffItem = {
  limitation: string;
  status: "anchored" | "unsupported" | "not_checked";
  hits: { start: number; end: number }[];
  reason?: string;
};
```

`unsupported` 的 `reason` 固定为「原申请文本中未找到该限定的连续片段」。禁止「实质支持」「可以概括」「已有依据」。

原子 `amendment-diff`，类别 `gate`，`outputSchema: ["amendment_diff"]`。主输出是 JSON 字符串。降级原因也写在这个字符串里。

**验收。** 子串命中 → `anchored`。多出一个原文没有的特征 → `unsupported`。缺标题 → `not_checked`，且全文不含「已有依据」。

### M3 `draft-oa`

**问题。** `patent_oa_response_v1` 的 `draft` 没有原子，自动执行会把整份输入回显成该阶段结果。对照表原子已写出 `claim_chart_doc` 与 `gap_list`。

**决策。** 在 `claim-chart` 之后增加两个阶段：

1. `classify_grounds`，atom `oa-grounds`（M1 的包装，类别 `extract`，主输出 `oa_grounds`）。
2. `amendment_diff`，atom `amendment-diff`。
3. `draft` 的 atom 改为 `draft-oa`，类别 `reason`。

`draft-oa` 读 `claim_chart_doc`、`gap_list`、`amendment_diff`、`oa_grounds`。缺对照表时，主输出写明「意见陈述缺少要素对照」，不调用模型。

`oa_statement` JSON：

- `grounds`、`chartGaps`、`amendments` 来自上游，不重新检索，不重新拆权利要求。
- `argumentNotes`：温度 0.2。每段必须引用存在的 `elementId` 或 `limitation`。否则丢弃并计入 `droppedNotes`。
- `draftNotice` 固定为「本意见陈述为草稿，须由署名代理人复核后才能形成呈递文本。」

**验收。** 假模型加两段标题：输出含 `draftNotice`，并含一条 `unsupported` 或 `anchored`。假模型引用未知 `elementId`：该段计入 `droppedNotes`。缺标题：`amendments[0].status === "not_checked"`。更新 `assets/workflows/patent/generated/patent_oa_response_v1.yaml`。

### M4 轮次快照

**决策。** 不碰 docket 状态机。在 `src/patent/paths.ts` 增加 `caseOaRoundsDir(caseId)`，返回 `data/cases/<caseId>/oa-rounds`，与 `caseWorkflowRunsDir` 同一根。`writeOaRoundSnapshot` 写入 `round-N`。`N` 为已有轮次最大值 + 1。

仅当 `draft-oa` 成功且 `provider.caseId` 是合法 id 时写入。无 `caseId` 时结果加 `snapshot: "skipped-no-case"`，不创建目录。

**验收。** 两次调用得到 `round-1` 与 `round-2`，第一轮字节不变。非法 `caseId` 拒绝写入。

### M5 撰写检索补检

**问题。** 创造性图有召回回路。起草清单的 `search` 阶段是一次查询。`checkSearchQuality` 只检查报告文本里的篇数、X/Y/A、全文、布尔式和 IPC。

**决策。** 新原子 `search-recall`，类别 `search`，只替换 `patent_drafting_v1` 里 `id: "search"` 的原子。去掉该阶段的 `worker: "patent-search-commander"`。该 worker 的硬性子串是「检索式」「对比文件」「公开日」，补检输出对不上，会变成永真的校验失败。其它清单的 `search` 阶段不动，worker 保留。

查询串沿用 `SearchHandler`：先 `query` / `search_query` 字符串，否则把 `keywords` 数组拼起来。特征列表读 `state.features`（数组）。没有数组时不从 `merge_result` 猜。`merge_result` 只是摘要字符串。没有 `features` 时主输出写「无特征清单，补检未执行」，`search_recall.status` 为 `not_evaluated`。

轮次从阶段参数读原始值。`getStateString` 对数字返回空串，不能用来读 `0`。参数缺失时默认 2。值为 0：检索 1 次，不进入补检，`status` 为 `single_pass`（不是 `skipped`，也不是没检索）。

补检拼接沿用 `refineQueryNode` 的规则：原查询 OR 缺失特征。去重键用结果上的 `url`；没有 `url` 时用 `title` 加 `snippet`。`provider.search` 的文档类型没有稳定 `id`。0 篇也要写非空 `search_summary`，否则质量门会先因为空文本降级。

把 `buildRecallPrompt` 与召回 schema 抽到 `src/patent/search/recall.ts`。创造性图节点改调用它。提示词字符串配快照测试，抽出的 PR 不改 schema 字段。

召回结果：

- 覆盖：`adequate`
- 轮次用尽仍有缺失特征：`uncovered`，列出特征原文
- 模型失败：`not_evaluated`。不当成 `adequate`

`SearchQualityOptions` 增加可选 `recall?: { status: string; missingFeatures?: string[] }`。未传时 `checkSearchQuality` 的失败项与现在一致。`uncovered` 与 `not_evaluated` 使 `passed` 为 false。`quality-gate` 原子仅在状态里有 `search_recall` 对象时传入。

**验收。** 第一轮缺、第二轮命中：检索 2 次，`adequate`。两轮后仍缺：`uncovered`，质量门失败信息含该特征。参数数字 0：检索 1 次，`single_pass`。模型抛错：`not_evaluated`。缺省 `checkSearchQuality("含 3 篇和 IPC 的旧报告")` 的通过与否与改前一致。创造性图提示词快照不变。

### M6 证据模式

**问题。** 无效清单的 `novelty` 与 `inventiveness` 没有原子，自动路径回显输入。把整个创造性图接上会检索，从而换掉请求人指定的证据。

**决策。** `BuildInventivenessGraphOptions` 与 `BuildNoveltyGraphOptions` 增加 `evidence?: "search" | "supplied"`。

缺省 `undefined`，保持今天的行为：注册表里有 `search` handler 才插入检索节点。不要把缺省实现成「没有 handler 也强行加 search」。

`supplied`：

- 创造性图不加入 `search`、`prepare_query`、`recall_check`、`refine_query`、`converge_prior_art`。即使注册表里有 search handler 也不加入。`build_query` 使用现有的「无检索」边，连到 `closest`。
- 新颖性图不加入 `search`。沿用已有边：有 keywords handler 则 `keywords → compare`，否则 `extract → compare`。不新增 `build_query`。
- 原子内部 `includeApproval: false`，清单末尾已有 `approval`。

原子 `invalidity-analysis`，类别 `compare`，`outputSchema: ["invalidity_report"]`。两个阶段共用，params 分别为 `{ analysis: "novelty" }` 与 `{ analysis: "inventiveness" }`。

证据来自 `claim_chart_doc`（`ClaimChart` JSON），不读一个不存在的 `prior_art` 状态：

- 目标用 `targets[]` 的 `id`、`kind`、`title`、`sourcePath`。
- 引文用 `rows[]` 里相同 `targetId` 的 `quote` 与 `pinCite`。
- `targets.length === 0`：不编译图，主输出「未提供证据目标，已拒绝改为自行检索」。假检索器调用次数为 0。
- 有目标但某目标没有任何 `quote`：仍运行对比，报告里该目标标 `needs-evidence`。

`patent_invalidation_v1` 的 claim-chart 参数保持 `chart_mode: "invalidity"`。

**验收。** 两个带引文的目标：`nodeDurations` 不含 `search`，报告里的文献 id 等于目标 id。空 `targets`：检索 0 次，且没有 `nodeDurations`（因为没跑图）。缺省构建的创造性图在测试注册表含 search handler 时仍然包含 `search` 节点。

### M7 程序清单

**决策。** 纯函数 `buildProcedureChecklist`。原子 `procedure-checklist`，类别 `gate`，放在无效清单的 `approval` 之前。主输出 `procedure_checklist`。

文首固定第一行：

`本清单用于核对程序事项与证据对应关系，不是复审请求书，也不是无效宣告请求书。`

期限：

- `kind: "reexamination"` 时调用 `evaluateDeadlines`。申请日、今天、专利类型、是否主张优先权只作为函数参数，不写入清单正文。
- 从返回项里只取 `id === "reexamination-request"`。pending 时抄 `reason`（现文案：「需要驳回决定的送达记录，本查询未提供该通知。」）。不渲染该次求值里的其它条目，避免把年费日期写进复审清单。
- 求值抛错（缺申请日、缺今天、缺日历）时，期限行为 `not_evaluated`，写出错误信息，不编日期。
- `kind: "invalidation"` 不调用复审规则。期限行固定「无对应期限条目」。

理由与证据：

- 对 `text` 调用 `classifyGrounds`。无效清单的 `dispute_framing` 在自动路径是「未识别争点」，不能当理由来源。
- `unidentified` → 理由行 `blocked`，说明「未从输入识别审查或无效理由」。
- 每个非 `unidentified` 代码至少要在对照表里有一个目标，否则 `blocked`。
- M6 报告若含「自行检索」字样 → `blocked`。本计划的 M6 不应产生该字样，这是防止以后改回去。

不新增 HTML 模板，标题不用「请求书」。

**验收。** 无送达记录的复审清单含上述待定句子，且不含 `20` 开头的日期（夹具的申请日若必须是参数，选一个不会和待定句子混淆的值，并断言输出里没有 `computed` 条目的日期字段）。空对照表 → `blocked`。无效 kind 的期限行是「无对应期限条目」。文首是第一行。

### M8 跨表用词

仅当同一 `caseId` 下侵权与无效的 `claim-chart.json` 都存在时比较。相等判断用 M0 的归一化。差异输出 `{ elementId, infringementText, invalidityText }`，不扩展 `ArgumentGapSource`。只有一张表时返回 `{ skipped: "single-chart" }`，不阻断。

**验收。** 只差全角空格不算差异。差一个技术词有一条记录。单表是 `single-chart`。

### M9 CAD 规则

`CadRuleId` 目前到 C12。新增：

- `C13`：渲染后标号数 > 20 → `warn`，建议拆图。不 fail。
- `C14`：可见边包围盒面积 / 可印区面积 < `CAD_MIN_INK_AREA_RATIO`（0.25）→ `warn`。消息写明是工程判据，不是法条。无渲染结果时跳过，与 C2/C3 一致。

不改 `practicalMinCharHeightMm`。

**验收。** 21 个标号一条 C13。极小包围盒一条 C14。C1–C12 既有用例的严重级别不变。

### M10 夹具

`tests/patent/fixtures/oa/` 放 8 个 JSON：4 个含两段标题，期望 `anchored` 或 `unsupported`；4 个空 `targets`，期望检索 0 次。内容用虚构短句，不含客户案卷。

`tests/patent/oa/fixtures.spec.ts` 读取这些文件并断言。JSON 本身不会被 `node --test` 执行。

不引用 `patentbench` 或 `abigail`。

---

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 连续子串把合理的上位概括全部判成 `unsupported` | 这是预期。进入人工确认，不自动改写。决策记录写明不做语义概括 |
| 抽出召回提示词改变创造性图 | 字符串快照。该 PR 不改 schema |
| `supplied` 仍插进 search 节点 | 验收用 `nodeDurations`。代码评审看「handler 存在也跳过」的分支 |
| 旧 manifest 断点对不上新阶段 | 不迁移旧 checkpoint。发布说明写明 OA 与无效清单的未完成运行需重跑 |
| `recall` 可选参数误伤旧质量门 | 未传时走原正则。既有 `checkSearchQuality` 测试不改期望 |

## 7. 备选方案

- **整个创造性图作为一个无效阶段。** 落选。图内有检索和自己的审批门。
- **靠从注册表删掉 search handler 来表示证据模式。** 落选。开关不在类型里。
- **OA 结束时 `recordRevision`。** 落选。见第 2 节。
- **为原申请文本新增工具字段。** 落选。会改 `inputSchema`，触发 llm-replay 重录。改用 `input` 内的标题段。
- **本计划顺手完成撰写增强计划的跨段锚点与 A26.4。** 落选。那是另一份计划的 M1/M2，验收口径不同。
- **中国附图字高提到 3.5 mm。** 落选。与 `check.ts` 记载的条文范围不符。

## 8. 验证

每个里程碑合并前跑受影响的 `tests/patent/**/*.spec.ts`。改了 manifest 的里程碑（M3、M5、M6、M7）加 `pnpm check:patent-workflow-docs`。新增原子的里程碑加 `pnpm check:doc-claims`。全部合入前跑 `pnpm check`。没跑的门禁在 PR 说明里标成未跑，不写成通过。

## 9. 估时

约 16.5 人日。M8 与 M9 约 2.5 人日，不计入 R1–R4。

## 10. 实施记录（2026-11-07）

| 里程碑 | 状态 | 主要落点 |
|---|---|---|
| M0 连续子串锚点 | 完成 | `src/patent/anchor/`、`tests/patent/anchor.spec.ts` |
| M1 理由分型 | 完成 | `src/patent/oa/grounds.ts`、`tests/patent/oa/grounds.spec.ts` |
| M2 修改差分 | 完成 | `src/patent/oa/amendment-diff.ts`、`tests/patent/oa/amendment-diff.spec.ts` |
| M3 `draft-oa` | 完成 | `atoms/handlers/builtin/oa.ts`、`manifests.ts`、`tests/patent/oa/{atoms,manifest-run}.spec.ts` |
| M4 轮次快照 | 完成 | `src/patent/oa/round-snapshot.ts`、`paths.ts`、`tests/patent/oa/round-snapshot.spec.ts` |
| M5 撰写补检 | 完成 | `src/patent/search/recall.ts`、`search-recall` 原子、`checkSearchQuality` 可选 `recall` |
| M6 证据模式 | 完成 | 图 `evidence` 选项、`invalidity-analysis` 原子、`tests/patent/invalidity-evidence-graph.spec.ts` |
| M7 程序清单 | 完成 | `src/patent/procedure/checklist.ts`、`procedure-checklist` 原子 |
| M8 跨表用词 | 未开始 | — |
| M9 CAD C13/C14 | 未开始 | — |
| M10 夹具 | 未开始 | — |

验证：`pnpm build`（Node 22.23.1）后 `node --test dist/tests/patent/**/*.spec.js`，1956 项 / 1955 通过 / 1 既有 skip / 0 失败；`check:patent-workflow-docs`、`check:doc-claims`、`check:patent-sop` 均 fresh。
