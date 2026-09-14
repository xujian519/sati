# Agent Note: patent_pdf_download 按职责拆分（浏览器脚本/HTTP 兜底/续传/埋点/路径）

Status: implemented

## Problem

`src/tool/builtin/patentPdfDownload.ts` 953 行里塞了六类互不相干的职责：ego-browser 脚本模板与脚本生成（~180 行 JS 字符串）、HTTP fetch 兜底流式落盘与魔数校验、MANIFEST 断点续传、JSONL 埋点、输出目录解析、以及工具契约与批量编排。工具工厂函数 `createPatentPdfDownloadTool` 自身占 :206-548（约 343 行），其中 `execute` 闭包 145 行。

后果：改 HTTP 兜底的重试/落盘策略要在 953 行里跨过浏览器脚本拼接；改脚本模板要跨过 MANIFEST 与埋点；任何一处改动都要读整份文件才能确认没有第二份同类逻辑。台账 `docs/technical-debt/backlog.md` 的 issue #152 把该文件列为待拆（另见 TD-TOOL-007：内嵌 ~90 行 JS 驱动模板）。

## Decision

`src/tool/builtin/patentPdfDownload.ts` 只保留**工具契约与装配**（module 说明、`DESCRIPTION`、`outputSchema`/`inputSchema`、类型/权限/可用性钩子、校验与执行委托、导出面），953 → 164 行。其余按职责移入 `src/tool/builtin/patent-pdf-download/`：

| 文件 | 职责 |
|---|---|
| `constants.ts` | 仅跨模块共享的旋钮（篇数上限、结果字节上限、默认超时推算参数） |
| `types.ts` | 输入/输出/条目/选项类型（`ScriptDownloadItem` 由私有改为导出，供兜底与编排引用） |
| `browserScripts.ts` | 三段浏览器侧 JS 模板 + `escapeTemplateContent` + `assets/patent/pdf-link-extract.js` 热加载与内嵌回退 |
| `browserDriver.ts` | `buildDownloadScript`：把模板与参数拼成 ego-browser 批量下载脚本 |
| `fetchFallback.ts` | fetch 兜底（流式写盘、魔数与最小长度校验、原子 rename、内置重试参数、UA） |
| `manifest.ts` | `.MANIFEST.jsonl` 续传读/写/大小比对/SHA-1 |
| `reporting.ts` | `summarize`/`formatSummary` 与 JSONL 埋点 |
| `outputPaths.ts` | 专利号归一化去重、`~` 展开、输出目录解析（含按日归档） |
| `validate.ts` | 请求级入参校验 |
| `execute.ts` | 批量编排（续传筛选 → 脚本执行 → 兜底 → 写 MANIFEST → 埋点 → 汇总） |

模块只导出跨模块被消费的符号；单模块自用常量留在其所属模块（如 `MIN_PDF_BYTES`/`PDF_MAGIC` 在 `fetchFallback.ts`、`MANIFEST_FILE` 在 `manifest.ts`、`METHOD_LABELS` 在 `reporting.ts`），避免把"曾经放在一起"误当作"应当共享"。入口路径与既有导出面不变（`createPatentPdfDownloadTool`、`CreatePatentPdfDownloadToolOptions`、`PatentPdfDownloadOutput` 等继续从 `patentPdfDownload.ts` 导出），`createBuiltinRegistry` 与 9 个 spec 的导入路径无需改动。

**行为不变用差分对拍确认**（以改动前实现为对照，验证后删除）：32 条场景在新旧实现上输出完全一致——18 条覆盖浏览器拦截成功、多篇 + `record`、setup_required、fetch 兜底的成功/403/HTML 内容类型/魔数不符/网络错误/无 URL、MANIFEST 全命中早退/大小不符重跑/损坏行容忍/`force` 忽略、`~` 配置目录与默认按日目录、工作区内外权限提示；14 条覆盖校验矩阵（缺参、非数组、超上限、路径穿越两种形态、归一后为空、三个超时区间、`force`/`outputDir` 类型、归一化去重）。对拍同时比对**生成的浏览器脚本字符串**（5187 字符 / 112 行）、落盘文件清单与大小、以及埋点 JSONL 内容；只有墙钟 `durationMs` 被屏蔽（两次运行必然不同）。

另需同步一处测试耦合：`tests/patent/tool/patentPdfDownload-extractjs.spec.ts` 通过**源码路径正则**读取 `PDF_LINK_EXTRACT_JS` 常量，常量随本次拆分迁至 `patent-pdf-download/browserScripts.ts`，该断言的文件路径随之更新（断言内容不变）。

## Alternatives considered

- **按"工具定义 / helper"两分（只抽文件尾部 helper）** — 落选：`execute` 闭包 145 行仍是单函数多职责，浏览器脚本拼接与 HTTP 落盘仍在同一文件里相邻，改动成本几乎不变。
- **把浏览器脚本模板抽成 `assets/patent/*.js` 资产文件（TD-TOOL-007 的建议）** — 落选（本次）：`pdf-link-extract.js` 走的是"热加载 + 内嵌回退 + 版本标记校验"三件套，另两段（探测/点击 Download PDF）目前是纯内嵌常量；把后者也改成热加载会**改变运行期行为**（多一次文件 IO、多一条回退路径与版本标记契约），属于独立变更，不该混进"零行为差异"的拆分。TD-TOOL-007 保持开放，本次只在台账记下"模板已集中到单模块"这一中间状态。
- **把 `reporting`（埋点）与 `manifest`（续传）合并** — 落选：两者都写文件但契约不同（JSONL 埋点只追加、失败静默；MANIFEST 参与跳过判定、读时容忍损坏行），合入一个模块会让"埋点失败是否可忽略"这条判断失去文件边界。
- **新增共享 `constants.ts` 收纳全部常量**（如 `MIN_PDF_BYTES`、`METHOD_LABELS`）— 落选：那只是把常量换个地方堆着；只有真正跨模块使用的旋钮才进 `constants.ts`，其余跟随其唯一消费者。
- **同 PR 一并拆 `patentWorkflowRunTool.ts`（818 行）** — 落选：两个工具互不相干的职责面，同 PR 会把 diff 放到 ~2000 行搬移且 CI 失败时难以定位；按 issue #152 的"路过就修"节奏各自独立 PR。

## Consequences

- 入口 953 → 164 行；六类职责各有归属文件（7–134 行），改 HTTP 兜底只读 `fetchFallback.ts`、改脚本拼接只读 `browserDriver.ts` + `browserScripts.ts`。
- 既有 9 个 spec（62 条用例：input/e2e/fallback/retry/manifest/telemetry/configdir/extractjs + 工具注册）无需改动即通过，仅 `extractjs` 的源码路径引用随之更新。
- TD-TOOL-007（内嵌 JS 驱动模板外置为可被类型/格式检查的源文件）**仍未解决**：本次只是把模板集中到 `browserScripts.ts`，它依旧是 TS 里的字符串。台账已如实记为"部分处置"。
- 差分对拍脚本是一次性验证手段（依赖改动前的实现副本），已随验证结束删除，不入库。
