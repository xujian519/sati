# Agent Note: 规则资产语义增强 3 项（全角漏报 / 安防误伤 / 重复项去重）

Status: implemented

## Problem

`rules/README.md` 的「遗留（接线时一并处理）」段登记了 3 项**规则资产语义增强**，标注
「须独立评审误拦面后再动」后即无排期，也**没有跟踪载体**（既不在 `backlog.md` 编号体系里，
也不进 issue 跟踪，只活在一份 README 的段落中）——issue #357 就是为了给它们补载体。

核码后三项都成立，但 issue 的措辞在各处都需要修正：

1. **X-REF-003 全角括号漏报（漏报方向）**。资产里 3 条关键词只有**半角大写**一种拼写
   （`(202X)最高法知民终` / `(202X)京73民初` / `(202X)最高法知行终`）。`keyword_blocklist`
   的匹配是 `text.indexOf` 子串匹配且**大小写敏感**（与 `pattern_analysis` 的 `gi` 不同），
   于是「中文文本常用的全角括号」以及小写 `x` 变体**全部漏检**：3 案号族 × 3 种新拼写
   = **9 个变体实测全漏**。这是 `action: block` 的规则，漏报 = 编造案号拦不住。
2. **EX-SEL-004 误伤合法安防主题（误伤方向）**。该规则 `check` 里**根本没有**
   `negationContext` 字段 ⇒ 否定语境过滤整体未启用，连共享默认词表（`防止/避免/不用于/…`）
   都用不上，「用于防止窃听」也会命中，更不用说「防窃听装置」。issue/README 记的
   「（后续补 negationContext）」是准确的，但它没说清"当前连默认词表都没生效"。
3. **EX-INV-007 ↔ IPC-GEN-INV-002 逐字重复**。两条 `keyword_blocklist` 同名同域同
   keywords（`事后诸葛亮` / `hindsight` / `ex post facto`），同一段文本产出**两条**内容相同
   的用户可见提示。

## Decision

三项全部落成 `rules/patent/activation-overrides.yaml` 的**评审补丁**，配套两处能力扩展。

### 1. 「激活评审补丁」从「仅 action」扩为「action 整替换 + check 级增补」

`ActivationRulePatch`（`src/rule/runtime/RuleLoader.ts`）新增三个 check 级键：

- `addKeywords`：**追加**关键词（不重声明既有）；
- `negationContext`：覆盖否定语境开关；
- `additionalNegationWords`：**追加**域放行词（叠在共享默认词表之上）。

三条具体处置：

| 项 | 补丁 |
|---|---|
| X-REF-003 | `addKeywords` 追加 3 组 OR，每组 = 一个案号族的 4 种拼写（半角大写/全角大写/半角小写/全角小写） |
| EX-SEL-004 | `negationContext: true` + `additionalNegationWords: ["防","反","抑制","检测"]` |
| IPC-GEN-INV-002 | `action: log`（保留 EX-INV-007 的 warn） |

**为什么必须走补丁而不是直接改资产**：`rules/patent/nuo-*.yaml` 由
`scripts/port-nuo-rules.ts` 从 XiaoNuo Agent 的规则目录**转换生成**（文件头自述、
`assets/patent-rules/` 存原始副本）。手改会让文件头的 provenance 失真，且下一次重新移植会
**静默抹掉**——X-REF-003 是 block 级，静默丢失等于拦截面失真（与 #355 修掉的"静默陈旧"
同型）。补丁文件自己的定位就是「评审结论的机器可读权威」，本批正是评审结论。

**为什么补丁是增补而不是整字段替换**：让补丁重声明整条 `check` 会在仓里造出第二份必须
同步维护的副本（正是要消掉的那类东西）。增补式补丁既不碰生成物，也不产生副本。

### 2. 新增 `additionalNegationWords`（两键正交 + 缺开关告警）

`KeywordBlocklistCheck` 新增 `additionalNegationWords?: string[]`。

- **域词不进共享默认词表**：`DEFAULT_NEGATION_WORDS` 是**全局**词表，加一个词会同时放大
  **所有**否定语境规则（PAT-RISK-001 / PAT-ABS-001 / INV-EVIDENCE-001…）的放行面。
- **两键正交**：`negationContext` 是唯一的开关，`additionalNegationWords` 只提供词。
  缺开关时词表不生效，且**加载期告警**（`RuleLoader` 与补丁路径各有一条同源判据）——
  「声明了却不生效」不得静默。

### 3. 补丁四类结构性问题从「静默」改为「加载期告警」

此前 `loadActivationOverrides` 只读 `action`，其余键一律被忽略；`applyRuleOverrides` 对
不存在的 id 也一律忽略。现改为：**未知键**、**引用不存在的 id**、**check 级键打在非
`keyword_blocklist` 规则上**、**两键组合非法** 四类都进 `warnings`（经
`loadPatentFullRuleSet` 冒到调用方）。

## Alternatives considered

- **直接改 `rules/patent/nuo-*.yaml`（生成物）** — 落选：见 Decision 第 1 点。这是本次最
  容易走错的一步；判据是文件头自述的由来的 + 7 个 nuo 文件自导入起各只有 1 个提交（零手改
  先例）。
- **顺带改 `scripts/port-nuo-rules.ts` 让它保留手改** — 落选：无法区分"转换漂移"与"人工
  增补"，且源目录（XiaoNuo Agent 侧）不在本仓，CI 无法验证"重新生成后仍是当前内容"。
  补丁层把两者分开了：生成物保持纯生成，人工结论进补丁。
- **补丁支持 `check` 整字段替换** — 落选：迫使补丁重抄 keywords ⇒ 第二份副本。
- **删掉 IPC-GEN-INV-002（或在生成物里合并两条）** — 落选：两条分处 examination / ipc 两个
  生成文件，删任一条都会被下次重新移植还原；且 id 被 README 表格与台账引用。改用与同章节
  EX-INV-001↔IPC-GEN-INV-001 **完全相同**的先例处置（保留前者 warn、后者 log）。
- **把「防/反/抑制/检测」加进共享 `DEFAULT_NEGATION_WORDS`** — 落选（**有判据**）：这是
  「只加 4 个词」看上去最省事的做法，但它会同时放大所有否定语境规则的放行面。负控制
  M10/M11 实测：「检测」入全局后「经检测，该产品构成侵权」被判成否定语境（PAT-RISK-001
  漏报）、「反」入全局后「反对绝对化表述」漏报。
- **`additionalNegationWords` 声明即开启过滤** — 落选：首版就是这么实现的，于是
  `negationContext: false` + 词表这种自相矛盾的组合会变成"词表说了算"，读代码看不出谁生效；
  且写 `negationContext: true` 会变成**死配置**（对任何可观测行为都无影响 ⇒ 它就没有判据）。
  改为两键正交后，开关自身承重（负控制 M8：关掉开关 → 6 条放行样本全红）。
- **把 `keyword_blocklist` 匹配改成大小写不敏感** — 落选：会**扩大**命中面（英文关键词
  `hindsight` / `ex post facto` 的首字母大写写法将开始命中），与"误拦面不扩大"取向相反；
  且是全部 `keyword_blocklist` 规则的匹配语义变更。改用显式补小写变体（判据可逐条对名）。
- **改用 `pattern_analysis` 正则表达 OR（如 `[(（]202[Xx][)）]`）** — 落选：X-REF-003 现为
  `keyword_blocklist`（block 级、已过免误伤样本验证）；`selectGateRules` 与
  `policy-bridge` 都按 `check.type` 分流，改类型动的是规则在 B/C 链上的接入面，超出"匹配
  精度增强"的范围。
- **给 EX-SEL-004 补后置语境豁免（修掉后缀式「窃听检测」）** — 落选（本次范围外）：
  否定语境是**共享**语义（`text-utils.hasNegationContext` 同时服务 `synonym-engine.matchKeyword`
  与 `src/patent/quality-gate.ts` 的镜像词表），改成双向会放大所有否定语境规则的放行面。
  本次以**显式断言**登记该非对称性（`rule-asset-review-samples.spec.ts` 中「后缀式仍命中」
  用例），将来真要改，那条用例正是应当转红的地方。
- **只在文档里把三项写清楚、不改行为** — 落选：README 的样本表**已经**如实写着
  「防窃听装置 ❌命中」——文档没错、行为错了，这是缺陷不是文档缺口。
- **顺手把 `reason` 之外的人读字段（如 `note`）也做成补丁键** — 落选：`reason` 已经是
  人读字段且被允许；再加同义字段只会扩大补丁 DSL 面积。

## Consequences

- **换来**：三项评审结论落地且**不会被重新移植抹掉**；补丁能力覆盖"匹配精度增强"这一类
  评审结论（此前只覆盖"降级/升级"）；四类"评审写了但没生效"的配置问题在加载期可见。
- **口径变化**：patent-full 的动作分布 `2 block / 2 review / 66 warn / 30 log` →
  `2 block / 2 review / 65 warn / 31 log`；补丁条目 29 → 31（`rules/README.md` 与用例同步）。
- **已知面（未在本次变更，如实登记）**：`loadPatentFullRuleSet` 对补丁**解析失败**是
  fail-open——解析失败 ⇒ 空补丁 + 告警 ⇒ 29 条降级结论整体失效（block 数从 2 回到 31）。
  本次实测踩到一次同型：新增 `EX-SEL-004:` 键与既有条目重复 ⇒ `doc.errors` ⇒ 空补丁 ⇒
  分布回落到 `31 block`。方向是"更严格"而非"更宽松"，故未改其 fail-safe 方向，但值得后续
  单独立项（属于"配置解析失败该如何降级"的通用问题）。
- **残余缺口（登记）**：① 后缀式否定不豁免（见 Alternatives 第 8 条，已显式断言）；
  ② `synonym_match` 的 `matchKeyword` 仍只用共享默认词表，不吃 `additionalNegationWords`
  ——语义不同（synonym_match 是"期望要素命中"），本次未动。
- **本轮未触碰**：`assets/patent-rules/`（XiaoNuo 原始资产，不进 RuleLoader）；
  `src/patent/quality-gate.ts` 的否定词镜像（共享默认词表未变，镜像无需同步）。

## 负控制矩阵

目标判据 = `tests/rule/rule-asset-review-samples.spec.ts`（23 例，每条样本独立成 `test`）
与 `patent-full-rule-set.spec.ts`（14 例）。每条注入都先断言锚点出现次数符合预期（证明
变异已生效），跑完即刻 `cp` 还原（**不用** `git checkout --`），并核对「转红名单 == 预测
名单」且无额外红项。

| # | 注入（退化） | 目标 spec | 转红 | 命中 |
|---|---|---|---|---|
| M1 | X-REF-003 去 `（202X）最高法知民终` | 样本 | 1（知民终·全角大写） | ✓ |
| M2a/b/c | 逐族去小写变体（`(202x)`x + `（202x）`x） | 样本 | 每族 2（半角小写 + 全角小写） | ✓ |
| M3 | 去 `（202X）京73民初` | 样本 | 1 | ✓ |
| M4 | 去 `（202X）最高法知行终` | 样本 | 1 | ✓ |
| M5 | EX-SEL-004 去放行词 `防` | 样本 | 1（防窃听装置） | ✓ |
| M6 | 去放行词 `检测` | 样本 | 1（检测…前置） | ✓ |
| M7 | 去放行词 `反`+`抑制` | 样本 | 2 | ✓ |
| M8 | `negationContext: true` → `false` | 样本 | 6（全部放行样本） | ✓ |
| M9 | IPC-GEN-INV-002 `log` → `warn` | 样本 | 2（中/英去重样本） | ✓ |
| M10 | 「检测」加进共享 `DEFAULT_NEGATION_WORDS` | 样本 | 1（PAT-RISK-001 不外溢） | ✓ |
| M11 | 「反」加进共享默认词表 | 样本 | 1（PAT-ABS-001 不外溢） | ✓ |
| M12 | 域词**替换**默认词表而非叠加 | 样本 | 1（避免…克隆人） | ✓ |
| M13 | `addKeywords` **替换**而非追加（结构判据） | 补丁 | 1（补丁落地用例） | ✓ |
| M14 | 基础资产条目丢失（重新移植场景） | 样本 | 0 | ✗ **无效负控制** |

M14 的判定说明（如实分类，非判据缺口）：补丁的 OR 组**有意**做成自包含（每组都含半角
大写），因此"基础资产里那条被重新移植改掉"在该设计下**没有可观测差异**——该注入不对应任何
已变更行为，作废。「增补而非替换」由 M13 从结构侧钉住（`keywords.length === 6`），
「半角大写拼写不得漏」由样本用例从行为侧守住。

还原后复跑：样本 spec 23 pass / 0 fail、补丁 spec 14 pass / 0 fail。

## 相关

- issue **#357**（本 note 关闭）；台账 `docs/technical-debt/backlog.md` §13 · 映射表
  「`rules/README` 遗留 3 项」
- 资产文档：`rules/README.md`（「关键词匹配的四个既有语义」「规则资产语义增强（2026-09-16）」
  「遗留（已清空）」三节随本次新增/改写）
- 判据：`tests/rule/rule-asset-review-samples.spec.ts`（新）、
  `tests/rule/patent-full-rule-set.spec.ts`（补丁数量与四类告警）
- 能力扩展：`src/rule/protocol/types.ts`（`additionalNegationWords`）、
  `src/rule/runtime/RuleLoader.ts`（`ActivationRulePatch` / 校验）、
  `src/rule/runtime/RuleEngine.ts`（词表合并）、`src/rule/runtime/patent-compliance.ts`（补丁解析）
- 相邻条目：`TD-RULE-N03`（domain 过滤线上不生效）、`TD-RULE-N04`（`selectGateRules` 硬编码
  id 前缀）——issue #357 建议"一并评估"的两处未接线项，本次结论：属产品/调用方决策，
  不在"规则资产语义增强"范围
