# Agent Note: 法律域八类法定证据三性判定（evaluate_legal_evidence）

Status: implemented

## Problem

Sati 的法律面只有「找法条」（`law_search`）与「判引用形式」（`law_verify`），没有「判证据」的能力。
专利域的 `evaluate_evidence` 证据类型是现有技术/使用公开导向的 15 类（general / foreign_language /
overseas / internet_publication / public_use / design_comparison …），缺《民事诉讼法》第 66 条
的八类法定证据（书证、物证、视听资料、电子数据、证人证言、当事人陈述、鉴定意见、勘验笔录）。
上游 `deepseek-harness/packages/legal/legal-evidence` 已有这套八类判定（MIT），此前在
`2026-10-29-legal-skill-pack-import.md` 的 P2 中列为「未落地」。

## Decision

**新增独立工具 `evaluate_legal_evidence`，不扩 `evaluate_evidence` 的 enum。**

- 证据类型体系是两套语义：把八类法定证据塞进专利工具的 `evidenceType` 会让「现有技术抗辩」
  与「诉讼证据采信」混在一个枚举里，稀释专利侧既有契约，并让既有调用方看到无关枚举值。
- 新工具复用同一套「确定性评分 + YAML 规则 + 类型判定器」结构，但类型、规则资产、
  权重与判定器全部独立：`src/knowledge/legal/legal-evidence/`。

**落点**

| 文件 | 作用 |
|---|---|
| `src/knowledge/legal/legal-evidence/types.ts` | 八类枚举 + 三性/发现/输入输出契约 |
| `.../rule-set.ts` | YAML 规则集解析（坏条目告警跳过） |
| `.../evaluators.ts` | 8 个类型判定器 + 通用关联性/合法性基线 |
| `.../engine.ts` | 权重加权、规则发现、推理串 |
| `.../rule-loader.ts` | `SATI_RULES_DIR/legal` → `cwd/rules/legal` → 包根 `rules/legal` |
| `.../tool.ts` | `evaluate_legal_evidence`（legal 域，只读、并发安全） |
| `.../index.ts` | barrel |
| `rules/legal/legal-evidence-rules.yaml` | 16 条规则 + 权重（含法律依据） |
| `src/rule/runtime/asset-location.ts` | 新增 `candidateDomainRuleDirs(domain)`，`candidateRuleDirs()` 改为委托（行为不变） |
| `src/tool/registry/createBuiltinRegistry.ts` | 注册进 `legal` 域块（`legal: false` 成对关闭） |
| `tests/knowledge/legal/legal-evidence.spec.ts` | 10 条单测（解析/分派/规则命中/权重/降级/工具契约） |

**输入 schema 变更 → 必须重录 llm-replay。** 新增工具改变了 `toolNames` 与 `toolSchemaDigest`。
本次已用真实 API key 重录 `tests/fixtures/llm-replay/deepseek-v4-flash-basic`
（`SATI_LLM_REPLAY_RECORD_ROOT=… node --import tsx scripts/record-real-fixture.ts "<原任务文本>"`，
随后 `pnpm record:replay` 校验），新 manifest 的 `toolNames` 含 `evaluate_legal_evidence`，
重放测试通过。未手改任何 `key` 字段。

**降级可区分**：规则资产缺失时引擎仍用默认权重评分，但工具输出 `rulesLoaded: false` 与
`warnings`，摘要里写明「规则检查项缺失」——不把「没加载资产」呈现成「检查通过」。

## Alternatives considered

- **扩 `evaluate_evidence` 的 `evidenceType` enum** — 省一个工具，但把两套证据语义缝在一个
  schema 里；专利侧的 `public_use` / `prior_art_date` 与诉讼侧的 `documentary` / `inspection_record`
  共用一套类型特定判定会互相污染，且既有调用方的语义边界变模糊。落选。
- **复用 `EvidenceEngine` 只换 enum** — 引擎的类型特定判定（四要件、互联网公开日期、平台可信度）
  对法定证据无意义，等于用专利判据回答「书证能否采信」。落选。
- **把八类判定塞进技能文案（不做工具）** — 与既有 `law_verify` 的教训相反：能确定性判定的东西
  交给模型自由发挥，会让「评分」变成没有判据的文字。落选。
- **规则资产内联在 TS 里** — 与 `rules/patent/` 的既有资产约定不一致，也让非开发者无法改严重度/法律依据。落选。
- **不重录 fixture、改成条件注册（默认不注册）** — 会让法律域默认少一个工具，用户必须显式开启；
  且本机有可用 key，重录成本可接受。落选。

## Consequences

- 工具面 +1（`evaluate_legal_evidence`），法律域从 2 工具变 3；`legal: false` 三者一起关闭。
- 评分是**确定性启发式**：输入是调用方自报字段（是否已提供原件、哈希是否已核验等），
  自报 `true` 不等于事实已核验；工具不校验原件或哈希本身。谁因此漏了什么：本次没有接入
  任何文件/哈希实测，证据真伪仍要靠人工与原始载体核对。
- 规则资产按 `rules/` 定位（与 patent 同模式），打包形态依赖包根 `rules/legal/`；
  缺失时按上文降级路径显式标注，不会静默。
- llm-replay fixture 已重录，`.gitignore` 不涉及（`*.test.ts` 规则不影响 `*.spec.ts`）。
