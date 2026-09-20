# Agent Note: CodeEditorBinaryFile 拆成 binary-file feature-folder

Status: implemented

## Problem

`ui/src/components/code-editor/view/subcomponents/CodeEditorBinaryFile.tsx` 是 **1510 行**单文件：
1 个默认导出组件、1 个预览路由分发器、10 个自定义 hook（3 个资源获取 hook 用 `AbortController`、
1 个用闭包布尔、1 个用 ref 做 requestKey staleness 守卫）、12 个组件。改其中任何一个预览形态
都要先读完 1510 行——这是**文件级**认知负载，与单个函数有多长无关。

台账 TD-UI-CHAT-N08 把它描述为"巨型文件 + 内联 8 hooks 分派器（god function）"。实测**该描述
不成立**：最长函数是 `SpreadsheetPreview` 225 行，9 个 hook 早已是具名的顶层函数，真正的
"分派器" `OfficeFilePreviewRouter` 只有 89 行。所以这一波不是"拆 god function"，而是**按内聚
重新分文件**。

## Decision

拆成 `ui/src/components/code-editor/view/binary-file/` 下的 25 个模块文件，主文件只留主组件
（**1510 → 146 行**），路径、文件名与 `export default` 均不变：

```
binary-file/
  types.ts
  utils/{file-type,preview-error,paths}.ts
  hooks/use-{file-blob,office-pdf-preview-url,spreadsheet-preview-manifest,
              spreadsheet-interactive-preview,spreadsheet-sheet-preview-url,
              object-url,office-auto-refresh,office-preview-service,preview-reload-request}.ts
  components/atoms/{FileTypeBadge,PreviewSpinner,DownloadButton,OfficePreviewSettingsButton,FallbackContent}.tsx
  components/{ImagePreview,PdfPreview}.tsx
  components/spreadsheet/{SpreadsheetPreviewToolbar,SpreadsheetPreview}.tsx
  components/office/{OfficePreview,BuiltinModernOfficePreview,OfficeFilePreviewRouter}.tsx
```

拆分的排序原则是**先搬零风险、后搬粘合度高**的：类型与纯工具 → atoms → 各预览组件 →
最后才是资源 hooks（它们各自持有取消状态，是这一波唯一有真实语义风险的部分）。

**硬约束：`lazy(() => import(...))` 保持动态导入**。三个重型预览（Univer 电子表格、docx、pptx）
靠它做 chunk 切分；改成静态 import 会让主 bundle 体积暴涨，而**没有任何门禁能抓到**这一点
（体积检查不在 `pnpm check` 里）。搬迁后仍是 3 处 `lazy(() => import(...))`，只是模块说明符
随所在目录变化。

## Alternatives considered

- **按台账叙事拆"god function"（先把 8 个 hook 合并成一个分派器）** — 前提不成立：没有 god
  function，也没有分派器。按错误的问题拆会制造一个本不存在的抽象层，同时白花一轮搬迁成本。
- **把 `lazy()` 改成静态 import 以减少 cross-module 说明符的改动量** — 改动更"干净"但会破坏
  chunk 切分，且门禁全绿（体积不在门禁里）⇒ 属于"测不出来但用户能感觉到"的回归，明确不做。
- **只拆 hooks、组件留在主文件** — 主文件仍有 900+ 行（12 个组件的 JSX 是行数大头），认知负载
  几乎不变。
- **保留单文件、用 section 注释分区** — 注释不减少"改一处要读多少行"，也不改变 import 面的
  耦合（任何组件都能顺手用到任何 hook）。
- **把新模块命名为 camelCase 以与邻近的 `code-editor/hooks/useCodeEditorDocument.ts` 一致** —
  仓库规范是"文件 kebab-case（类文件 PascalCase）"，邻居是旧命名；新代码从规范，不改邻居。
- **用 `export { useFileBlob }` 收尾以消掉唯一一处 biome 折行 token 差异** — 差别是尾随逗号，
  纯排版、无求值语义；为此引入第二种导出风格不值得。

## Consequences

- 主文件 1510 → 146 行；新增 25 个模块文件（共 1463 行）。
- **新增 5 个测试文件 / 22 条用例**，专门打既有 8 条组件测试的盲区——三类取消语义（闭包
  `cancelled`、`AbortController`（含 preflight drain）、ref requestKey staleness）：换文件时的
  stale 响应必须被丢弃、被取消请求的失败不得上报、被替换请求不得清掉在途 loading、
  unmount 必须 abort、preflight body 必须 drain。
- **5 处负控制**（每处只打红目标用例，还原后复绿）：删 `if (cancelled) return`、
  把 `controller.abort()` 换成空函数、翻转 `signal.aborted` 判定、删 AbortError 吞并、
  删 preflight drain。
- **等价性证明**：AST token 比对 35/35 条搬迁声明逐 token 相同；0 条凭空新增；白名单四类
  （export 包装 31 处、动态 import 路径 3 处、随模块边界变化的 import 声明 134 行、1 处 biome
  折行补的尾随逗号——全仓唯一非修饰符 token 差异，纯排版）。
- 台账 TD-UI-CHAT-N08 回填 done，并**更正标题叙事**（非 god function）与位置口径。
