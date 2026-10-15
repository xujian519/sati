# Agent Note: 申请文件 docx 输出——以模板自带的 Word 母版为版面

Status: implemented

## Problem

专利交付物渲染管线（`src/patent/document`）只产 HTML/PDF。但**申请文件**（说明书摘要 / 摘要附图 /
权利要求书 / 说明书 / 说明书附图，即国知局「五件套」）是要提交给国知局的**正式 Word 交付物**——客户
与代理人要能在 Word 里继续编辑，且版面必须是官方模板的版面。只给 HTML/PDF 等于把「转换回 Word」这件
事推给用户手工做，且必然与官方模板漂移。

要求：`render_patent_document` 能在既有的 `format` 参数上多出 `docx`，且输出的 docx **必须符合所提供
模板的排版**（页边距、A4、每件页眉页脚与页码、正文/标题样式）。

## Decision

**以模板自带的 `.docx` 母版为版面，只重建正文；不引入 docx 构建器库，也不在代码里复刻版面。**

母版 = `assets/templates/patent/claims-spec/assets/template.docx`（由用户提供的 `申请文件模板.docx`
原样入库，sha256 `ecdad40e…2a8dea8d` 与源文件逐字节一致）。它是五件套空白模板：5 个分节、空正文、
每节页眉/页脚带 `PAGE` 域、A4 页面设置、`Normal` + `heading 1` 两级样式。

**1. 包级复用（`renderApplicationDocx.ts`）**

用 JSZip 读母版整包，**除以下四处外一切原样回写**：`word/document.xml`（重建 `w:body` 内容）、
`[Content_Types].xml`（补图片扩展名默认项）、`word/_rels/document.xml.rels`（补图片关系）、
`word/media/*`（新增图片）。页眉/页脚/`styles.xml`/`theme`/`sectPr` 的 `pgSz`+`pgMar` 与
header/footer 引用列表**逐字不动**——这也是测试里 `assertLayoutPreserved` 的断言对象。

**2. 分节按「页眉标题」认件（`applicationTemplate.ts`）**

`APPLICATION_PARTS` 定死备案顺序（`abstract` → `abstract-figure` → `claims` → `specification`
→ `drawings`），每件声明自己的 `headerTitle`（说明书摘要 / 摘要附图 / 权利要求书 / 说明书 / 说明书附图）。
`planSections()` 保留母版的**物理分节顺序**，把每节标记为「对应某件」或 `undefined`（保留原样），并报
`missingParts` / `extraSections`。**不按位置配对**：母版里五件的先后、以及中间是否夹了非五件套分节，
都不影响对位（有专门用例验证顺序无关）。

分节边界 = 每节最后一个顶层段落携带的内联 `w:sectPr`；末节的 `w:sectPr` 是正文级（`tailSectionProperties`）。
`splitDocumentBody()` 把 `document.xml` 切成 `{prefix, elements, suffix}`，`topLevelElements()` 用深度感知
的扫描切 `w:p`/`w:tbl`（正则不足以处理嵌套表格）。

**3. 结构渲染（`ooxml.ts`）——所有样式都来自模板，这里一条不加**

模板里派生三个事实：`deriveBodyParagraphProps()`（首个非 secPr 顶层段落的 `w:pPr` 内部内容，即正文
段落属性；缺失时兜底 `w:spacing line=360` + 首行不缩进）、`deriveTitleStyleId()`（带 `outlineLvl=0`
的段落样式 id，即 `heading 1`）、`readContentArea()`（`pgSz` 减去 `pgMar` 后的内容区 EMU，供图片缩放）。

**关键坑（踩过并加判据）**：`CT_PPr` 是**有序**序列（`… spacing, ind, jc, textAlignment, rPr, sectPr`）。
把 `w:ind`/`w:jc` 追加到 `w:pPr` 末尾会落在 `w:rPr` 之后 → **Word 报文档损坏**。故 `placeParagraphProp()`
把元素插到 `<w:textAlignment` / `<w:rPr` / `<w:sectPr` 中最早出现者的**之前**；端到端用例断言
`</w:rPr><w:ind` 出现次数为 0。同理 `w:tc` 必须以 `w:p` 结尾、`w:tbl` 不能是容器末元素，`w:body` 只能有一个。

**4. HTML → 块（`htmlToOoxml.ts`）**

用 parse5 `parseFragment` 解析，映射 `h1`→标题角色（`h2`–`h6`→正文）、`p`/`blockquote`/`address`/`pre`、
`ul`/`ol`/`li`（`1. ` / `• ` 标记 + 缩进级别）、`table`/`thead`/`tbody`/`tr`/`th`/`td`（首行视作表头）、
`strong`/`b`、`em`/`i`、`u`/`ins`、`br`（段落分割）、`img`。无标签输入按 `\n` 分段（纯文本可用）。
中文文本规范化折叠空白并删除 CJK 之间的空白；输出前剥离 XML 1.0 非法控制字符。

**5. 图片（`imageInfo.ts`）**

不引图像解码依赖，直接探头部：PNG（签名 + IHDR）、JPEG（SOFn 扫描）、GIF（逻辑屏幕）、BMP（DIB 头）。
`fitImage()` 只缩不放：`min(1, 内容区宽/图宽, 内容区高/图高)`。`http(s)` 源**不联网取图**，直接告警跳过。
每张图登记 `word/media/imageN.<ext>` + 新 `rId` + content-type 默认项。

**6. 装配与降级（`renderPatentDocument.ts` / 工具层）**

- `format` 扩为 `"html" | "pdf" | "both" | "docx" | "all"`，**默认仍是 `both`**（行为不变）。
- 母版缺失**早于任何落盘 fail-closed**（`SatiDocumentInputError`，错误文案列出当前支持 docx 的模板）；
  `renderApplicationDocx` 内部再兜一道。
- 母版结构坏了（缺件/`[Content_Types].xml` 异常）不静默：捕获进 `docxError`，**HTML 仍是可用产物**，
  工具输出行写 `DOCX 未生成: <原因>`。
- `sections` 两条路径共用一份映射、键名各自解释：HTML 路径 = 模板元素 id，docx 路径 = 件 id；
  docx 路径下不认识的键**不告警**（两套键不同名是正常情况）。`resolveTemplateDocxPath()` /
  `listDocxTemplates()` 是「哪些模板具备 docx 能力」的唯一事实源。

## Alternatives considered

- **引入 docx 构建器库（`docx` / `html-to-docx` 等）从零生成** — 落选。这类库生成的是**自己的**版面：
  要想与官方模板一致，得把 A4/页边距/每件页眉页脚/页码域/字体全部在代码里复刻一遍，且**无法被证明**与
  模板一致（只能靠人眼看）。母版复用把「版面是否正确」变成可断言的字节级比较（`assertLayoutPreserved`）。
  另：模板是客户给的官方空白五件套，**它本身就是版面契约**，复刻它没有意义。
- **把模板解析成「样式 id + 段落属性」再在别处重建** — 落选。等于抽取母版的语义后再重新组装，任何
  抽取误差都会静默改变版面；而整包复用只需重建 `w:body`，误差面被压到最小。
- **按分节的物理位置配对五件** — 落选。母版的节的顺序/数量是它的实现细节，将来用户换一份模板就会破。
  按页眉标题认件让顺序无关，且缺件能被明确报出。
- **把 docx 并进 `pdf`/`both` 语义（新增 `docx` 时改默认）** — 落选。改默认值会改变既有调用方行为
  （每个 `both` 调用都会多产一个 docx，且没有母版的模板会直接 fail）。保持默认 `both`，新增值 additive。
- **远程图片抓取后嵌入** — 落选。渲染是本地、可离线、可复现的动作；联网取图引入不可控延迟、SSRF 面与
  非确定性产物。改为告警跳过，让调用方显式把图片落到本地路径或给 data URI。
- **docx 失败时连 HTML 一起失败** — 落选。HTML 是已经成功产出的交付物，因附加产物失败而丢弃它没有道理；
  失败原因如实上报（`docxError` + 输出行），由调用方决定是否补救。
- **丢弃母版里非五件套的分节** — 落选。那些分节属于母版（可能有官方要求的空白件/表格），删掉是替用户
  做版面决策；保留原样并告警更安全。
- **`CHANGELOG.md` 记一条 Feat** — 落选。本仓近 10 个版本的实践是 CHANGELOG **只在 release commit 写**
  （`release(desktop): vX.Y.Z`），`bump-version.mjs` 不碰它。版本号引用点只有 4 处且其中两处是 claim
  生成物，故本次不动 CHANGELOG，由下一个发布窗口收编。

## Consequences

**换来的：**

- `render_patent_document` 可一次调用同时产出 HTML + PDF + **符合官方模板版面的申请文件 docx**。
- 五件内容支持结构化 HTML（标题/段落/列表/**表格**/行内图片），不是纯文本倾倒。
- 版面正确性有可执行判据（逐字比较 `pgSz`/`pgMar`/header+footer 引用列表），而不是靠人工比对。
- 缺件/坏包时 fail-closed，不会产出「看起来像申请文件但缺了一件」的文件。

**付出的：**

- 新增 `jszip` 直接依赖（此前只在 `ui/package.json` 里传递存在；lockfile 变更 3 行）。
- 母版进仓库（32 KB 二进制）。它由用户提供的官方模板原样入库，sha256 已在测试外单独核过。
- 分节认件依赖**页眉标题文案**：换模板时若页眉标题被改（如加空格、换别字），会认不出件并 fail-closed
  ——这是刻意的（宁可报错也不对位错件），但意味着换模板需要同步 `APPLICATION_PARTS.headerTitle`。
- 只有 `claims-spec` 一个模板具备 docx 能力；其余模板 `format: "docx"` 会 fail-closed 并列出可用模板。

**残余（已知，本 PR 不闭）：**

- 图片只支持 PNG/JPEG/GIF/BMP（EMF/WMF/SVG 不嵌入，告警跳过）。申请文件附图若为矢量源，需先导出位图。
- 不写 `footnotes`/`endnotes`/批注/页眉内容注入：`sections` 只作用于正文。
- 母版媒体编号从 `image1` 重新起算，未尝试与母版既有媒体去重（当前母版无媒体，故无影响；换母版需复核）。

**连带的必须动作：`inputSchema` 变更 ⇒ llm-replay fixture 重录**

把 `render_patent_document` 的 `format.enum` 从 3 值扩到 5 值，改的是**工具的 inputSchema**。
`src/test-support/llm-replay/requestKey.ts` 的请求键把 `tools: [{ name, inputSchema }]` 一起做 sha256，
而 `tests/fixtures/llm-replay/deepseek-v4-flash-basic` 是按「录制当时的工具 schema」定键的 ⇒ 旧键失配、
`NO_REPLAY_RECORD`（`stream` 处 fail-loud，被 AgentLoop 收成正常收尾，最终由 `assertAllConsumed()`
报「未驱动 1 条录制流」——**症状与病因隔了一层，别按字符串去猜**）。

`scripts/record-llm-replay.ts` 的文档把路堵死了：**「inputSchema 变更后无法离线『重算键』——正确路径是
重录 fixture，而非手工改写记录中的 key 字段。请勿手改 key。」** 故按 `scripts/record-real-fixture.ts`
的既定流程重录（git 历史同类先例：`94dfb1da6` / `db5b0cf48` / `0c0cfb9e3`，提交标题即写明
「inputSchema 变更 + fixture 重录」）：

1. 录制要求 agent model = `deepseek/deepseek-v4-flash`（测试 `makeConfig` 写死该 id，键含 model）。
   本机 `~/.sati/sati.yaml` 的 `agent.model` 是 `deepseek-flash`，故**临时**改为
   `deepseek/deepseek-v4-flash`，录完**立即还原**（备份 + sha256 逐字节比对确认）。
2. `SATI_LLM_REPLAY_RECORD_ROOT=<新目录> node --import tsx scripts/record-real-fixture.ts "<TASK>"`
   ——**必须录到新目录**：录制是 `appendFile`，直接录进原 fixture 目录会留下两条记录而 manifest 只索引新的。
3. `pnpm record:replay <新目录>` 校验 → `records.jsonl` / `manifest.json` 覆盖回 fixture 目录。

重录后结构与旧的一致：provider/model 不变、工具集仍是同一 49 个、`userTexts` 不变；变的只有
`key`（`72458be7…` → `b3216029…`）与 `eventCount`（162 → 399，模型这次的回答更长）。

**验证证据（2026-10-15）：**

- `tests/patent/document/applicationDocx.spec.ts`：21 用例全绿（`node --test`，含串行隔离复跑）。分层覆盖——契约层（五件
  顺序与页眉标题、`listDocxTemplates()` 全等、分节/页眉解析、派生正文属性 `w:line="360"`、标题样式
  id `2`、内容区宽度 `8306 twip × 635 EMU/twip`（A4 减左右页边距）、顺序无关匹配、缺件、body 重建）；解析层（HTML 块、纯文本、CJK 空白折叠、
  `br`/`strong`/`em`/`u`、PNG/JPEG/GIF/BMP 探测、`fitImage` 只缩不放）；端到端（**按件定位**文本而非全文
  包含、版面逐字保留、XML 良构、单一 `w:body`、`</w:rPr><w:ind` 计数为 0、5 个 `w:sectPr`、表格、
  转义与非法控制字符、不可读图片告警、无 `word/media/` 目录条目残留、媒体/rels 编号、`format:"both"`
  不产 docx、无母版模板 fail-closed、`format:"all"`）。
- `tests/tool/builtin/renderPatentDocumentTool.spec.ts`：新增 4 用例——schema/描述公开 `docx`/`all` 与
  五件键、`format:"docx"` 产出 docx + 正确 mime 的 file 块 + 不产 PDF、无母版模板要 docx 时
  `invalid_tool_input` 且文案列出 `claims-spec`。
- `tests/test-support/llm-replay-real.spec.ts`：重录后绿（修复见上一节）。
- 负控制：缺件 / 无法读取的图片 / 非法控制字符 / 无母版模板（渲染层 + 工具层）各有独立用例，
  不是靠「正例通过」间接证明。
- 模板一致性：`shasum -a 256` 对入库副本与用户提供的源文件相等（`ecdad40e…2a8dea8d`）。
- 门禁：`tsc --noEmit` ✓；`eslint src tests scripts apps/desktop` ✓；`biome check .` ✓；
  `check:doc-claims` / `check:skills` / `check:html-templates` / `check:techdebt-metrics` / `check:event-matrix` /
  `check:catalog-mirror` / `check:patent-sop` / `check:patent-workflow-docs` / `check:i18n-namespaces` /
  `check:issue-labels` / `check:protocol-version` / `check:architecture-boundaries` / `check:degradation` /
  `check-ui-server-boundary` 全绿。`measure:update` 已在同一 PR 内刷新（src TS 文件 `1106→1112`、
  行数 `189961→191532`；tests `641→642`）。无参无注释 `catch` 曾因新增代码从 0 涨到 2，
  **已在提交前补意图注释回落到 0**（棘轮不允许无声爬升）。
- 本机 `pnpm test` 全量：`tests 5569 / pass 5543 / fail 1 / cancelled 20`。21 个非绿条目里 20 个是
  `failureType: 'testTimeoutFailure'`（本机沙箱单次 ESLint 进程启动 ~20–24s 的既有环境问题），
  **串行隔离复跑（`--test-concurrency=1`）后全部转绿**（含 `lint-contract.spec.js` 与我这两个文件）；
  余下 2 个：`llm-replay-real`（已由重录修好）与 `task-output-store.spec.js:95`（磁盘溢写时序，
  隔离复跑 13/13 绿，不在本 PR 代码路径上）。
- **`系统 Chrome 存在时可生成 PDF` 在基点 commit 上同样失败**（`git stash -u` 后重建基点树复跑证实），
  属既有环境问题（本机无可用的 headless Chrome），与本次改动无关。
- `ui` 侧 lint 本机跑不完（shim 报 `write EPIPE`，单文件跑 exit 0）——本 PR **零 `ui/` 改动**，
  `check-ui-server-boundary` 与 `ui` typecheck 均绿。
