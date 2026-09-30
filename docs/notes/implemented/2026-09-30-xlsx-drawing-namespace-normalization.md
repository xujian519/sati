# Agent Note: 交互式预览前归一 xlsx 包的 XML 命名空间

Status: implemented

## Problem

交互式表格预览用 ExcelJS 解析工作簿，而 ExcelJS 按**字面前缀**取子节点：导出方自选的命名空间写法会让解析失败。绘图部件写成 `<d:wsDr xmlns:d="…/spreadsheetDrawing">` 或默认命名空间时，解析以 `Cannot read properties of undefined (reading 'anchors')` 告终（本机已复现）。此前只有 SpreadsheetML **主**命名空间被归一，绘图部件没有；而失败抛出的是 ExcelJS 的内部异常，界面只能显示一句无信息量的错误。

## Decision

新增 `ui/server/services/spreadsheetPackageNormalizer.js`（自 `spreadsheetPreview.js` 迁出并扩展）：主命名空间去前缀的既有逻辑保留，另加 `normalizeDrawingNamespace`，把 `xl/drawings/*.xml` 的 `wsDr` 统一成规范的 `xdr:` 前缀。判据取自声明**原文**——根元素已是 `xdr:`、根声明的命名空间不是 spreadsheetDrawing、或同名声明在嵌套处指向别处时，一律不改写（整篇改前缀不再安全）。

归一后仍解析失败时抛结构化 `SPREADSHEET_INTERACTIVE_PARSE_FAILED`（422），原始异常挂在 `cause` 上；路由既有的 `statusCode`/`code` 映射直接可用。

顺带把"包级 XML 归一"这个独立关注点整个迁出：`spreadsheetPreview.js` 已在架构基线豁免清单内（棘轮要求不得增长），门禁首选做法就是拆模块。

## Alternatives considered

- **只登记基线增长（`--update-baseline` +53 行）** — 落选：门禁明确首选拆分，且该文件已 813 行，把归一逻辑继续留在里面是加重既有问题。
- **不判断命名空间，一律把 `wsDr` 的标签改写成 `xdr:`** — 落选：会把 `wsDr` 并不属于 spreadsheetDrawing 命名空间的部件也"修好"，把看不懂的文件伪装成读懂了的（测试以外部命名空间做负控制）。
- **只在解析失败后再按 `xl/drawings/*.xml` 重写一遍** — 落选：归一本来就是逐条目、按需改写的，无条件归一比"先失败再修"少一条状态路径。
- **保留 ExcelJS 的原始异常** — 落选：内部异常对用户不可读，且路由已有错误码映射可用。

## Consequences

- 自选前缀 / 默认命名空间的绘图部件不再让交互式预览失败。
- 解析失败从"ExcelJS 内部异常"变为 422 + `SPREADSHEET_INTERACTIVE_PARSE_FAILED`（带 `cause`）。
- 归一逻辑成为独立模块（ui/server 文件数 +1），`spreadsheetPreview.js` 缩到 792 行（基线 813）。
