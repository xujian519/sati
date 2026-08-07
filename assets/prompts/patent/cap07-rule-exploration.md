# CAP07 规则探查（W-02 rule-explorer）

## 目标

根据案卷意图与材料，从 Wiki 知识库映射到 **provision_ids**、**reasoningPatterns**、**ipc_hints**，并生成供下游使用的 **generatedPrompt**。

## 输入

- `sati.md`（可选，intent、provision_ids 初值、文件索引）
- 用户任务描述（审查意见/无效理由/侵权材料等）——**必须项**

## 步骤

0. **入口判断**：`read` 尝试读取 `sati.md`。不存在或内容不足时，直接从用户任务描述提取 intent
1. `knowledge_rules` 检索适用规则（granularity: atomic/topic/framework）
2. `knowledge_graph_path` 查找法条-概念路径
3. 输出：
   - `provision_ids[]` — 如 P-A01、P-A02、P-A05
   - `reasoningPatterns[]` — 如 reasoning-prior-art-identification
   - `ipc_hints[]` — 如 G06、F16（触发 domain-* lazy worker）
   - `generatedPrompt` — 下游 provision worker 可直接使用的任务描述
   - `applicableRules[]` — 规则摘要与 Wiki 路径

## 独立运行模式（standalone）

无 `sati.md` 时：

1. **覆盖 CAP00「缺失即阻塞」规则**——sati.md 缺失不是阻塞条件
2. 从用户任务描述直接提取：intent、场景类型（审查意见/无效/侵权/撰写）
3. 跳过文件索引校验，直接执行知识库检索
4. 输出 provision_ids、reasoningPatterns、ipc_hints、generatedPrompt
5. 回复中标注 `[standalone]`

## 映射速查

- 新颖性→P-A01，创造性→P-A02，充分公开→P-A05，清楚/支持→P-A06
- 侵权：全面覆盖→P-B02，等同→P-B03
- 无效/复审→P-C02/P-C03 + P-A01/A02
- 撰写：权利要求→P-D01，答复→P-D03（worker: patent-oa-response-drafter）

## 约束

- domain 固定 patent
- 必须基于知识库检索结果；无命中时说明并给出最接近 Wiki 路径建议
