# 专利核验闭环（A 批）实施计划

> 来源：`docs/research/dsh-patent-document-delta-2026-10.md` §6 批次 A（P0）
> 编制日期：2026-10-15
> **实施状态：A1 / A2 / A3 / A4 全部已落地（均 2026-10-15）。** 各自的实测结论已**就地回填**到对应小节（A1 见 §3.3.1 的三条被推翻假设；A3 见 §5 开头的两条；A4 见 §6 开头的四条）。文中"已实测"一般指自研究报告 §5 的探针结果。
> 适用范围：A1 申请文件 DOCX 成品核验 / A2 法条引用核验 / A3 法定期限 / A4 官费。B 批（文档模式）与 C 批不在本文件。
> 方法：语义移植，不跟版（dsh 是 developer preview，无兼容性承诺）。**成本在判定不在搬**——每个包的"搬"都很便宜，"判定它在 Sati 的形态与边界"才是主体工作量。

---

## 〇、一句话

Sati 专利域缺的不是生成而是**核验**。A 批补上四类**可机械核算的事实**：成品 DOCX、法条引用、法定期限、官费。
四项共同纪律：**无据即拒绝出数**——没有依据时不给一个"看起来对"的数字，且"未核验"与"已核验且无问题"必须在输出里可区分（AGENTS.md 规则 11）。

四项共同成本：**每一项都要过重放契约门**（见 §7.2.1，这是本批最容易被漏掉的排期项）。

---

## 一、范围与红线

### 1.1 做

| 序 | 项 | 新增/改动 | 域 |
|---|---|---|---|
| A1 | 申请文件 DOCX 成品核验 | 改 `src/patent/document/docx/` + `renderPatentDocument.ts` | — |
| A2 | `law_verify` 法条引用核验 | 新增 `src/knowledge/legal/law-verify.ts` + 工具 | `legal` |
| A3 | `patent_deadlines` 法定期限 | 新增 `src/patent/deadline/` + 工具 + 日历资产 | `patent` |
| A4 | `patent_fees` 官费 | 新增 `src/patent/fees/` + 工具 + 费率资产 | `patent` |

### 1.2 不做（红线）

| 不做 | 理由 |
|---|---|
| 不引入 dsh 的随包法条索引（`patent-law/assets/law/*.yaml` 共 678 行 + `patent-index-asset` 251 行 loader） | **Sati 的 knowledge.db 已是更全的索引**（§2.1 实测），引入等于建第二套法条源 |
| 不引入 `patent-filing` 的 Python 引擎（`assets/engine/*.py` 共 1 189 行） | 会造第二套渲染管线，与现有 1 455 行 TS docx 渲染链路冲突；AGENTS.md 边界纪律不允许 |
| 不建新 Graph 节点 / 不改造 manifest / 不改 AgentEvent 与 gateway frames | A 批是"接入现有链路"，四项都不需要新架构面 |
| 不引入 dsh 的 `patent_fees` 工具 schema（照抄其入参形态） | 语义移植：Sati 的入参口径由 A3 的期限输出决定（§2.4） |
| 不做 B 批（文风层 / 交付登记 / 前置交付门）与 C 批 | B4 的 `deliveryGate` 依赖 A2 的 `law_verify` 作为被担保动作——**B4 排在 A2 之后**，不在本批 |

### 1.3 与 dsh 的关系

按 `docs/pilotdeck-2026-10-upstream-port-plan.md` 的方法论：**按语义重写，不建立跟版机制**。dsh 是 developer preview，其 Known Limitations 已声明兼容性破坏；本计划里所有 dsh 行号为 2026-10-15 快照。

---

## 二、开工前必须知道的四件事（本轮新调研，直接改变设计）

> 这一节是本计划相对研究报告的**增量**：研究报告列了"引入什么"，本节给出"在 Sati 怎么落"的三个结构性判断与一次自我纠错。

### 2.1 【关键】A2 不需要随包索引——Sati 的 knowledge.db 已是更全的索引（已实测）

研究报告 §6 把 A2 的成本估为"中"，依据是 dsh 的 `patent-law` 1 428 行 + 随包索引 1 164 行。本轮直接对 `~/.sati/knowledge/knowledge.db` 跑了探针：

| 法源 | knowledge.db 文档 | 条号完整性（实测） |
|---|---|---|
| 中华人民共和国专利法 | `raw:法律法规司法解释_md:中华人民共和国专利法_20201017` | 行首 `第N条` 命中 **82** 条，`1..82` **无缺号** |
| 中华人民共和国专利法实施细则 | `raw:法律法规司法解释_md:中华人民共和国专利法实施细则_20231211` | 命中 **149** 条，`1..149` **无缺号** |
| 专利审查指南 | `raw:审查指南_md:*`（`doc_type='guideline_rule'`） | 112 篇章节级文档（第一部分/第三部分/第四部分为全文，第二部分为分章） |

**结论**：A2 走 knowledge.db，**不搬随包索引**。三处直接收益：
1. 省掉 678 行 YAML 资产与 251 行 loader；改为复用 Sati 已有的 `src/knowledge/legal/article-parser.ts`（`splitLawIntoArticles` / `normalizeArticleId` / `parseHeading`）。
2. 覆盖**反而更全**：dsh 的 `cn-patent-law.yaml`(349) + `cn-implementing-regulations.yaml`(269) + `cn-examination-guidelines.yaml`(60) 是摘要级索引；knowledge.db 是全文。
3. 与 `law_search` **同源同降级**——DB 不可用时两者一起报 `setup_required`，不会出现"检索说没有、核验说有"的分裂。

**代价（必须认）**：A2 从此绑定 knowledge.db 可用性。降级路径必须与 `law_search` 逐字同口径（`checkAvailability → setup_required` + 显式错误文案），**不得**在 DB 不可用时静默放行引用。

### 2.2 【关键】A1 在 Sati 的收益结构与 dsh 不同——体例是白送的，内容才是价值

dsh 的 `verify.py` 把断言分三类（体例 / 内容 / 痕迹）并强调"体例是静默缺陷高发区"。这个判断**在 dsh成立**——它的渲染器要自己拼版面。

**Sati 不是**：`renderApplicationDocx` 的设计是**复用母版整包**（页眉页脚/样式/主题/页面设置一律不动），只重建 `w:body`。所以"分节数 / 各节页眉 / 行距 / 字号"这些断言在 Sati **大部分天然成立**——除非母版换版。

→ A1 的评价标准要重排：

| 断言类 | 在 dsh 的价值 | 在 Sati 的价值 |
|---|---|---|
| 体例（分节/页眉/行距/字号） | 高（自拼版面） | **低~中**：日常是白送的，价值在**母版漂移的回归防线**（换模板/升级 Word 母版时） |
| 内容（五部分齐备 / 权项 / 编号连续 / 附图数） | 高 | **高** |
| **每节非空** | 高 | **最高**——见下 |
| 痕迹（内部标记 / 待补充） | 高 | **中~高**：且应**复用 Sati 规则资产已有的禁用词**，不引入第二张表 |
| 模板指纹（与母版对拍） | 高 | **高**，且 Sati 已有全部构件 |

**A1 的切入点是一个现存静默缺陷**（源码可指认，无需探针；**已修，见 §3.3**）：`src/patent/document/docx/renderApplicationDocx.ts:213-216` 只在**全部**件都为空时告警——

```ts
const providedParts = APPLICATION_PARTS.filter(part => (input.parts[part.id] ?? "").trim() !== "");
if (providedParts.length === 0) {
  warnings.push(`sections 未包含任何申请文件件内容（…）`);
}
```

即**单件为空是静默的**：调用方给了权利要求与说明书、漏了摘要，成品会少一整节，而**分节数、页眉、页码全都照样正确**。这正是 dsh `verify.py` 称之为"静默缺陷"的形态，也是 A1 便宜且立刻有收益的原因。

→ **A1 的形态照抄 Sati 自己的 `patent_figure_check`**（`src/tool/builtin/patentFigureCheck.ts`）而不是照抄 dsh 的工具：它已经确立了"入参两选一"的双入口模式——① 结构化期望值（渲染时）② 回读已交付文件（`svg_paths`）。A1 对应为 ① 渲染内自校验 ② 可选的回读核验入口（§3）。

### 2.3 【关键】A3 的日历是纯新增，且 20 年期限**必然越界**——需要口径决策，不能照搬

研究报告 §5.7 已实测：dsh 的 `cn-holidays.yaml`（114 行）只覆盖 **2025–2026**；一个 2026 年申请的发明案 8 条期限里 **5 条**带 `calendar-uncovered-year` 告警，其中含**必然越界的 20 年专利期限**。

本轮新确认两点：
1. **Sati 侧完全没有节假日设施**（`grep 节假日|holiday|workday|工作日` 在 `src/`、`assets/`、`rules/` 只命中 `patentCache.ts` 的注释里"工作日志"一词，是误报）。
2. 所以这不是"移植一个已有日历"，而是**从零建一个需要逐年维护的数据资产**。这是 A3 里**最容易被排期漏掉**的部分。

三个口径与推荐：

| 口径 | 未覆盖年份的行为 | 评价 |
|---|---|---|
| A（照搬 dsh） | 给 `dueDate` + `calendarCaveat` 告警 | 告警会在**大多数**条期限上出现 → 变成噪音；且 `dueDate` 字段本身"看起来正常"，消费者极易忽略旁挂的 caveat |
| B（精确顺延 + 分层报告） | **不给 `dueDate` 字段**，给 `rawDueDate` + `dueDateLowerBound`（仅按周六日顺延）+ 显式 `rollForward: "weekend-only"` | 期限能力在 2027+ 仍可用；降级被**字段缺失**表达（比旁挂告警更难忽略） |
| C（保守拒绝） | 该条 `pending`，`requiredInput = "该年度国务院节假日安排"`，不给任何日期 | 最保守，但 **20 年专利期限永远 pending** → 报告失去价值 |

**推荐：B，但对期限分型**——引入一条 dsh 没有的元数据 `requiresFullCalendar: boolean`：

- **`requiresFullCalendar: true`**（期限届满日是"要做某事的最后一天"：办理登记手续、答复通知书、缴纳年费滞纳期）→ 未覆盖年份**降级为 C 形态**（`pending`，指名缺口）。理由是这类日期的用途就是"人在那天办事"，给下界会诱导误期。
- **`requiresFullCalendar: false`**（长周期/参考性：专利权期限届满、优先权期限）→ **B 形态**（`rawDueDate` + `dueDateLowerBound`）。理由是这类日期用于**排期与告知**，下界是有用信息。

**方向性必须写进文案**：`dueDateLowerBound` 是**不早于**的下界（真实法定假日只会让日期更晚或相同）。把它当"最晚日"用会误期——工具描述与报告里都要点名。

**代价**：口径分型是 Sati 的独立判断（dsh 只有 `restDayRule: apply|omit`），移植 dsh 的 `statutes.ts`（912 行）时**每一条期限都要判一次分型**。这是 A3 的主要工时，不是"搬 912 行"。

### 2.4 A4 依赖 A3 的口径（顺序硬约束，已核实）

dsh 的 `patent_fees` **不算日期**：年费的"第几年度 / 滞纳第几月"是**入参**，由 `patent_deadline` 提供。所以 A4 不能先于 A3 落定"年度"的口径。已实测的计价断言（12 项权利要求发明申请 → 合计 1 250.00；含延长期限请求费 → `total.amount = null` 且指名 `unverifiedIds: ["extension-fee"]`；减缴 `filed:true` → 实用新型申请费 75.00；年费走 `tiers` 分档）在 Sati 侧要**重跑一遍**才能算数（§7.3）。

### 2.5 本轮第 4 次自我纠错：我的探针函数有缺陷，差点误判"知识库缺条"

查实施细则完整性时，我自写了一个中文数字转阿拉伯的函数，得出 `1..100` 连续、**`第101条` 缺失**，第一反应是"knowledge.db 的实施细则有缺条，A2 的上界判定不可靠"。

**这是错的**。我的函数没处理"零"：`第一百零一条` → 我算成 NaN 被过滤掉。改用 `src/rule/runtime/text-utils.ts:106` 的 `parseCnNumber` **逐字移植**后：实施细则 **149 条，`1..149` 无缺号**。

**由此定下一条实现纪律**：A2 的条号解析与上界判定**必须调用 Sati 已有的 `parseCnNumber` / `normalizeArticleId`**，**不许自造近似实现**。近似实现既能假阴（把存在的条判成缺）也能假阳。这也是研究报告 §5.8 那条纪律的第 4 次实例：探针能证伪，也能造假。

---

## 三、A1 —— 申请文件 DOCX 成品核验

### 3.1 落点

| 动作 | 文件 |
|---|---|
| 新增核验器 | `src/patent/document/docx/verifyApplicationDocx.ts` |
| 导出 | `src/patent/document/docx/index.ts` |
| 接线（渲染内自校验） | `src/patent/document/renderPatentDocument.ts` 的 docx 分支（现 `:210-222`） |
| 结果类型 | `src/patent/document/types.ts` 的 `DocumentRenderResult` |
| 复用（无需新写） | `applicationTemplate.ts` 的 `splitDocumentBody` / `topLevelElements` / `extractText` / `extractSectionProperties` / `paragraphPropertiesXml` / `deriveBodyParagraphProps` / `deriveTitleStyleId` / `readContentArea` |
| 测试 | `tests/patent/document/docxVerify.spec.ts`（新建）+ 扩充 `applicationDocx.spec.ts` |

**不做独立 Python 引擎**，也不新起第二套 OOXML 解析：核验器只消费 `applicationTemplate.ts` 已有的解析原语。

### 3.2 接口

```ts
export type DocxVerifyFinding = {
  /** 断言 id（稳定，可被测试与报告引用）。 */
  id: string;
  /** fail = 成品不得定稿；warn = 报告但不阻断。 */
  severity: "fail" | "warn";
  /** 人读一句话（含实测值）。 */
  message: string;
  /** 机械证据（段落下标 / 分节 key / 实测值），供回归测试断言。 */
  evidence?: string;
};

export type DocxVerifyResult = {
  passed: boolean;                       // = findings 中无 severity==="fail"
  findings: DocxVerifyFinding[];
  info: {
    sections: DocxVerifySectionInfo[]; // 逐节实测：part / headerTitle / paragraphs / figures / tables
    headers: string[];
    template: { sections: number; bodyFirstLine: string | null } | null; // 未提供母版时 null
    residueMarkersChecked: boolean; // 未注入词表即 false（降级不静默）
  };
};

export async function verifyApplicationDocx(input: {
  docxPath: string;
  /** 期望值：渲染路径直接传调用方给 renderApplicationDocx 的 parts；回读路径可不传。 */
  expected?: { parts: Readonly<Record<string, string | undefined>>; template: DocumentTemplateId };
  /** 内部标记词表；不传即不检查（`residueMarkersChecked` 如实报告）。 */
  residueMarkers?: readonly string[];
}): Promise<DocxVerifyResult>;
```

**双入口**（照 `patent_figure_check` 的模式）：

1. **渲染内自校验**（默认开）。⚠️ **实际接在 `renderPatentDocument.ts` 的 docx 分支，不在 `renderApplicationDocx` 内部**——「写出」与「读回」分属两层，且降级语义要与既有的 `docxError` 对齐。渲染成功后 `verifyApplicationDocx({ docxPath, expected: { parts, template } })`，结论挂到返回值 `docxVerification`。若含 `fail` → **按现有降级形态处理**：不抛错（HTML 仍是可用产物），把 `docxError` 指向核验结论，并保留 `docxPath`（让用户能拿到文件自己看）。**不静默**：工具输出里核验通过给一行实测摘要、未过与未执行给各自的 `docxError` 行——四种状态必须可区分（§3.4）。
2. **回读核验**（可选，A1b）：独立工具 `verify_patent_docx`（`docx_path` 入参），用于核验**非本管线产出**的 docx（客户给的、历史产物）。**A1b 可不做**，因为它是新工具、会触发重放重录（§7.2.1）；建议先不做。纯函数入口 `verifyApplicationDocxPackage` 已具备该能力，将来加工具只是接线。

### 3.3 断言清单（**已落地**，以代码为准）

> 判据的来源是 dsh `verify.py`（293 行）的**分类法与清单**；每一条都在 Sati 的渲染事实上重新判定过。
> 与计划不同的三条单列在 §3.3.1——它们不是实现细节偏差，而是计划里的假设被实测推翻。

**A 组 · 内容（Sati 的主价值区）**

| id | 判据 | 严重度 |
|---|---|---|
| `part-content-absent` | 件内容为空/未提供 且 成品该节无内容 → **逐件点名**（§2.2 那个静默缺陷的正解） | warn |
| `parts-nonempty` | 件内容含**非空文本** 而 成品该节段落+表格 = 0 → 渲染丢失的红线 | fail |
| `figures-not-landed` | 件内容声明 N 张图（复用 `htmlToBlocks` 数）而 成品该节 0 张 → 图片未落地（渲染告警已给原因） | warn |
| `part-section-missing` | 成品里找不到该件分节 → 包结构异常 | fail |
| `parts-none-provided` | 五件全未提供 → 单条提示（不刷五条） | warn |

**B 组 · 体例（Sati 侧多为"不变式核验"）**

| id | 判据 | 严重度 |
|---|---|---|
| `section-count` | 成品分节数 ≠ 母版分节数 | fail |
| `headers-unchanged` | 各节页眉序列 ≠ 母版序列 | fail |
| `first-line-indent` | 图片段/标题段要求 `w:firstLine="0"`；正文段要求 = 母版派生值。**核结果（段落实际值），不核形式（是否显式写）** | fail |
| `first-line-indent-unresolved` | 段落未携带 `w:ind@w:firstLine`（缩进靠样式继承）→ 本次未能核验 | warn |
| `no-run-color` | run **自身** `w:rPr` 内 `w:color` 非 `auto`/`000000` | warn |

**C 组 · 痕迹**

| id | 判据 | 严重度 |
|---|---|---|
| `residue-marker` | 调用方注入的 `residueMarkers` 命中成品全文 | fail |

**D 组 · 模板指纹**

母版指纹不单列 id：它是 `section-count` + `headers-unchanged` + `first-line-indent` 三条的**共同输入**
（三者都比对母版），并在 `info.template` 里报出 `{ sections, bodyFirstLine }` 供报告引用。

**未做的三条（显式记录，不是遗漏）**

| 计划里的断言 | 为什么没做 |
|---|---|
| `spec-headings`（说明书五部分标题齐备） | 词表要与 `skills/patent-*` 的既有分区对齐，否则会给正当文书误报；且它属**内容正确性**判断，与"落地核验"不同层 |
| `claims-present`（识别到 ≥1 项权利要求） | 同上：权项格式多变，机械识别易误判；`parts-nonempty` 已保证"内容落地" |
| `numbering-continuity`（`[NNNN]` 连续） | **无主体**：`htmlToOoxml` 没有编号机制，Sati 侧没有声明编号的入口（见 §3.3.1 第 3 条） |

### 3.3.1 三条被实测推翻的计划假设

开工第一步按要求核了计划里标"待核实"的三条，**三条的结论都与计划写的不同**——照原计划实现会全量误报，故记录在此：

| 计划里的假设 | 实测 | 后果 |
|---|---|---|
| `first-line-indent`：图片段与名称行**显式零缩进** | **不显式写**。`ooxml.ts` 的设计是「样式全部来自模板」：正文段与图片段直接复用母版派生的 `w:pPr`；而母版正文段落**自带** `w:ind w:firstLine="0"`，成品段落是**继承**到零缩进的 | 改为核**结果**（段落实际 `w:firstLine`），不核是否显式写。照搬"显式写"判据会让**每一份正常成品的图片段都被报 fail** |
| `no-inline-color`：正文 run 不带非黑 `w:color` | 母版段落标记的 `rPr` 里**确实带** `w:color w:val="auto"`；`TextFormat` 无 color 字段，`renderTextRun` 不写颜色 | ① `auto` 与 `000000` 同列合规（dsh 的 `!= "000000"` 判据会**每份成品都报**）；② 颜色只扫 run 自身 `rPr`，**不扫段落标记 `rPr`**（后者在 `w:pPr` 内） |
| `numbering-continuity`：待决策是否要求 `[0001]` 编号 | `htmlToOoxml.ts` 与 `applicationTemplate.ts` **都没有**编号机制，编号只能由调用方写进内容 | 该断言**无主体**，默认不开（与 dsh「按 spec 声明生效」同构，但 Sati 侧尚无声明方） |

### 3.4 判定与降级

- `passed = findings 无 fail`。有 fail **不删除产物**（HTML/PDF/docx 都留下）。
- **四种状态在返回值里可区分**（`src/patent/document/types.ts` 的 `docxError` 注释即契约）：

| 状态 | `docxPath` | `docxError` | `docxVerification` |
|---|---|---|---|
| 生成成功 + 核验通过 | 有值 | 空 | `passed: true` |
| **生成了但没过核验** | **有值** | 非空（含「核验未通过」） | `passed: false` |
| 根本没生成 | 空 | 非空（渲染原因） | 无 |
| 核验器自身未能执行 | 有值 | 非空（含「核验未能执行」） | 无 |

- **图片未落地只判 warn**：图片要读外部文件，读不到时渲染器已在 `warnings` 里给了原因，核验层不把「输入引用了不存在的图片」升级成「渲染失败」——守住既有的「图片不可读时告警但不失败」契约。
- **工具输出里同样可区分**（`src/tool/builtin/renderPatentDocument.ts` 的 `formatRenderResultLines`）：核验通过 → 一行实测摘要（`DOCX 成品核验通过（N 节，M 段，K 图）`）；未过 / 未执行 → 各自的 `docxError` 行；根本没生成 → 只有 `DOCX 生成失败：…` 且**无路径行**。
  - **通过行是必需的**：否则「已核验且无问题」与「未核验」在输出里都只剩一行路径、彼此同形（规则 11）。
  - ⚠️ **工具层原有一个洞**：`docxPath !== undefined` ⇒ 只打路径、**丢弃** `docxError`。核验接入前无碍（那时 `docxError` 非空只可能是没生成），接入后却让「**生成了但没过核验**」在输出里完全不可见。已改为两个条件各自独立判出，见决策记录 Decision 第 7 点。
- 适用面：**只有 `claims-spec` 模板随附 `assets/template.docx`**（已核实），其余 4 个模板走不到 docx 路径。

### 3.5 测试（已落地）

`tests/patent/document/docxVerify.spec.ts`，11 用例，三层：

| 层 | 用例 |
|---|---|
| 纯函数 | `auto`/`000000` 不误报、彩色才报；段落标记 `rPr` 不计入 run 色；正文段缩进偏离母版值 fail、图片段非零 fail；词表未注入时 `residueMarkersChecked === false`、注入后命中 fail |
| 端到端 | 五件齐备 `passed` + 分节计数与母版对拍 + 同文件复跑结论一致；漏件逐件点名且不阻断；件内容全空只报一条；内容传入却未落地 fail（**用空母版当成品构造**）；缩进被改坏 fail；少一节 fail；页眉被改 fail |
| 守契约的负例 | 图片不可读 ⇒ `figures-not-landed` warn 且 `docxError` 为空；核验器自身失败 ⇒ 抛错（由渲染路径转成「核验未能执行」） |

工具层另有 `tests/tool/builtin/renderPatentDocumentTool.spec.ts` 的 **6 用例**钉住输出行（PDF 未生成补前缀；有路径但无核验结论时不得说「核验通过」；核验通过给实测摘要；核验未过时路径行与问题行并存；核验未能执行如实报出；根本没生成则无路径行）——即 §3.4 那个洞的回归防线。

### 3.6 验收判据（机械可核，**已实测**）

1. **只给 claims + specification** 渲染：返回值里逐件点名 `part-content-absent`（`abstract` / `abstract-figure` / `drawings`），且 `passed === true`、`docxError` 为空——内容缺失是输入事实，不阻断交付。
   （**修订**：计划原写"fail"，实测改为 warn，理由见 §3.4。）
2. **内容传入但成品该节为空** → `parts-nonempty` fail、`passed === false`、`docxError` 非空且 **`docxPath` 保留**（文件在、但没过核验）。
3. 正常五件套 → `passed === true`，`info.template.sections === info.sections.length`，各件段落/图片计数可读。
4. 同一文件复跑两次结论一致（确定性，无时间/随机依赖）。
5. **母版自带 `w:color="auto"` 不得报 `no-run-color`**（回归 §3.3.1 第 2 条）。

### 3.7 会破坏什么

- **重放契约：本次未触发重录（已实证）。** 只加了 `DocumentRenderResult` 的返回字段，**未改任何工具的 `inputSchema`**；请求键（`requestKey.ts` 的 `tools: [{ name, inputSchema }]`）不含 `outputSchema`。`llm-replay-real.spec.ts` 的真实 fixture 无 key 重放仍绿。
  - 由此得到通用判据（后续 A2/A3/A4 适用）：**改返回值不触发重录，改入参才触发**。
- **`DocumentRenderResult` 新增 `docxVerification` 字段**（可选，additive）；`docxError` 的含义被明确并写进类型注释——**只看 `docxError` 判断成败的消费方现在也会看到核验失败**（有意为之）。
- 不涉及事件面、不涉及 i18n（核验报告是工具结果文本，不是 UI 文案）。若后续要在 UI 呈现核验结论，**须按规则 4 提取 i18n 文案**。
- 新增决策记录 `docs/notes/implemented/2026-10-15-docx-finished-product-verification.md`。
- 新增源文件与测试文件会改变事实层：`pnpm measure:update` 与 `pnpm gen:doc-claims` 已随本次刷新（`check:techdebt-metrics` / `check:doc-claims` 均已绿）。

---

## 四、A2 —— `law_verify` 法条引用核验（**已落地 2026-10-15**）

> **实施结果**：工具已落地（`law-index.ts` / `law-verify.ts` / `law-verify-tool.ts`，19 用例全绿，
> 含真实知识库集成断言）。实测推翻了本节的**四处**计划假设——§4.1 第 2 行（复用取全文）、
> §4.2（命题判据依赖的词表）、§4.3（选源判据的边界）、§4.7（同义改写的期望值），
> 逐条已在原位标注修正。决策记录：`docs/notes/implemented/2026-10-15-law-verify-citation-check.md`。
> 重放契约如 §4.8 所料**确实触发了重录**（加工具必然触发，与 A1「只改返回值不触发」形成对照）。

### 4.1 落点

| 动作 | 文件 |
|---|---|
| 新增核验核心 | `src/knowledge/legal/law-verify.ts` |
| 新增索引构建（条号上界 + 收录集） | `src/knowledge/legal/law-index.ts` |
| 新增工具 | `src/knowledge/legal/law-verify-tool.ts` |
| 注册 | `src/tool/registry/createBuiltinRegistry.ts`（与 `:435` 的 `law_search` 相邻） |
| 导出 | `src/knowledge/index.ts`（现 `:81` 导出 `createLawSearchTool` 处） |
| 复用 | `article-parser.ts`（`splitLawIntoArticles` / `normalizeArticleId` / `parseArticleHeading`）、`resolveKnowledgeDbPaths` |
| ⚠️ **不许复用**（实测推翻） | ~~`knowledge-law-search.ts`（取全文）~~：它的 `getById`/`findByName` 是 `ORDER BY char_count DESC LIMIT 1`，**只取最大的单个 chunk**。实测专利法全文 11 318 字分散在 **27 条** chunk 里，最大一条仅 498 字 ⇒ 取全文必须自己按 `chunk_index` 拼全部 chunk（见 `law-index.ts` 的 `readFullText`） |
| **必须复用，不许自造** | `rule/runtime/text-utils.ts` 的 `parseCnNumber`（§2.5） |
| 测试 | `tests/knowledge/legal/law-verify.spec.ts`（目录按 `tests/` 镜像 `src/` 惯例） |

### 4.2 接口与判定

决策枚举**逐字对齐** dsh（`packages/patent/patent-law/src/verify.ts:147-153`），因为这套词汇已经在研究报告里用于描述 Sati 的缺口，改词会造成两份文档对不上：

| decision | 触发条件 | 默认 policy |
|---|---|---|
| `valid` | 条号在收录集内，且命题匹配 | `allow` |
| `mismatch` | 条目主题与命题不符；或引用第 N 款而条目载明无第 N 款 | `block` |
| `out-of-range` | 条号 > **已核验上界** `maxArticle` | `block` |
| `not-indexed` | 条号 ≤ 上界但不在收录集内 | `warn` |
| `unverified` | 条目在索引中但条文未转录核验 | `warn` |

**上界 `maxArticle` 的取法**（与 dsh 的差别所在）：dsh 的 `maxArticle` 来自随包索引的声明字段；Sati 从 knowledge.db **现算**——把该法律全文按 `splitLawIntoArticles` 切分、条号经 `normalizeArticleId` + `parseCnNumber` 归一，取"`1..N` 全部在场"的最大 N。已实测：专利法 N=82、实施细则 N=149。

> ⚠️ **不许用"最大条号"代替"连续上界"**：文本只要漏一条，最大条号仍可能正常，但 `1..N` 不连续就说明中间有缺——此时**必须降级**（`not-indexed` 从 `warn` 升级为"索引不完整"的显式报告），否则缺的那条会被判成 `not-indexed`（看起来像"你没引对"），而真相是"索引没抄全"。**这是"谁因此漏了什么"的典型**：索引缺条会伪装成引用错误。

**指南引用**：dsh 用 `guideline-section` 的 `path`。⚠️ **指南全文不在 `law_search` 的查询面里**——该引擎的查询全部带 `doc_type = 'law_article'` 过滤（`knowledge-law-search.ts:120,136,149`），而指南是 `doc_type = 'guideline_rule'`（实测 112 条）。指南核验必须走**独立查询**，不可复用 `KnowledgeLawSearch`，否则会得到"全部 `not-indexed`"的假结论。Sati 侧的对应物是 knowledge.db 的 `raw:审查指南_md:<部分><章>-<题>` 文档标题。第一期**只做"标题存在性"核验**（章节存在 → `valid`；不存在 → `not-indexed`），并**恒标 `unverified`**——因为"该章节内容是否支撑该命题"机械判不了。这与 dsh 对未转录指南的处理一致（已实测：指南引用恒 `unverified`）。

**上界不可证明时的诚实**：dsh 区分"超过**已核验**上界"（`out-of-range`）与"超过未核验上界"（`unverified`）。Sati 侧对应：若索引构建因全文缺失/解析失败而**无法证明**上界，则不得给 `out-of-range`，只能给 `not-indexed` + 显式说明"本次未能证明上界"。

### 4.3 索引源选定（必须先拍板，否则上界判定会错乱）

knowledge.db 里**同一部法律有多个来源**。实测 `title LIKE '%专利法%'` 的 `law_article` 文档共 **10 条**：

| 来源 | 条数 | 体量 | 性质 |
|---|---|---|---|
| `raw:法律法规司法解释_md:中华人民共和国专利法_20201017` | 1 | 11 318 字 | **全文，82 条完整** |
| `raw:法律法规司法解释_md:中华人民共和国专利法实施细则_20231211` | 1 | 26 566 字 | **全文，149 条完整** |
| `wiki:法律法规:法律:专利法-2020` 及 8 个拆分件 | 8 | 267–1 547 字 | 摘要 / 分拆碎片，**不是全文** |

若索引构建只按 `title` 模糊匹配遍历，会把 8 条碎片混进来 → 上界判定错乱、合法条号被判 `not-indexed`。**必须先选定唯一权威源**：

1. **候选**：按法律名选出同名文档集合；
2. **判据**：对每个候选跑条号扫描（`splitLawIntoArticles` + `normalizeArticleId` + `parseCnNumber`），取 `maxContig`（`1..N` 全在场）最大者为权威源；
3. **记录**：把选中的 `documents.id`、`maxContig`、候选数与落选原因**写进核验报告**——"选源"本身是一次判定，不许静默（同一部法将来若多出更全的一份，报告要能看出这次选的是哪一份）。

> 不按 `source='raw'` 前缀硬编码，是为了让判据对**将来新增的法源**同样成立；前缀只作为报告里的可读标注。
>
> ⚠️ 已实测的 82 / 149 是**指定到具体 docId** 得到的结果（§2.1）。索引构建实现后必须**用同一组反例复跑**（§4.7），确认自动选源选中的正是这两份。
>
> ✅ **已复跑**：自动选源选中的正是这两份（专利法 82 / 实施细则 149），8 条 wiki 碎片全部落选。
>
> ⚠️ 实测补充三条本节未覆盖的边界（都已在实现里处理）：
>
> 1. `title LIKE '%专利法%'` 会**同时命中「专利法实施细则」**（它含「专利法」三字），而实施细则
>    149 条 > 专利法 82 条 ⇒ 直接取 maxContig 最大者会**错选实施细则**。必须先归一化法名再精确比对。
> 2. 归一化必须剥掉「一、」「第五章」这类**章节与序号前缀**：库里有「一、山东省专利条例」（wiki，0 条）
>    与「山东省专利条例」（raw，33 条）**同一部法**；不剥前缀会让引用优先命中更长的带前缀名，
>    把合法条号判成 `not-indexed`，而真相是同一部法的另一份来源里有全文。
> 3. `doc_type='law_article'` 里混着**语料片段**（实测 60 个「法名」中含 `CLAUDE.md`、`分拆目录`、
>    `第五章 商标相同、近似的审查审理`）⇒ 抽取用的法名须过「法规后缀白名单」（`isLawLikeName`，
>    以 法/条例/办法/规定/细则/规则/标准/解释/批复/指南/通知/决定/命令/规程 结尾）；
>    但**书名号路径（`《任意名》第N条`）不过此判据**——否则编造法名会被静默忽略，
>    而「静默忽略」比「判 not-indexed」更糟。

### 4.4 域标注（一个需要拍板的点）

`ToolDomain` 是**单值**（`src/tool/protocol/types.ts:90-102`），`annotate` 只补不覆盖。

- 标 `legal`：与 `law_search` 一致。已核实专利类角色多数含 `legal`（`patent-analyzer` / `patent-novelty-checker` / `patent-invalidity-checker` / `patent-reviewer` / `provision-*` 等），**但 `patent-writer`、`patent-electrical-agent`、`provision-drafting-claims`、`provision-drafting-spec` 的 `domains` 里没有 `legal`**——而这些恰恰是"写权利要求/说明书时要核验法条引用"的角色。
- 标 `patent`：写作类角色可见，但会把法律工具混进所有 patent 角色的工具面。
- 不标 domain：所有角色可见（噪音最大）。

**推荐：标 `legal` + 同步给上述 4 个写作类角色的 `domains` 补 `"legal"`**（改 `skills/*/SKILL.md` 的 frontmatter；`scripts/validate-skills.mjs` 会校验 `domains` 必填与类型）。理由：域语义正确（它核验的是法律文本，不是专利数据），且写作角色确实需要它。⚠️ 这会改动 role skill，属非平凡变更，**该 PR 要带 `docs/notes/` note**。

### 4.5 已知边界（必须写进工具描述，不许读者自行发现）

1. **拦不住"条号与命题不符"**：~~`matchProposition` 是双向包含（`packages/patent/patent-law/src/verify.ts:274-280`），命题句里出现**任一主题词**即判 `valid`~~（同类判据 Sati 侧改为「命题与条文正文共享任一 3-gram」——dsh 依赖的 `ArticleEntry.topics` 人工词表 Sati 没有）。研究报告 §5.5 实测「该商标应当核准注册，但本申请具备创造性」→ `valid`；Sati 侧复跑同样 `valid`，且理由里报出**仅重合 1/16 个片段**（dsh 不报这个强度）。
   → 工具描述里必须写明：**这是引用形式门禁，不是命题正确性门禁**；"该条是否真支撑该论断"仍须由更强判据（如 `evaluate_evidence` 链路）承担。
2. **索引抄录正确性**不可由运行时证伪。Sati 侧已由 §2.5 的探针验证了两部核心法的条号完整性，但**条文内容**是否抄错仍只能人工复核。
3. 命题方向的反向误报**是已知的**（同义改写 → `mismatch`）。工具描述要提醒：`mismatch` 可能是措辞差异而非真错误。

### 4.6 降级（与 `law_search` 同口径）

- DB 不存在 / `law_article` 文档数 0 → `checkAvailability` 返回 `setup_required`（复用 `law-search-tool.ts:138-148` 的文案形态）。
- **绝不允许**"DB 不可用 → 全判 valid"。这是本项最危险的失效模式：一次静默放行比没有核验更糟。

### 4.7 测试

| 反例 | 期望 |
|---|---|
| `《专利法》第一百二十条` | `out-of-range`（专利法共 82 条）——**dsh 侧已实测，Sati 侧重跑** |
| `《专利法》第八十三条` | `out-of-range`（82 条）；⚠️ 这条是 **Sati 侧新增**的，用来验证"上界现算"与 dsh 的"声明上界"结果一致 |
| `《专利法实施细则》第一百五十条` | `out-of-range`（149 条） |
| 编造法名（`《中华人民共和国专利促进法》`） | `not-indexed`（法名不在库） |
| 合法条号 + 无关命题 | `valid`（**记录这个漏放**，作为边界测试而非缺陷测试） |
| 合法条号 + 同义改写命题 | **`valid` + 「仅重合 N/M」提示**（⚠️ 计划原写 `mismatch`，**实测推翻**：同义改写仍共享「技术相」这类片段，按弱重合判 `block` 级会误伤正确引用——判据改为只在**零重合**时判 `mismatch`，见决策记录） |
| DB 不可用 | `setup_required`，**不得**返回 valid |
| 索引构建遇全文缺失 | 不给 `out-of-range`，给"上界未能证明" |

### 4.8 会破坏什么

- **重放契约：改 `inputSchema` / 新增工具 → `toolSchemaDigest` 必变 → 既有 fixture 失配，须重录**（§7.2.1）。
- `docs/code-facts.md` 的 `default_tool_count` 会变；`src/tool/` 文件计数会变 → **跑 `pnpm gen:doc-claims` 回填**，不要手改。
- 改 4 个 role skill 的 `domains` → `pnpm lint` 里的 skill 校验门。

---

## 五、A3 —— `patent_deadlines` 法定期限

> **状态：已落地（2026-10-15）**，决策记录见 `docs/notes/implemented/2026-10-15-patent-deadlines.md`。
>
> **两条计划假设被实测推翻**（原假设保留在下方并就地划线，不删除）：
>
> 1. §5.3 的「日历必须覆盖当前年份 + 下一年」**不可满足**——次年安排在**发布前客观不存在**（实测
>    基准日 2026-10-15 时，2027 年安排尚未发布；国务院办公厅惯例于每年 11 月发布）。要求次年覆盖会
>    让门禁在每年 11 月前**恒红**，从而被当成噪音忽略。改为 `assertCalendarFreshness`：**当年必须
>    覆盖**，**次年在当年 12-01 之后必须覆盖**（给发布留窗口，窗口一过就红）。
> 2. §2.3 / §5.5 的「日历未覆盖时要办事的期限 → `pending`」会让**绝大多数期限不可用**（实审请求落在
>    3 年后、专利权期限 20 年后，而日历只覆盖当年+次年 ⇒ 连确定的 `rawDueDate` 都拿不到）。改为
>    **统一给下界**：`rawDueDate` 始终给；顺延不可判定时给 `dueDateLowerBound`（仅按周末顺延）
>    且**不给 `dueDate`**；`requiresFullCalendar` 降为**报告措辞强度**。`pending` 因此只表示
>    **缺案件事实**（缺通知送达/授权公告日），与「缺年度日历」这一**资产**问题分开。
>
> **其余按计划执行**，另有三处 Sati 增补：法条**逐条核验**（15 条全部对上，含 2023 修订后外观设计
> 15 年）、**双口径申请费**（细则第 112 条两个起算点分别成条，dsh 只给一个）、**恢复排除**标注
> （细则第 6 条第 5 款把法 24/29/42/74 条期限排除在恢复外，dsh 给的是通用建议）。

### 5.1 落点

新建 `src/patent/deadline/`，按 dsh 的模块切分为 Sati 风格（`protocol` / `runtime` 分组是 Sati 惯例，但本模块**无协议面**，用平铺 + barrel）：

| 文件 | 来源（dsh） | 说明 |
|---|---|---|
| `calendar.ts` | `patent-deadline/src/calendar.ts`（149 行） | 日历日期类型与加减（月/年进位、月末规则） |
| `period.ts` | `src/period.ts`（63 行） | 细则第 5 条的期限算术（**起算日不计入**） |
| `work-calendar.ts` | `src/work-calendar.ts`（226 行） | 节假日资产的装载与覆盖判定 |
| `statutes.ts` | `src/statutes.ts`（912 行） | **法定期限规则表**——A3 的工时主体 |
| `delivery.ts` | `src/delivery.ts`（130 行） | 送达日解析（电子/邮寄） |
| `service.ts` | `src/service.ts`（108 行） | 组装报告 |
| `report.ts` | `src/report.ts`（125 行） | 报告渲染 |
| `tool/patent-deadlines.ts` | `src/tool/patent-deadlines.ts`（348 行） | 工具面 |
| `assets/work-calendar/cn-holidays.yaml` | 同名（114 行） | **须扩充**，见 §5.3 |

### 5.2 实现纪律（从 §2.3 的探针与 dsh 的实测结论得来）

1. **通知起算的期限绝不从申请日近似**：没有送达记录就 `pending` 并**指名缺哪个输入**（`requiredInput`）。dsh 已实测会输出"不以申请日起算的固定年数替代"这句——**保留这个语义与文案形态**。
2. **优先权声明与日期双向 fail-loud**：主张优先权但无日期 → 抛错；给了优先权日却声明不主张 → 也抛错（dsh 已实测两者都抛 `DeadlineQueryError`）。
3. **两个末端日期都要返回**：`rawDueDate`（期限本体届满日）与 `dueDate`（顺延后）**始终同时给**——只在顺延开启时给 `dueDate` 会让"顺延生效了吗"无法被机械检查。dsh 已实测这一点。
4. **求值器入口补 `Number.isFinite` 断言**（dsh 的已知边界）：dsh 的日期校验只在 `parseCalendarDate`（对字符串严格抛错），**不在求值器**；绕过解析器直接构造 query 会拿到 NaN 日期 + `status: "normal"` 的"看起来正常"的结果（研究报告 §5.8 第 3 条）。Sati 侧**在求值器入口 fail-loud**，成本极低。
5. **顺延开关**：保留 `restDayRule: "apply" | "omit"`（默认 `apply`）。

### 5.3 日历资产（A3 的前置数据工作）

| 项 | 要求 |
|---|---|
| 覆盖范围 | ~~**必须覆盖"当前年份 + 下一年"**；不足即 CI 红~~ **已修正（实测推翻）**：**当年必须覆盖**；**次年在当年 12-01 之后必须覆盖**——次年安排在发布前客观不存在（国务院办公厅惯例每年 11 月发布）。见 §5 开头与 `assertCalendarFreshness` |
| 每条数据的出处 | 保留 `source` 字段并**附国务院办公厅通知文号**（dsh 的资产头部已是这个形态，照此纪律） |
| 未覆盖年份 | 按 §2.3 的分型规则：`requiresFullCalendar` → `pending`；否则 `rawDueDate` + `dueDateLowerBound` + `rollForward: "weekend-only"` |
| 周休息日 | **不依赖年度数据**（周六日可算）；与法定假日**分层**：`rollForward` 取 `"holiday+weekend"`（完整）/ `"weekend-only"`（降级） |
| 长期维护 | 新增 `docs/patent-deadline-calendar-runbook.md`（或在现有 `docs/degradation-runbook.md` 增节）：每年通知发布后追加一年、附文号、跑资产自检 |
| 资产自检 | 单测断言"当前年份与下一年均被覆盖"，过期即红——**否则会静默降级一整年** |

> **为什么不直接把 dsh 的 114 行 YAML 抄过来**：它只有 2025–2026，抄来当天就过期；且其 2026 年数据需重新核对（本计划未核）。资产的价值在维护机制，不在那 114 行。

### 5.4 `statutes.ts` 的移植成本（对话前必须知道）

912 行里绝大多数是**期限规则条目**（每条紧挨其法条依据）。移植不是"搬 912 行"，而是**逐条做两件判定**：

1. **分型** `requiresFullCalendar`（§2.3）——dsh 没有这个字段，每条都要判。
2. **事实核验**——dsh 的条目是它的抄录，Sati 要**重新对一次法条**（尤其涉及 2023 年实施细则修订后的期限变化）。研究报告 §7 已声明 dsh 是 developer preview，其 Known Limitations 也承认机械抄录。

→ **建议**：先移植**最高频的一批**（办登 + 年费 + 答复一通 + 实审请求 + 优先权期限，即已实测覆盖的那几条），跑通端到端；其余条目分第二批。**不要**为了"一次搬完"把 912 行一次性进来——那会把"判定"的工时掩埋成"搬运"。

### 5.5 测试

| 反例 | 期望 |
|---|---|
| 未给授权通知 | 办登期限 `pending`，`requiredInput` 指名授权通知，reason 含"不以申请日起算的固定年数替代" |
| 电子送达 2026-09-01 | 登记手续/分案 `rawDueDate = 2026-11-01`（2 个月），顺延后 `dueDate` 相应变化 |
| 主张优先权但无日期 | 抛 `DeadlineQueryError` |
| 有优先权日但声明不主张 | 抛 `DeadlineQueryError`（另一方向） |
| `restDayRule: apply` vs `omit` | `dueDate` 不同，`rawDueDate` 相同 |
| **年份落在日历未覆盖区** | ~~分型为 `true` → `pending`；分型为 `false` → 有 `rawDueDate` 与 `dueDateLowerBound`，**无 `dueDate`**~~ **已修正（实测推翻）**：两者**都给** `rawDueDate` 与 `dueDateLowerBound`、都**无 `dueDate`**；差别只在 `requiresFullCalendar` 控制的**报告措辞强度**（要办事的期限强警告） |
| **坏类型日期（绕过解析器）** | 求值器入口 fail-loud（**Sati 新增**，dsh 此处静默） |
| 同日两条期限 | 报告两条都出，不合并 |

### 5.6 会破坏什么

- 新增工具 → **重放重录**（§7.2.1）；`default_tool_count` / `patent_tool_count` 变 → `pnpm gen:doc-claims`。
- 新增资产目录 → `pnpm build` 的资产拷贝清单需同步（现有 docx/模板资产的拷贝逻辑在构建脚本里）。
- 若工具描述里出现"期限""顺延"等词，"叙述性文档不要手写数字"的纪律同样适用（不要在 SKILL.md 里写死期限长度，从资产读）。

---

## 六、A4 —— `patent_fees` 官费

> **状态：已落地（2026-10-15）**，决策记录见 `docs/notes/implemented/2026-10-15-patent-fees.md`。
>
> **§6.5 的七条判据全部落地**（测试 80 例），另有**四类实测发现改变了实现**（原计划保留在下方）：
>
> 1. **dsh 的减缴模型是错的——本批唯一会算错钱的实质缺陷**。§6.2.2 只要求「按备案前提降级不静默」，
>    但实测发现更根本的问题：dsh 把减缴比例钉在**主体类型**上（`individual`→85%、`enterprise`→70%），
>    而《专利收费减缴办法》**第四条**规定比例取决于**申请人是一个还是多个**（单独 85%、两个以上共同
>    70%），与个人/企业无关；**第三条**的资格门槛才是与比例**正交**的那一轴（官方标准的费减栏就是
>    两列 85%/70% × 三行资格）。dsh 的模型还**缺第三类资格**（事业单位、社会团体、非营利性科研机构）。
>    后果双向：**企业单独申请多算 15 个百分点**、**两个个人共同申请少算 15 个百分点**——后者是
>    缴费不足、丢权利的方向。Sati 拆成 `reductionPercent.{single,joint}` + `reductionKinds[]`
>    + 必填的 `applicants`，装载器再校验 `joint < single`。
> 2. **§6.2.1「任一适用项无金额 → 不给合计」在 dsh 里只做了一半**：`totalOf` 只看 `lines`，不看
>    `pending`。于是未给 `annuityYears` 时它返回 `pending: [annual-fee]` **并且**
>    `total: { complete: true }`——**年费整笔漏在合计之外还报完成**，正是它自己文档里说要防的
>    「读起来像价格的局部和」。Sati 把 `pending` 与「未核验」同等对待，一并进 `unverifiedIds`；
>    另修两处同源问题（份数为 0 的行必须记 0 元；覆盖为空不给 0.00 的合计）。
> 3. **滞纳金窗口是「法条」与「官方参考表」差一个月**（计划里没有的一条）：细则第 115 条给
>    **6 个月**补缴窗口，而官方《年费计算参考表》逐格只列到 **25%（5 个月）**，且表有下边框、
>    不是截断。差额方向决定案子是「多缴」还是「缴费不足、权利终止」。因此**已列表的月份给金额
>    （1–5 个月与官方表逐格一致）、第 6 个月不给金额并挡住合计**，写明以缴费通知为准。
>    `LatePaymentRule` 为此多一个 `tabulatedMonths`。
> 4. **§6.3「逐条重新核一遍」的结论：dsh 的金额全对，但出处的声明错了**。费率数字与
>    2024-08-06 官方标准页、2025-12-29 修订版《缴费服务指南》所附年费参考表**逐格一致**；
>    但 dsh 声明所据文书为「2026-08-31 发布 / 2026 年 8 月版」，而它给的路径指向的正是
>    2024-08-06 那一页。同时它**漏了官方标准里有的费种**（专利权期限补偿请求费、补偿期年费、
>    专利文件副本证明费、PCT 国家阶段的单一性恢复费/优先权恢复费/译文改正费），且
>    `grant-registration` 环节**声明了却一个条目都没有**——空表读起来就是「办登不收费」，
>    而办登要缴的是授权当年年费（细则第 114 条）。Sati 补齐费种，并给空环节写**具名说明**
>    （登记费、公告印刷费已由财税〔2018〕37号停征）。
>
> **另有一处跨资产矛盾顺手修正**：`skills/patent-teams/case-manager/SKILL.md` 与
> `skills/patent-team-composition/SKILL.md` 共三处仍把「送达推定日（+15 日）」写成要监控的流程
> 节点，与 A3 已按细则第 4 条第 4、7 款落地并写成测试断言的「电子送达不加 15 日」**直接矛盾**
> ——同一仓库两个资产说反话时，模型会照更贴近日常执行的那份做。见决策记录 Alternatives G。

### 6.1 落点

新建 `src/patent/fees/`：

| 文件 | 来源 | 说明 |
|---|---|---|
| `money.ts` | `patent-fees/src/money.ts`（55 行） | 金额解析与精度（**禁止浮点直接相加**） |
| `types.ts` | `src/types.ts`（256 行） | 费种/触发点/分档/减缴类型 |
| `fees.ts` | `src/fees.ts`（286 行） | 费率资产装载 + **fail-loud**（资产缺失/畸形必须让加载失败，不许"以空表运行、把每个案子都报成已计价"） |
| `compute.ts` | `src/compute.ts`（388 行） | 计价核心 |
| `tool/patent-fees.ts` | `src/tool/patent-fees.ts`（390 行） | 工具面 |
| `assets/fees/cn-fees.yaml` | 同名（372 行） | **须逐条重核**（见 §6.3） |

### 6.2 必须保留的判定（已实测，来自研究报告 §5.6）

1. **任一适用项无金额 → 不给合计**，且**指名是哪些**（`total.amount = null`、`complete: false`、`unverifiedIds: [...]`）。
2. **减缴按备案前提降级不静默**：`filed: false` 时仍报原价，但给出理由「未办理费减备案：仅对不以此为前提的费种适用」。
   > ⚠️ **实测追加**：这一条只覆盖了「备案前提」。「比例本身」在 dsh 里也是错的——比例取决于**申请人是一个还是多个**（办法第四条），不是个人还是企业；且缺第三类资格。见 §6 开头第 1 条。
3. **年费分档可计价**：顶层 `amount: null` ≠ 不可计价（价格在 `tiers` 里）。已实测第 1/4/13 年 → 8 100.00。
4. **免费基数**：发明申请按权利要求项数超出免费基数的部分计附加费（已实测 12 项 → 900 + 50 + 2×150 = 1 250.00）。
5. **不复制 dsh 的已知小瑕疵**：类型过滤的 `notes` **只报条目名称**，同名条目不可区分（实测输出「已按专利类型过滤：年费、年费 不适用本次类型」）→ 移植时**改为报 `id + name + 适用类型`**。

### 6.3 费率资产（须重新核对，不能照抄）

> **已核对（2026-10-15）**：25 个条目、14 个环节；金额与 2024-08-06 官方标准页及 2025-12-29 修订版年费参考表逐格一致。**结论与本节预期相反的部分**：dsh 的金额没抄错，错的是它声明的出处（2026-08 版 vs 实际 2024-08-06），且它漏了若干费种。见 §6 开头第 4 条。

dsh 的 `cn-fees.yaml` 带 `amount` / `sourceDoc` / `effectiveFrom` / `verifiedOn` 四件套——**保留这套记录字段**，但：
- 逐条对**现行收费标准**重新核一遍（dsh 的抄录未经本计划核验）；
- 减缴比例（个人 85% / 企业 70%）与备案前提要写清是**按哪份文件**；
- 资产自检：金额缺失**不是**"留空就好"——要么有值，要么显式标 `unverified` 并在计价时按 §6.2.1 处理。

### 6.4 与 A3 的接口

`patent_fees` **不算日期**：年费的"第几年度"、滞纳"第几月"由 A3 的输出提供。所以 A4 的工具入参必须与 A3 的期限报告**字段同名**，避免中间层再次解释。→ **A4 开工前先把 A3 的报告字段冻结**。

### 6.5 测试

> **已落地（2026-10-15）**：七条判据全部有对应测试（80 例）。其中「12 项权利要求的发明申请 → 1 250.00」需要同时给出 `specificationPages` 与 `priorityClaims`——因为说明书附加费与优先权要求费也是该环节的适用条目，缺它们会进 `pending` 并挡住合计（这正是 §6 开头第 2 条要修的行为）。

| 反例 | 期望 |
|---|---|
| 12 项权利要求的发明申请 | 合计 1 250.00（含 2 项超基数附加费） |
| 含延长期限请求费 | `total.amount = null`、`complete: false`、`unverifiedIds` 指名 |
| 个人减缴 `filed: true` → 实用新型申请费 | 75.00 |
| 个人减缴 `filed: false` | 报原价 + 显式理由（**不得**静默按减缴算，也不得静默按原价算而不解释） |
| 年费第 1/4/13 年 | 分档计价合计 8 100.00 |
| 费率资产缺失/畸形 | **装载失败**，不许以空表运行 |
| 类型过滤 | `notes` 能区分同名条目（Sati 改进项） |

### 6.6 会破坏什么

同 A3（重放重录、`gen:doc-claims`、资产拷贝）。

---

## 七、顺序、门禁与交付

### 7.1 依赖图

```
A1（独立，可随时开工）
A2（独立，可随时开工）
A3 ──> A4（A4 需要 A3 的"年度/月数"口径，须先冻结 A3 的报告字段）
B4 前置交付门（不在本批）──> 依赖 A2 的 law_verify 作为被担保动作
```

**建议开工顺序**：`A1 → A2 → A3 → A4`。
理由：A1 成本最小、**不触重放契约**、直接修掉一个现存静默缺陷（§2.2），能立刻验证"核验层"这个形态在 Sati 的接受度；A2 有 knowledge.db 现成红利、增量小；A3 是工时最大的一块（日历 + 912 行逐条判定）；A4 依赖 A3。

### 7.2 每项必过的门禁

#### 7.2.1 重放契约（**本批最容易被漏掉的排期项**）

`src/test-support/llm-replay/requestKey.ts:58` 把**全部** `request.tools` 的 `{ name, inputSchema }` 纳入请求键：

```ts
tools: request.tools?.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })),
```

→ **新增任何一个工具都会让 `tests/fixtures/llm-replay/deepseek-v4-flash-basic/` 失配**，必须重录（AGENTS.md 规则 6）。现状只有这一个 fixture 目录，重录走 `scripts/record-llm-replay.ts` / `scripts/record-real-fixture.ts`（需真实 key，人工在环）。

落到本批：

| 项 | 是否触发重录 |
|---|---|
| A1 | **否**——只要不给 `render_patent_document` 加 `inputSchema` 入参。（改顶层 description 安全；**不要**改 `inputSchema` 内任何属性文本） |
| A2 | **是**（新增 `law_verify`；若同时改 4 个 role skill 还须跑 skill 校验门） |
| A3 | **是** |
| A4 | **是** |

**排期建议**：把 A2/A3/A4 规划成**尽量少的重录次数**。两种切法：

- **切法甲（推荐）**：PR1 = A1（不重录）；PR2 = A2；PR3 = A3+A4（A4 本就依赖 A3）。→ **重录 2 次**。
- **切法乙**：PR1 = A1；PR2 = A2+A3+A4。→ **重录 1 次**，但单个 PR 很大（≈4 000 行 + 资产 + 门禁回填）。
- **切法丙**：四项各一 PR。→ 重录 3 次，最贵，**不推荐**。

若重录成本（真实 key + 人工确认 + 4 个门禁回填）高于 PR 审查成本，走切法乙。

#### 7.2.2 其余门禁（每项都要过）

| 门禁 | 触发条件 |
|---|---|
| `pnpm typecheck` | 全部改动 |
| `pnpm lint`（含 11 个领域门禁 + 末尾 `check:doc-claims`） | 全部改动 |
| `pnpm format:check` | 全部改动 |
| `pnpm test`（先 `pnpm build`） | 全部改动；`tests/patent/**` 与 `tests/knowledge/**` 新增 spec |
| `pnpm gen:doc-claims` | **新增工具 / 新增 `src/` 文件**——`default_tool_count`、`patent_tool_count`、`src/<模块>/` 文件计数都会变。**不手改数字，跑生成器回填** |
| `pnpm gen:event-matrix` + `check:event-matrix` | 仅在改动 `AgentEvent` / gateway frames 时。**本批预期不触发**；若为了"核验失败"想加事件，须一并跑（并考虑这是否值得——本批不做） |
| `docs/notes/<日期>-<slug>.md` | **A2 / A3 / A4 各一条**（非平凡变更：新增工具 + 新资产 + 降级口径决策）。按 `docs/notes/README.md` 格式，**必须含 `## Alternatives considered`**——A3 的日历口径（§2.3 三口径）与 A2 的索引来源（随包 vs knowledge.db）都是现成的备选项记录 |
| `scripts/validate-skills.mjs` | A2 改 role skill `domains` 时 |
| 资产拷贝 | A3/A4 新增 `assets/` 目录时，确认 `pnpm build` 会拷贝（对照现有模板/规则资产的拷贝逻辑） |
| i18n（规则 4） | **本批不触发**（核验报告是工具结果文本）。若后续在 UI 呈现核验结论，须提取 `ui/src/i18n/locales/{en,zh-CN}/` |

#### 7.2.3 降级审计（规则 11）

每项交付前回答一次：「降级时谁漏了什么？」

| 项 | 降级场景 | 谁漏了什么 | 处置 |
|---|---|---|---|
| A1 | docx 有 `fail` 发现 | 用户以为交付件合格 | 核验结论必须出现在工具结果；`docxPath` 与 `docxError` 语义分离 |
| A2 | knowledge.db 不可用 | 所有人以为引用已核验 | `setup_required`，**禁止**静默 valid |
| A2 | 索引全文缺条 | 合法条号被判 `not-indexed`（伪装成引用错误） | 上界不可证明时不判 `out-of-range`，并显式报"索引不完整" |
| A3 | 日历未覆盖年份 | 期限看起来已顺延 | ~~分型：要办事的期限 `pending`~~ **已修正**：统一**不给 `dueDate`**、只给 `dueDateLowerBound`（仅按周末）并标注方向；`requiresFullCalendar` 决定警告强度。原分型会让实审请求等远期期限连 `rawDueDate` 都拿不到 |
| A4 | 某费种无金额 | 用户以为合计已齐 | 不给合计 + 指名 `unverifiedIds` |
| A4 | 费率资产缺失 | 每个案子都"已计价" | **装载失败**，不许空表运行 |

### 7.3 反例清单（每项交付前必须复跑，可直接当发布检查表）

```
A1  · 只给 claims+spec 渲染 → 期望：摘要/摘要附图/说明书附图 三件被逐件点名（warn，不阻断）
    · 内容传入但成品该节为空 → parts-nonempty fail（用空母版当成品构造）
    · 正常五件套 → passed，各节页眉/计数齐备；母版 w:color=auto 不误报
    · 正常五件套 → passed，各节页眉/计数齐备
A2  · 《专利法》第一百二十条 → out-of-range（共 82 条）
    · 《专利法》第八十三条 → out-of-range（Sati 侧新增断言；与 dsh 声明上界结果对照）
    · 《专利法实施细则》第一百五十条 → out-of-range（共 149 条）
    · 编造法名 → not-indexed
    · 合法条号 + 无关命题 → valid（记录漏放边界）
    · DB 不可用 → setup_required
A3  · 无授权通知 → pending + requiredInput 指名（不从申请日近似）
    · 电子送达 2026-09-01 → rawDueDate 2026-11-01
    · 优先权双向不一致 → 两方向都抛错
    · apply/omit 两开关 → dueDate 不同、rawDueDate 相同
    · 日历未覆盖年份 → 分型两路各验一次
    · 坏类型日期 → 求值器入口 fail-loud
A4  · 12 项权利要求 → 1 250.00
    · 含延长期限请求费 → total null + unverifiedIds 指名
    · 减缴 filed:true / false 两路
    · 年费 1/4/13 年 → 8 100.00
    · 资产缺失 → 装载失败
```

**纪律**：这些数字是**dsh 侧已实测的结果**（研究报告 §5.5–§5.7）。Sati 侧重跑**允许不一致**——不一致就说明移植有偏差或资产不同，必须查清后才改断言，**不许为了"通过"改期望值**。

### 7.4 提交切分（推荐切法甲）

| PR | 内容 | 重录 | note |
|---|---|---|---|
| PR1 | A1（核验器 + 接线 + 测试）——**已落地**（2026-10-15） | 否（已实证：未改 `inputSchema`） | 已写 `docs/notes/implemented/2026-10-15-docx-finished-product-verification.md` |
| PR2 | A2（+ role skill `domains`） | 是 | 是 |
| PR3 | A3 + A4 | 是 | 各一条（或合并一条，含两组 `Alternatives considered`） |

---

## 八、风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **日历资产逐年维护被遗忘** | 整个"顺延"能力在某年后静默降级 | §5.3 的资产自检（**当年必须覆盖**；**次年过当年 12-01 仍未覆盖即 CI 红**）。已落地：`work-calendar.spec.ts` 的「资产自检」用例故意依赖真实系统日期 |
| **`statutes.ts` 一次搬太多** | "判定"被掩埋成"搬运"，错误抄录无人复核 | §5.4：先搬高频 5 类，跑通端到端再扩 |
| **`law_verify` 被当成命题正确性门禁** | 让"条号对但论断不成立"的文书获得虚假的可信度 | §4.4 写进工具描述；研究报告 §7 已列为缺口 |
| **重录成本被低估** | 排期延误（需真实 key + 人工确认） | §7.2.1 的三切法；推荐把重录次数压到 2 次 |
| **A2 改动 role skill `domains`** | 触发 skill 校验门，且改变角色工具面 | 先在 PR 里单独一个 commit，便于回退 |
| **移植 dsh 的 `mismatch` 默认 `block`** | Sati 侧若主题词表与 dsh 不同，可能大量误 block | Sati 侧新表上线时**先按 `warn` 跑一段**，用真实案卷统计误报率再切 `block`（口径与 dsh 不同要如实记进 note） |

---

## 九、已知缺口（不静默）

| 缺口 | 谁因此漏了什么 | 处置 |
|---|---|---|
| 本计划**未跑任何 Sati 侧探针**（只有 knowledge.db 的条号完整性是实测的） | §3.3 标"待核实"的 3 条断言（零缩进、内联颜色、编号政策）若判断错，A1 的断言清单需返工 | A1 开工第一步就是核这 3 条（读 `ooxml.ts` / `htmlToOoxml.ts` 即可，成本低） |
| A2 的**指南章节核验**只做标题存在性 | "该章节内容是否支撑命题"仍无人核 | 与 dsh 一致（恒 `unverified`）；属设计边界，写进工具描述 |
| A3 的期限**规则表条文依据**需人工复核 | 抄错一条期限 = 一个案子误期 | §5.4；本计划未复核任何一条 |
| A4 的**费率数值**未经本计划核验 | 报价错误 | §6.3；移植时逐条重核并记 `sourceDoc` / `effectiveFrom` / `verifiedOn` |
| dsh 是 developer preview，行号为 2026-10-15 快照 | 后续 dsh 变更不会自动同步 | 本批按语义移植，不建跟版机制（§1.3）；如需复核，见研究报告 §5 的探针方法 |
| 本计划未估**工时**，只有相对成本与顺序 | 排期仍需自行判断 | 建议按 §7.4 的 PR 逐个估，每个 PR 开工前先跑该 PR 的反例（§7.3）以校准 |
| §4.4 的域标注建议改了 4 个 role skill | 若这些角色的场景判断有误，会引入工具噪音或让角色看不到工具 | 实现时逐个确认 role 的实际使用场景，不要按名字批量改 |
| knowledge.db 的**同名多源**（实测"专利法"相关 `law_article` 文档 10 条，其中 8 条是 267–1 547 字的 wiki 碎片） | 选源判据若写错，上界会被碎片带偏 → 合法条号被判 `not-indexed`（伪装成引用错误） | §4.3 的候选 → 判据 → 记录三步；落地后用 §4.7 的反例复跑，确认自动选源选中的就是那两份全文 |
| 审查指南全文**不在 `law_search` 的查询面**（该引擎所有查询带 `doc_type='law_article'` 过滤，指南是 `guideline_rule`，实测 112 条） | A2 若误以为可复用 `KnowledgeLawSearch` 做指南核验，会得到"全部 `not-indexed`"的假结论 | §4.2 已注明须独立查询；实现时先跑一次"指南文档可见性"探针再写核验 |
| 本计划对 A3 的 912 行规则表**只给了方法，未列出要搬哪些条** | 端口若按"全搬"执行，会把逐条分型的工时掩埋进搬运 | §5.4 建议先搬高频 5 类并跑通端到端；具体条目清单在 A3 开工时按使用频次确定 |

---

## 十、给决策者的三行

1. **A 批的四项里，A1 最便宜且立刻有收益**——它不加新工具、不触重放契约、直接修掉 `renderApplicationDocx.ts:213-216` 那个"单件为空静默"的现存缺陷。
2. **A2 比研究报告估的便宜**——Sati 的 knowledge.db 已经是比 dsh 随包索引更全的法条索引（专利法 82 条、实施细则 149 条均实测无缺号），不需要搬 929 行 YAML + loader。
3. **A3 比研究报告估的贵在"判定"而不是"搬运"**——日历资产要从零建且需逐年维护，912 行期限规则表要逐条判"是否允许给下界"。这两件都要单独排工时，不要藏进"移植"里。
