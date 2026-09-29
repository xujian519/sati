# Agent Note: 检索候选 LLM 摘要精排（patent_candidate_rerank）

Status: implemented（2026-09-29）

## Problem

查新检索与无效证据收集在"筛选与排序"步骤（`patent-prior-art-search` 第三步）依赖模型对候选相关性的判断，但既有排序只有两条路：① 检索通道自带的相似度/相关度字段（本地库 IDF 余弦、浏览器通道的引擎排序），口径不一且对"同一技术不同表述"漏排；② 可选的 cross-encoder rerank（`src/model/embedding/rerank.ts`），精度高但要求用户自建 TEI/oMLX 端点——零配置用户完全不可达。竞品调研（`handsomestWei/patent-disclosure-skill` 的"LLM 摘要精排"、PQAI 的语义近邻）表明：直接用主模型对摘要打档是零部署、可解释（能输出判定理由）的第三通道。

## Decision

新增 `src/patent/search/llm-rerank.ts` + `patent_candidate_rerank` 内置工具：一次批量调用把 query 与 ≤20 条候选（标题 + 截断 ~400 字摘要 + 公开日）交给会话主模型（继承 `context.provider/modelId`，缺省 moonshot/kimi-k3），输出每条 `{id, tier 0-3, reason}`，档位语义对齐技能既有分档（3=高相关>80%、2=中相关 50-80%、≤1 丢弃但留痕）。解析走 `llm-json.tryParseJson` 并容忍对象/裸数组/代码围栏三形态；失败带 schema 修复重试一次；**任何终失败降级原序 + `degraded=true`**，不阻断检索（对齐"语义检索失败自动降级关键词检索"规范）。技能接线：`patent-prior-art-search` 第三步（候选 >10 条必做）、`patent-agent` 工具表。

## Alternatives considered

- **只推 cross-encoder rerank 端点** — 否决：需要外部部署（TEI/oMLX），零配置不可达；且无判定理由，代理人无法核对机器打档依据。两者并存互补：端点在（记忆/知识检索链路）继续用端点，候选精排走 LLM 档。
- **在 `patent_search` 工具内部自动串精排** — 否决：改变既有工具输出契约（重放契约 #6 全面失配），且兜底通道（本地 PostgreSQL 批量检索）不需要每条都烧 token 精排；独立工具让编排者按需决定何时精排。
- **sentence-transformers 本地 embedding 近邻（PQAI 路线）** — 否决：需引入 Python/WASM 模型推理依赖，与"不内置模型、走可配置端点"的既有约束冲突；语义档已有可选 EmbeddingClient 增强层承载。

## Consequences

换来：零配置即可用的可解释排序通道，档位与理由直接进检索报告；成本换精度（每批候选一次 LLM 调用，上限 20 条控制 token 用量）。付出：新增工具改变 patent 会话工具面，受影响 llm-replay fixture 需重录；模型打档存在主观性，故保留 reason 供人工复核、低档"丢弃但留痕"而非物理删除。
