# Agent Note: 申请文件 docx 的成品核验——写完读回来对一遍

Status: implemented

## Problem

`renderApplicationDocx()`（见 `2026-10-15-patent-application-docx.md`）以母版为版面重建 `w:body`，但它的
**自检只覆盖一种失败**：`renderApplicationDocx.ts` 仅在「五件套**全部**为空」时推一条告警。

于是**单件为空是静默的**：调用方给了权利要求书与说明书、漏了说明书摘要，成品会少一整节，而
**分节数、各节页眉、页码域全都照样正确**——这类缺陷在成品里看不出来，母版复用带来的「版面正确」
反而让它更容易蒙混过关。同理，内容在渲染中被丢弃（有内容传入、成品该节为空）也没有任何判据会发现。

上游 dsh 的 `patent-filing/assets/engine/verify.py`（293 行）正是这类「成品验收」的成熟形态，但它跑在
**另一套渲染事实**上（Python + python-docx，版面由它自己拼），其断言不能直接搬——三条判据在 Sati
会**全量误报或无主体**（见 Decision 第 3 点）。本次把「成品核验」这一层补进 Sati 自己的渲染链路。

## Decision

**新增 `verifyApplicationDocx.ts`：解开已落盘的 `.docx`，按分节逐件核对内容是否真的落地、版面是否仍与
母版一致。判据全部按 Sati 的渲染事实重写。**

**1. 核验走「落盘产物」而不是「内存里的 XML」。**

`renderApplicationDocx` 写完盘后立刻调核验（`renderPatentDocument.ts` 的 docx 分支），核验器重新读文件、
解包、判据。代价是每次 docx 渲染多一次读盘 + 解压；换来的是**写盘/压缩/原子写环节的问题也能被抓住**
（复用内存 XML 等于自己核自己刚生成的字符串，抓不到那一层）。

**2. 判据拆两层：纯函数 + IO。**

`verifyApplicationDocxPackage({ documentXml, relationshipsXml, readPart, expected, residueMarkers })` 是纯函数
（不碰文件系统），`verifyApplicationDocx({ docxPath, … })` 只负责读盘/解包/取母版。这样判据可单测
（不必先造一份真 docx），也照抄了 Sati 自己的先例 `patent_figure_check`（同一核验器支持「结构化期望值」
与「回读已交付文件」两个入口）。

**3. 三条与上游判据**不同**的 Sati 事实（每条都是踩过的，写在模块头部）。**

- **首行缩进核结果、不核形式。** `ooxml.ts` 的设计是「样式全部来自模板」，正文段与图片段直接复用母版
  派生的 `w:pPr`（`deriveBodyParagraphProps`）。母版正文段落自带 `<w:ind w:firstLine="0" w:firstLineChars="0"/>`，
  故成品段落**继承**到零缩进——上游要求的「图片段必须**显式**写零缩进」在 Sati 是**形式不同、结果相同**。
  核验器因此只读段落实际的 `w:firstLine` 值，不问它从哪来。
- **`w:color w:val="auto"` 合规。** 母版段落标记的 `rPr` 带的正是 `w:color="auto"`；上游判据「颜色不是
  `000000` 即视为非黑」照搬过来会把**每一份正常成品**都报成「含非黑色文字」。`auto` 与 `000000` 同等合规。
- **不做段落编号断言。** `htmlToOoxml` 没有 `[NNNN]` 机制，编号只能由调用方写进内容。上游是「按 spec
  声明生效」，Sati 侧无人声明 ⇒ 该断言**无主体**，默认不开（开了会给正常成品报错）。

**4. 「文本丢失」判 fail，「图片未落地」判 warn——按可归责性分开。**

文本是渲染器自己搬的，丢了就是渲染缺陷（fail）；图片要读外部文件，读不到时渲染器已经在 `warnings` 里
说明了原因，**核验层不得把「输入引用了不存在的图片」升级成「渲染失败」**。故纯 regex 的「件非空」判据
被换成按内容形态分别判：件内容有非空文本而成品该节无段落/表格 → `parts-nonempty` fail；件内容声明了图
而成品该节 0 张 → `figures-not-landed` warn。

**5. 痕迹词表注入式，不自带词表。**

`residueMarkers` 由调用方传入。核验器**不建立第二张禁用词表**——输出门禁已在拦同一批词，两张表必然漂移。
未注入时 `info.residueMarkersChecked = false` 如实上报（「未检查」与「已检查且无问题」必须可区分）。

**6. 核验失败不删产物，且三种状态可区分。**

`docxError` 的语义被明确为「docx 侧有问题」，于是：生成成功且核验通过 ⇒ `docxPath` 有值 + `docxError` 空；
**生成了但没过核验** ⇒ `docxPath` 有值 + `docxError` 含「核验未通过」；根本没生成 ⇒ `docxPath` 空。
核验器**自身**抛错时 `docxError` 含「核验未能执行」——不被当成通过。

**7. 工具输出行各自独立判出，`docxError` 一律原样转述。**

工具层此前是 `docxPath !== undefined` ⇒ 只打路径、**丢弃** `docxError`（`else if` 分支）。核验接入前这不
成问题（那时 `docxError` 非空只可能是「没生成」），接入后却让**「生成了但没过核验」在工具输出里完全不可
见**——用户只看到一行 `DOCX: <路径>`。改为路径行与问题行各自独立判出，`docxError` 原样转述：它的三种来源
（生成失败 / 核验未过 / 核验未能执行）文案**自带标签**，再套一层「未生成」前缀反而会说错。
同时把行拼装提成纯函数 `formatRenderResultLines(result)`——端到端造不出「核验未过」的产物，
不提出来这三个状态就没有断言能守住。核验**通过**时也打一行实测摘要（节数 / 段数 / 图数）：
否则「已核验且无问题」与「未核验」在工具输出里同形（都只有一行路径），正是「降级但不静默」要禁的。

`docxError` 也不再重复推进 `warnings`：同一个事实走两个通道会让「致命」与「非致命告警」混在一起，
`warnings` 只留非致命项（图片未嵌入、未命中的 section id 等）。

## Alternatives considered

- **照搬 dsh `verify.py` 的三类断言（含 `!= 000000` 判色、要求图片段显式零缩进）** — 落选。这两条在 Sati
  会全量误报（见 Decision 第 3 点）；判断依据是先把渲染器与母版读了一遍，而不是假设「上游判据即正确」。
- **引入 `verify.py` 本体（Python 引擎）** — 落选。会造第二套渲染/解析管线，两份产物无从对拍；移植的是
  **断言清单与分类法**，实现留在 TS 侧（同 `2026-10-15-patent-application-docx.md` 的取舍）。
- **只核内存里的 XML（省一次解压）** — 落选。等于用生成器自己的中间产物证明生成器正确，落盘/压缩层面
  的问题永远看不到；「写完读回来对一遍」的价值恰在读**回来**。
- **凡有内容传入而该节为空，一律判 fail** — 落选（且是被既有测试挡下来的）。只含不可读图片的件会命中它，
  把输入侧的缺图算成渲染失败，撞了「图片不可读时告警但不失败」的既有契约。改按文本/图片分开判。
- **核验器自带一份内部标记词表** — 落选。与输出门禁的词表必然漂移，会出现「门禁放行但核验判不通过」的
  自相矛盾；改为调用方注入，未注入即显式标「未检查」。
- **新增独立工具 `verify_patent_docx`（核验外部给的 docx）** — 本期落选。新工具会改变 `toolSchemaDigest`
  并触发 llm-replay fixture 重录（代价见 Consequences）；渲染内自校验已覆盖主场景，回读入口留待需要时加。
- **默认开启「段落编号连续性」断言** — 落选。Sati 的渲染器不做自动编号，该断言无主体，开了只会给正常
  成品报错；与上游「按 spec 声明生效」同构，但 Sati 侧尚无声明方。
- **核验失败即抛错、不产出 docx** — 落选。HTML 已是可用交付物，且已生成的 docx 对作者有诊断价值；
  失败原因如实上报，由调用方决定是否补救（同 docx 生成失败的既有处置）。
- **导出 `hasDocxMaster(template)` 供调用方预判「核验是否有意义」** — 落选。母版缺失已由
  `renderPatentDocument.ts:151` 在落盘前 fail-closed 判掉，再加一个**没有调用方**的公开判据，等于同一事实
  的第二处表达——两处必然漂移，而漂移方向是「预判说该核验、实际渲染器直接抛错」。核验器只在拿到母版时
  才做对拍，拿不到就不对拍（不谎报「已核验」）。

## Consequences

**换来的：**

- 单件缺失从**静默**变为**指名告警**（`part-content-absent`，逐件点名），且不阻断交付——「内容缺失」是
  输入事实，不该判成渲染失败。
- 「有内容传入却未落地」有了 fail 级红线（`parts-nonempty`），渲染器将来重构引入丢失会被抓住。
- 母版漂移可抓：分节数（`section-count`）、各节页眉（`headers-unchanged`）、正文/标题/图片段首行缩进
  （`first-line-indent`）都与母版逐条对拍——这三条在换模板/升级 Word 母版时才是真正的防线（日常是白送的）。
- `docx` 侧的三种状态（没过核验 / 没生成 / 核验未能执行）在返回值里可区分，不再混成一个「有没有 error」。

**付出的：**

- 每次 docx 渲染多一次读盘 + 解压（核验走落盘产物，见 Decision 第 1 点）。
- `DocumentRenderResult` 新增 `docxVerification` 字段（可选，additive）；`docxError` 的含义被明确并写进
  `types.ts` 注释——**消费方若只看 `docxError` 判断成败，现在也会看到核验失败**，这是有意为之。
- 核验器与渲染器在同一模块内，**它是机械读回，不能替代独立第三方验收**；它证明的是「写出的东西没丢、
  版面没漂」，**不证明「内容本身是对的」**（后者靠规则门 / LLM 判据）。
- 痕迹断言依赖调用方注入词表——不自带词表意味着**默认不检查**，这是刻意的降级（`residueMarkersChecked`
  如实上报），但意味着「核验通过」不等于「没有内部标记」。

**连带事实：本次**没有**触发 llm-replay fixture 重录。**

只给 `render_patent_document` 的返回值加了字段，**没有改任何工具的 `inputSchema`**——而请求键
（`requestKey.ts` 的 `tools: [{ name, inputSchema }]`）不含 `outputSchema`。已实测：`llm-replay-real.spec.ts`
的真实 fixture 无 key 重放仍绿。这与上一个 docx note 里「扩 `format.enum` ⇒ 必须重录」形成对照：
**改返回值不触发重录，改入参才触发**，排期时值得按此区分（`docs/patent-verification-plan.md` §7.2.1 已按
这条切法给出批次建议）。

**验证要点（机检）：** `tests/patent/document/docxVerify.spec.ts` 11 用例覆盖三个层次——纯函数判据
（`auto` 与 `000000` 不误报、段落标记 `rPr` 不计入 run 色、缩进漂移、词表未注入显式标注）、端到端接线与
降级语义（五件齐备通过、漏件指名、全空只报一条、内容未落地 fail、缩进被改坏 fail、少一节/改页眉 fail），
以及**两条守契约的负例**（图片不可读仍不失败 ⇒ `figures-not-landed` warn；核验器自身失败 ⇒ 抛错）。
`tests/tool/builtin/renderPatentDocumentTool.spec.ts` 另有 5 用例钉住输出行的各种组合（PDF 未生成补前缀、
docx 通过只有路径行、核验未过时路径行与问题行并存、核验未能执行如实报出、根本没生成则无路径行）——
正是 Decision 第 7 点那个洞的回归防线。

全量 `pnpm test`：5645 用例中 5639 通过、**1 项失败**、5 跳过。失败项是 `系统 Chrome 存在时可生成 PDF`
（`assert.ok(result.pdfPath !== undefined)`），原因是本机 headless Chrome
`Failed to create a unique user data directory for headless`——该测试走 `format:"pdf"` 且模板无 docx 母版，
**不经过本次改动的代码路径**，属既有环境问题。聚合门禁 `pnpm check` EXIT=0（typecheck / lint 含 11 个领域
门禁 / format:check）；`measure:update` 与 `gen:doc-claims` 已在同一变更内刷新（新增源文件与测试文件会改变
`metrics.md` 与 `code-facts.md` 的事实层）。
