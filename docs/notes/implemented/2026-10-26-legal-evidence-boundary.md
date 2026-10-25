# Agent Note: 法律面强制核验与检索分层（law_verify 强制动作 + 证据层边界）

Status: implemented

## Problem

法律面仍靠提示词自律：`skills/legal-agent/SKILL.md` 只要求 `law_search`（找法条），从不要求 `law_verify`（判引用是否成立）。核验内核 2026-10-15 已落地，但没有任何技能把「每条法条引用必须核验」变成交付前的固定动作；检索也没有层次，法条与案例并列出现，案例可以先于法条依据。

同时存在文档漂移：`src/patent/evidence/index.ts` 头注释写「领域判定（三性/证明标准）明确留二期」，而 `engine.ts` 早已实现三性判定、举证责任与证明标准。后来人据此会以为证据判定不可用，法律面也不会去调用它。

## Decision

**SKILL 文案（`skills/legal-agent/SKILL.md`）**

- 把 `law_verify` 列为**强制动作**：核心原则、五步工作法的第 3 步、质量门禁三处同时要求；未核验的引用不得作为结论依据。
- 新增「法条核验（强制）」段，给出五态判定的逐一处置：`valid` 通过、`mismatch` 与 `out-of-range` 拦截重做、`not-indexed` 重新检索或显式标注、`unverified` 标注来源限制。
- 新增「检索分层（法条 → 案例）」：`law_search`（法条层）→ `law_verify`（核验层）→ `patent_case_search` / `law_search level=案例`（案例层），顺序不得颠倒；案例结论必须回指已核验的法条。
- 写明能力边界：`law_verify` 是**引用形式门禁**，只判条号成立与命题/条文共享片段，**不判命题正确性**；沿革/版本判定仍以 `law_search` 的失效标记与发布日期为准。
- 写明不可用降级：知识库缺失或工具关闭时，保留 `law_search` 原文人工核对，输出标注「未做形式核验（law_verify 不可用）」，不得静默当通过；并说明这会让编造条号与越界条号失去机械拦截。

**证据层头注释（`src/patent/evidence/index.ts`）**

- 删除「留二期」表述，写明领域判定已在 `engine.ts` 实现并经本文件 re-export。
- 声明法律面与证据层的分工：`EvidenceEngine` 判证据可采性（三性/举证/证明标准），`law_verify` 判法条引用形式（条号/片段），两者语义不同、不互相复用。

**注册表语义**

- `createBuiltinRegistry` 中 `law_search` / `law_verify` 默认注册、同属 `legal` 域、`legal: false` 一并关闭的语义未变；新增测试把这一开关锁住，避免只关一半留下半套法律面。

**测试**

- 新增 `tests/skills/legal-agent.spec.ts`：文案契约测试，断言强制段、五态处置、检索顺序、形式门禁口径与降级标注。
- `tests/patent/evidence-engine.spec.ts` 补导出面断言：`EvidenceEngine`、`inferEvidenceType`、`evaluateFourElements` 与证明标准常量可从 patent barrel 调用。

## Alternatives considered

- **做运行时强制（ToolGuard / 前置交付门）** — 更硬，但需要「交付工具调用前，本会话必须已成功执行 `law_verify`」的前置交付门；Sati 目前只有输出后置门禁与单调 deny 的 `ToolGuard`，没有这套机制。且会话级「调用过一次」的门禁可被空文本调用绕过，要做对需要核验回执与产物绑定，是行为/权限面变更，超出本 P3 文案包。
- **把 `law_verify` 回执写入 `ClaimBinding` / `EvidenceReceipt`（T-10-03 的原口径）** — 法条引用不是「结论的证据切片」，`ClaimBinding` 记录的是 claim ↔ evidence span；把条号核验塞进去会制造一条没有消费者的证据链。S-09 已用 `ArgumentRef` 表达法条指针，等出现需要「引用核验状态」的消费方（如交付门禁）再接线。
- **用 `EvidenceEngine` 替代 `law_verify`** — 引擎判证据可采性（关联性/真实性/合法性），对一条法条正文打三性分没有语义；硬复用会把「条号是否成立」伪装成「证据是否可采」，制造假耦合。
- **保留「留二期」并加 TODO** — 违反「降级但不静默」：文档声称能力缺失会直接误导调用方，且与 `engine.ts` 的事实相反。
- **在 SKILL 里宣称已核验「命题正确性」** — 已知漏放方向（命题含常见法律词即通过）会让文书获得虚假可信度；只能声明形式核验，并把命题判断留给人工或更强判据。

## Consequences

- 测试是**文案契约测试**：只证明技能声明了强制动作与分层，不证明模型运行时会调用 `law_verify`。谁因此漏了什么：本 PR 没有运行时门禁，若模型不遵守该段，编造条号仍不会被机械拦截；要闭合需另做前置交付门（见上）。
- `law_verify` 不可用时的降级路径要求显式标注；漏掉标注会把「未核验」冒充「已核验」，这正是本次要消除的形态。
- 头注释修正为纯文档变更，无行为变更；工具 `inputSchema` 未改，无需重录 llm-replay。
- 注册表测试锁住 `legal: false` 的成对关闭语义，后续拆分注册块会立即转红。
