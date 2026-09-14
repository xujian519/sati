# Agent Note: read_file 巨型 execute 按读取类型拆分

Status: implemented

## Problem

`src/tool/builtin/readFile.ts` 891 行里，`createReadFileTool()` 一个函数占了 :43-551（约 508 行）：入参校验（offset/limit/pages/设备文件/二进制扩展名）与四条**互不相同**的读取路径（image / pdf / notebook / text）全部内联在同一 `execute` 闭包里，共享的只是最前面的去重状态登记。函数尾部还有 16 个模块私有 helper（渲染、预算、图片压缩级联、PDF 渲染）。

后果是改动要读大量上下文：想改「文本超预算收缩」得在 500 行里定位；想改「PDF 降级渲染」要跨过另外三条分支；`typeof`/`kind` 判据与各自的返回值形状彼此耦合在一个函数作用域里。台账 `docs/technical-debt/backlog.md` 的 TD-TOOL-001 即此条（类别 A 巨型函数，P2/M）。

## Decision

`createReadFileTool` 只保留**工具契约**：`name` / `description` / `inputSchema` / 权限 / 校验委托 / 去重门（unchanged stub）/ 按 kind 分派。四条读取路径与共享 helper 移入 `src/tool/builtin/filesystem/read-file/`：

| 文件 | 内容 |
|---|---|
| `constants.ts` | 各路径的字节/词元/页数阈值与 unchanged stub 文案（原先集中在 `readFile.ts` 顶部） |
| `types.ts` | `ReadFileInput`、`ReadKind`、`ReadFileHandlerContext` |
| `kinds.ts` | `classifyReadKind`、`buildReadStateKey` |
| `validate.ts` | 请求级入参校验（pages 形式/页数上限/设备文件/二进制扩展名） |
| `text.ts` | 文本渲染与预算 helper（编号行、续读提示、超限预览、二分收缩）+ `readTextFile` |
| `image.ts` | 图片修复/压缩级联 helper + `readImageFile` |
| `pdf.ts` | `renderPdfPagesAsImages` + `readPdfFile` |
| `notebook.ts` | `readNotebookFile` |

入口路径 `src/tool/builtin/readFile.ts` 保持不变（`createBuiltinRegistry` 与两个既有 spec 直接 import 它），`ReadFileInput` 继续从该路径导出。

**行为不变是硬约束**，并以两种方式验证，而不是靠"看起来是纯搬移"：

1. 工具契约逐字比对：`description` 与 `inputSchema` 的文本块与改动前**完全相同**——它们是 llm-replay 请求键（`toolSchemaDigest`）的一部分，任何一字之差都会让既有 fixture 失配（AGENTS 铁律 6）。
2. 差分对拍：临时保留改动前的 `readFile.ts`（`readFile.orig.ts`，验证后删除），对 28 条场景（文本分页/空文件/超预算抛错/去重 stub/tool-result-ref 收缩/notebook 切片/图片三种模态组合/PDF 文档块·指定页渲染·降级渲染·页数阈值·越界页/校验分支）分别调用新旧实现，比对 `content`/`data`/`metadata`/`supplementalMessages` 与抛出错误，**28/28 结果完全一致**（含 mupdf 渲染出的 JPEG 字节与 sharp 压缩结果）。

同 PR 补 `tests/tool/read-file-kinds.spec.ts`（11 条）：image / pdf / notebook 三条分支此前**直接覆盖为零**（既有 spec 只走文本路径），现覆盖模态不支持时的文本说明、图片原样透传与去重登记、PDF 文档块、指定页渲染、降级渲染、页数阈值、越界页、notebook 切片与 pages 校验。

各新模块只导出**跨模块被消费**的符号（`readTextFile`/`readImageFile`/`readPdfFile`/`readNotebookFile`、`classifyReadKind`/`buildReadStateKey`、`validateReadFileInput`，以及 `notebook` 复用 text 渲染所需的 `renderNumberedLines`/`sliceRenderedText`/`ensureTokenBudget`、pdf 复用图片压缩所需的 `compressImageForBudget`）；纯内部 helper 保持模块私有。

## Alternatives considered

- **把 helper 也一并挪进 feature folder，`readFile.ts` 退化为 re-export** — 落选：入口路径已被 `createBuiltinRegistry` 与两个 spec 引用，改成转发只会多一层间接，且不解决任何问题；契约束在入口文件更符合"读工具定义只看一个文件"的预期。
- **只拆成一个 `readFileHandlers.ts`（按 kind 分函数）** — 落选：那只是把 god function 换成 god module。文本渲染+预算、图片修复+压缩级联、PDF 渲染三类职责之间**没有共享状态**，同文件反而让"改 PDF 渲染"仍要跨过图片压缩的 60 行。
- **顺带把 `compressImageForBudget` 提成跨模块共享件**（`src/patent/figure/preprocess.ts` 自注「与 readFile.ts 的 compressImageForBudget 同源」）— 落选：两处的级联策略与调用契约并不相同（patent 侧有附图专属的尺寸/质量取舍），合并前需先统一契约，属于会改行为的独立变更，不该混进"零行为差异"的拆分。
- **同 PR 一并收敛 `validate.ts` 里的 `as ReadFileInput`（空 `pages` 归一那处窄化）** — 落选：改成类型守卫会碰 `validateInput` 的输入身份语义，超出本次"纯搬移"的边界；作为后续小项留在台账（`readFile.ts:116` 的原记录已随搬移落到 `validate.ts`）。
- **同 PR 一并处理 `patentPdfDownload.ts`（953 行）/ `patentWorkflowRunTool.ts`（818 行）** — 落选：issue #152 是"路过就修"的机会型条目，本 PR 只处理其中**有明确拆分方案与测试保护**的一条（TD-TOOL-001）；另两个文件拆分方案尚未成形，硬塞进同 PR 会放大 diff 与回归面。

## Consequences

- `readFile.ts` 891 → 127 行；四条读取路径各自独立成文件（60–200 行），改某一类的分页/降级/渲染策略不再需要跨读其它三类。
- llm-replay fixture **无需重录**（`inputSchema`/`description` 未变，且已用差分对拍确认请求面不变）；事件矩阵无需重生成（`read_file` 无事件 emit 点，`pnpm check:event-matrix` 仍 fresh）。
- 新增直测覆盖了 image/pdf/notebook 三条此前无覆盖的分支；其中 PDF 造件复用 `tests/patent/figure/pdf-extract.spec.ts` 的 mupdf `addPage`/`saveToBuffer` 方式，未引入新的固件依赖。
- 差分对拍脚本是**一次性验证手段**（依赖改动前的实现副本），已随验证结束删除，不入库；若后续再做大范围搬移，可按同样方式临时复现。
