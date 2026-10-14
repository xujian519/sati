# P2.5 — patentFigure 三工具 execute 收敛（shared 入参管线 + 分层提取）

- 日期：2026-10-14
- 批次：issue #646 sweep · P2.5（计划 D9–D18 段）
- Commit：见本 PR

## 变更

P2.5 判据「三个 execute 各 ≤200 行，无第二份产物清单」：

| 函数 | before | after |
|---|---|---|
| `patentFigureProject.execute` | 411 | **170** |
| `patentFigureGenerate.execute` | 322 | **182** |
| `patentFigureCheck.execute` | 250 | **115** |
| `createPatentFigureProjectTool` | 554 | 313 |
| `createPatentFigureGenerateTool` | 422 | ~330 |
| `createPatentFigureCheckTool` | 384 | ~290（掉出 ≥300 清单） |

god function 59 → **56**（3 个 execute + check 的 create 掉出清单）。

### 新共享模块 `src/tool/builtin/patentFigureShared.ts`（tool 层入参管线）

- `resolveInkscapeProbe`：textToPath「先探测、后落盘」此前在 generate 与 project **逐字重复**；
- `validateSheetArgs`：sheet 成对校验此前三工具各写一遍（check 曾静默忽略"只给一个"=
  假保证，已修过；本次收敛防再漂移），**统一补 index>total 校验**（此前 project 缺，
  与 generate/check 对齐——同一组入参三工具同一结论）；
- `resolveFigureOutputDir` / `assertFigureOutputName` / `toDocumentKind`：同上理由。

### 各工具分层（模块级函数）

- project：`validateSectionOffset` / `validateProjectAnnotations` / `probeFreecadCommand` /
  `writeProjectArtifacts`（主 SVG→落版页→转路径→sidecar 顺序即契约）/ `buildProjectResultLines`；
- generate：`resolveRenderPipeline`（渲染器解析 + 依赖探测 + 曲线图拒绝 + renderOne 闭包）/
  `renderFigureArtifacts`（逐幅落盘 + fit_to_page）/ `exportFiguresTextToPath` /
  `buildGenerateReportLines`；
- check：`readbackSvgFigures`（安全门→解析→回读骨架→RC 量测循环）/ `buildCheckReportLines`。

### 行为对照

- 逐行核对：所有错误码、文案、落盘顺序（fail-loud 顺序）、sidecar 字段、报告行、
  data/content 形状与旧实现一致；
- **唯一刻意的行为变化**：project 增加 `sheet_index > sheet_total` 拒绝（另两工具已有），
  属于收紧入参校验，与「三工具同结论」原则一致；
- 无 inputSchema 文本变化 ⇒ llm-replay fixture 不受影响；无 `as unknown as` 新增（M7 不回退）。

## Alternatives considered

1. **把 schema 也挪出 create 函数**（进一步降 create 行数）：收益有限（create 已 ≤330），
   且 schema 与工具定义同文件可读性更好；留待 M2 余额不足时再议。
2. **把报告构造也收进 figuregen/deliverables.ts**：deliverables 的边界是「跨工具产物装配」，
   报告措辞是各工具的用户面（project 的报告讲剖切/标注，generate 讲渲染器/附图说明草稿），
   收敛进去会让 deliverables 长出工具分支——保持 tool 层模块级函数。
3. **提取共享「execute 骨架」基类**：三工具的校验项/产物/报告差异大，骨架化会引入
   条件分支拼装，单分支理解成本高于现状。

## 验收

- 判据：三 execute ≤200 → 170 / 182 / 115；god fn 59 → **56**；metrics 基线已刷新。
- 测试：patent 全套 544 pass / 0 fail（figuregen 358 项，1 项真机 graphviz 集成 skip 为
  存量环境 skip，与 main 基线一致）；M13 四门全绿（5508 / 197 / 1286）。
- 新增文件使 `src/tool/` 文件数 143 → 144，`docs/code-facts.md` 已随 `pnpm gen:doc-claims` 重生成。
