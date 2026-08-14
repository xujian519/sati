# 引用日志规范（Citation Log）

> 借鉴 Open Design `ib-pitch-book` 的 citation-log 纪律，映射到 Sati 专利域：
> 文书中的每条关键断言都必须可溯源；无法溯源的必须降级为"假设"。
> 与 Sati 现有证据层对接：`src/patent/evidence/`（EvidenceEngine、EvidenceSpan、pin-cite 校验器）、
> `src/patent/claim-chart/`（gap 检测、verified 字段）。

## 1. 四字段结构（引用日志表固定列）

| 字段 | 取值（枚举） | 说明 |
|---|---|---|
| 来源类型 | 现有技术文献 / 专利文件 / 法条 / 审查指南 / 期刊论文 / 网页存档 / 客户提供 / 模型推断 / 假设 | 对接证据类型（`src/patent/evidence/types.ts` 的 `EvidenceType`） |
| 来源名称 | 公开号 / 条款号 / 文件名 / 文档标题 | 首次出现给全称 |
| 日期 | 公开日 / 版本日期 / 检索日期 | 现有技术须验证早于申请日（`src/patent/evidence/date.ts`） |
| 置信度 | 证据支撑 / 客户提供 / 模型推断 / 假设 | 四档，与 `conventions.md` §5 徽标一一对应 |

每行附**定位（pin-cite）**：`D1 ¶0023`（公开号 + 段号）或 `权利要求1` / `审查指南第X章`。段号必须真实存在于来源文件——引用存在性校验复用 `src/patent/claim-chart/runtime/pin-cite-validator.ts` 的 `verifyQuoteInSource`。

## 2. 生成规则

1. 每个**结论性断言**（结论摘要表、创造性判断中的"公开/未公开/具备/不具备"）至少一行。
2. 比对表中的每条映射行 = 引用日志一行（特征 + 来源 + pin-cite）。
3. 无法定位到来源的推理：
   - 有明确推理链但无文献 → 标注 `模型推断`
   - 为填空而设的默认值 / 检索未覆盖的假设 → 标注 `假设`，且在正文以斜体呈现
4. "容易想到 / 属于公知常识 / 显而易见"类断言必须附证据或标注假设——命中 `rule_check`（scope=pack）review 项时挂人工核验（对齐 workflow 惯例）。

## 3. 与证据引擎的对接点（渲染管线落地时）

- `EvidenceSpan`（`src/patent/evidence/span.ts`）：引用日志行可由 span 结构化数据直接生成。
- `verifyQuoteInSource`：pin-cite 在渲染前全量校验，失败的映射行渲染为"未校验"样式并进 gap 列表。
- `ChartRow.verified`（claim-chart）：false 的行在文书中标 `☐` 或"待核实"，禁止直接显示为证据支撑。
- gap 检测结果（`chart.gaps`）渲染进"九、假设与局限"，提示后续补充证据。

## 4. 反例（禁止）

- 编造公开号、日期、段号（如"CN102341592A ¶0010"实际不存在）
- 以模型记忆充当来源（"根据公开常识"无出处）
- 客户提供材料与公开文献混排不区分（必须分来源类型标注）
- 引用日志与正文断言不一致（渲染后自查，见 `checklist.md` P0-05）
