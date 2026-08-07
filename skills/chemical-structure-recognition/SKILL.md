---
name: chemical-structure-recognition
description: 化学式/化学结构识别 - 将化学结构图（含 Markush 广义结构）、分子式或化合物名称转换为 SMILES 与分子式，经 RDKit 校验防幻觉。触发：(1) 交底书/说明书含化学结构式或分子式 (2) 权利要求化合物名称需转 SMILES (3) 化学领域（tech_domain=chemical）专利分析。
priority: high
layer: core
conflict_with: []
preferred_over: []
limitations: 不直接解析 PDF（图片模式需先导出图片）；Markush 广义结构识别置信度较低，需人工复核
---

# 化学式识别技能（本地 + VLM）

> **场景**：处理化学领域专利（医药、材料、化工）时，识别结构图/分子式/化合物名称。

## 核心能力

- **图片两步法**：多模态模型（默认 kimi-k3）判定结构图类型 → 提取多候选 SMILES（top-3）
- **文本三级流水线**：正则候选 → LLM 复核/名称转换 → RDKit 校验
- **防幻觉闭环**：任何来源的 SMILES 必须经 RDKit（WASM）校验；全部非法或置信度不足 → `needHumanReview=true`

## 使用方式

调用工具 `recognize_chemical_structure`：

| 输入 | 说明 |
|---|---|
| `image_path` | 化学结构图路径（jpeg/png/gif/webp；**PDF 页先经附件解析导出为图片**） |
| `text` | 文档文本片段（说明书/权利要求），或单独的化合物名称（name→SMILES） |
| `mode` | `image` / `text` / `auto`（按输入分派，默认） |
| `claim_context` | 权利要求/技术方案文本（图文对齐，提高准确率） |

## 触发场景

✅ **适用**：
- 交底书/说明书出现化学结构式、Markush 广义结构、分子式（如 C6H12O6）
- 权利要求中化合物名称需转为 SMILES 进行检索/比对
- 化学领域专利的撰写（draft_specification 的化学表征部分）、无效/侵权分析

❌ **不适用**：
- 机械/电路/流程附图 → 用 `analyze_patent_figure`（附图标记与附图说明）
- 纯文本化学性质数据（熔点/波谱）→ 用 `validate_specification` 的化学表征校验

## 与相似工具的分工

| 工具 | 场景 |
|---|---|
| `recognize_chemical_structure` | 化学结构式/分子式/名称 → SMILES（本技能） |
| `analyze_patent_figure` | 机械/电路/流程图 → 组件/标记/附图说明 |

## 注意事项

- **人工复核**：结果 `needHumanReview=true` 时（置信度 < 0.6、全部候选非法、或 RDKit 不可用仅语法预检），必须交人工确认后再用于撰写/检索；
- **Markush**：含 R 基团变量的广义结构置信度天然偏低，识别后应标注 `markush` 类型并复核；
- **PDF**：工具不解析 PDF——先经附件解析导出页面图片，或提取 PDF 文本层后走 `text` 模式。
