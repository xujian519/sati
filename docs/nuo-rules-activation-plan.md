# nuo 专利规则激活专项实施计划 —— 宪法规则引擎接入生产

- 创建日期：2026-08-16
- 状态：**✅ 已实施（2026-08-16）**——T1 评审、T2 A 链（rule_check patent-full）、T3 B 链（规则驱动输出门禁）均落地并验证；T4 C 链（policy-bridge 工具拦截）为可选二期未接线（见 §3.4）
- 范围：把 `rules/patent/nuo-*.yaml`（7 文件 96 条，XiaoNuo 移植的确定性专利规则）从"沉睡资产"激活为生产能力——覆盖 `rule_check` 工具面、规则驱动输出门禁、可选工具拦截面
- 前置：技术债报告中期项 #9（2026-08-14 决策：**激活，评审后接入**）；本计划将 #9 从"接入 rule_check"扩展为完整的三链接入（调研发现 #9 原登记范围偏窄，见 §2.4）
- 成本估算：核心 4–6.5 人日；含 T4（可选工具拦截）5.5–8.5 人日

---

## 1. 背景

### 1.1 专项来源

`rules/patent/nuo-*.yaml` 由 `scripts/port-nuo-rules.ts` 从 XiaoNuo Agent 的 `data/rules/` 转换而来（源资产在 `assets/patent-rules/`，可重新生成），属**可执行转换**：`check.type` 均为本引擎支持的确定性检查（keyword_blocklist / structural_analysis），由 RuleLoader 加载即可生效。但当前**生产零加载**——7 文件 96 条规则全部沉睡，`rule_check` 仅加载 `compliance.yaml`（4 条）。

2026-08-14 技术债审计已决策"激活（评审后接入）"并登记为 Sprint Backlog 中期项 #9，前置为**31 条 `action: block` 逐条评审**（拦截面最大）。本计划承接该决策，并基于 2026-08-16 调研将范围核实为完整的三条接入链。

### 1.2 为什么收益最大

- **核心卖点激活**：Sati 的差异化之一是"宪法规则引擎 + 声明式合规"，但当前生产路径上规则引擎消费的规则数 = 4（compliance.yaml）——96 条专利法/审查指南/IPC/判例知识处于沉睡状态，属"最后一公里"。
- **全链路已就绪**：分层加载器（`loadRuleSetDir` / `loadRulePack`）、评估器（`evaluateText`）、输出门禁（`RuleOutputGate`）、HITL 审批闭环（`GatewayApprovalBus` + `approvalDecide`）全部落地，只差规则资产与接线。
- **与技能端到端验证强协同**：专利技能（patent-agent 等 27 个）输出将被真实规则约束，后续技能验证才有完整闭环。

---

## 2. 调研结论（已核实，2026-08-16）

### 2.1 资产构成

| 文件 | 规则数 | action 分布（block/warn/log） | domain 分布 |
|---|---|---|---|
| nuo-compliance-enforceable.yaml | 3 | 2/1/0 | patent_general 3 |
| nuo-patent-core-rules.yaml | 10 | 1/6/3 | general 6, procedure 2, inventiveness 1, oa_response 1 |
| nuo-patent-examination-rules.yaml | 27 | 10/11/6 | general 6, disclosure 6, claims 5, inventiveness 4, novelty 3, procedure 2, oa_response 1 |
| nuo-patent-ipc-rules.yaml | 9 | 2/3/4 | inventiveness 9 |
| nuo-patent-judgment-rules.yaml | 14 | 5/7/2 | infringement 8, procedure 4, general 2 |
| nuo-patent-law.yaml | 15 | 8/7/0 | inventiveness 4, claims 3, procedure 2, oa_response 2, general 1, novelty 1, disclosure 1 |
| nuo-patent-practice-rules.yaml | 18 | 3/13/2 | claims 7, disclosure 6, oa_response 4, procedure 1 |
| **合计** | **96** | **31/48/17** | 8 个专利子域 |

- **31 条 block**：check 类型分布——keyword_blocklist **5 条**、structural_analysis **26 条**（完整清单见附录 A）；
- 全部规则已带 `legalBasis`（专利法/审查指南/细则条文号），违规输出可直接展示法律依据；
- 规则由迁移脚本生成（`pnpm tsx scripts/port-nuo-rules.ts`），上游资产变更可重新生成——**禁止手改 nuo-*.yaml**，评审调整应走脚本或另建 override 文件（见 §3.2 决策 D2）。

### 2.2 生产路径上的规则消费点（3 处，全部只吃 compliance.yaml 或更少）

| 消费点 | 位置 | 现状 |
|---|---|---|
| `rule_check` 工具 | `src/tool/builtin/ruleCheck.ts` | scope=patent → `loadPatentComplianceRuleSet()`（compliance.yaml 4 条）；scope=patent-electrical → +electrical-section-h；scope=pack → `loadRulePack`。**不传 domain 过滤，全量评估** |
| 输出门禁 | `src/patent/output-gate.ts`（PatentOutputGate） | **关键词质量门禁**：`PATENT_RISK_KEYWORDS` / `PATENT_APPROVAL_KEYWORDS` 等硬编码词表（镜像 compliance.yaml 关键词），经 TurnRunner.onDurableMessage 接入生产，挂起审批走 `GatewayApprovalBus` |
| 规则引擎输出门禁 | `src/rule/runtime/output-gate.ts`（RuleOutputGate） | **无生产实例化**（仅 barrel 导出 + 单测）——规则驱动的输出门禁从未上线 |
| policy-bridge | `src/rule/runtime/policy-bridge.ts` | `rulesToPolicyDenyRules` **无生产调用**（仅测试）——block 规则从未编译注入 `PermissionRuntime` 做工具拦截 |

### 2.3 关键事实核对

1. **`loadRuleSetDir(rules/patent)` 生产零调用**——RuleLoader 支持目录加载（单文件解析失败跳过并告警），但无任何代码消费 nuo 目录；
2. **`RuleOutputGate` 与 `PatentOutputGate` 是两套门禁**：前者规则引擎驱动（评估 96 条规则）、后者关键词驱动（词表镜像 4 条 compliance）——激活时需明确二者分工，避免语义重叠（见 §3.4 决策 D3）；
3. **`evaluateText` 支持 `domain` 过滤**（`options.domain`：已声明 domain 且不匹配的规则跳过，未声明者始终评估）——rule_check 目前未使用，可作为降低输出噪音的杠杆；
4. **policy-bridge 只支持 keyword_blocklist**（把规则编译为 `text:` 前缀 deny 模式作用于工具输入序列化文本）——31 条 block 中仅 **5 条**可走工具拦截，26 条 structural_analysis 天然不支持，只能作用于输出层；
5. **审批闭环可复用**：输出层挂起 → `approval_pending` 事件 → UI 审批卡片 → `approvalDecide` → `approvePendingOutput`/`rejectPendingOutput`，链路已打通（2026-08-11 落地），本专项不新增协议面。

### 2.4 范围核实结论

技术债 #9 原登记为"接入 `rule_check` scope=patent"（二选一接入路径）。调研确认实际收益面更广、也更大：**规则引擎驱动的输出门禁（RuleOutputGate）与工具拦截（policy-bridge）均未接线**，仅接入 rule_check 只覆盖"agent 显式调用"一个入口。本计划按三链组织：

- **A 链（工具面）**：rule_check scope=patent 扩展（agent 显式自检）
- **B 链（输出面）**：RuleOutputGate 接入生产输出路径（block/review → 强制挂起审批，warn → 追加提示）
- **C 链（拦截面，可选二期）**：policy-bridge 接线（5 条 keyword_blocklist block 规则 → 工具调用前拒绝）

---

## 3. 任务分解

### 3.1 T1：31 条 block 逐条评审 + 全量规则批量评审（0.5–1 人日）

**目标**：对 31 条 block 逐条给出"通过（按原 action）/ 降级（→ review/warn）/ 拒绝（不接入）"结论与理由；48 条 warn / 17 条 log 批量评审（按 domain 分组，是否全量接入）。

**评审要点**（block 规则的误伤风险集中在两类）：

1. **keyword_blocklist（5 条）**——命中即违规，误伤风险最高：
   - `CON-COMP-0101`（禁止编造占位专利号）、`CON-102`（禁止编造对比文件）、`X-REF-003`（禁止编造案例案号）：需用**真实合法文本样本**验证（如正常检索报告中的"CN101234567A"、判决书"（2020）最高法知民终xxx号"）是否会误命中；必要时加 `negationContext` 放行或降级为 warn；
   - `EX-CLM-001`（权利要求—清楚性要求）、`EX-SEL-004`（不授权—违反法律与公序良俗）：检查关键词表是否过宽。
2. **structural_analysis（26 条）**——requiresAll 缺失即违规，作为 **block（输出层=强制挂起审批）** 会高频误挂审批：评估 `minConfidence` 是否合理、要素 patterns 是否可达成；**高误挂风险的降级为 review/warn**（block 在输出层只差"是否强制审批"，降级不损失确定性检查能力）。

**产出**：
- `rules/README.md` 新增"nuo 规则激活评审"章节：31 条 block 逐条结论表 + 48 条 warn / 17 条 log 批量结论 + 评审日期；
- 评审调整的落地方式：**不手改 nuo-*.yaml**（可重新生成），降级/拒绝经 `rules/patent/activation-overrides.yaml` 表达（id → 覆盖 action），加载时后覆盖（决策 D2）。

**验收**：README 含完整结论表；任一被拒规则在加载结果中不出现；任一被降级规则 action 与评审表一致。

### 3.2 T2：A 链——rule_check scope=patent 扩展（1–1.5 人日）

**目标**：把评审通过的 nuo 规则并入 rule_check 可检范围，同时保持现有调用方行为稳定。

**改动**：

| 文件 | 改动 |
|---|---|
| `src/rule/runtime/patent-compliance.ts` | 新增 `loadPatentFullRuleSet()`：compliance.yaml + electrical-section-h.yaml + `loadRuleSetDir(rules/patent)` 目录加载（跳过 nuo 中被评审拒绝/降级的文件）+ `mergeRuleSets` 后覆盖（activation-overrides.yaml 优先于 nuo 生成文件） |
| `src/tool/builtin/ruleCheck.ts` | 新增 scope=`patent-full`（compliance + 通过评审的 nuo 规则）；**scope=patent 保持原行为不变**（4 条，兼容存量调用）；description 同步 |
| `src/rule/runtime/rule-pack.ts` | （可选）新增内置 pack `rules/patent-pack/` 若走 domains pack 路径（见决策 D1，默认不走） |
| `tests/rule/patent-compliance.spec.ts` 等 | 新增用例：patent-full 规则数 = compliance + 通过集；被拒规则不出现；降级规则 action 正确；目录加载单文件损坏不阻塞 |

**关键决策（D1 接入路径）**：采用**方案 (a) 新增 scope=patent-full**，不并入既有 scope=patent、不新建 domains pack。理由：① 存量调用方（专利域角色、既有测试）对 scope=patent 的语义依赖（4 条合规规则）不能突变；② nuo 规则是"内置专利资产"而非"项目领域包"，放进 `rules/domains/*`（mechanical/medical/chemical/software）语义不符；③ scope=pack 仍可供用户自装配（把 nuo 当作 override 目录引用不受影响）。
**关键决策（D2 评审调整落地）**：评审调整（降级/拒绝）经 `rules/patent/activation-overrides.yaml` 表达（`id: { action: review | warn | off }`），加载时后覆盖——nuo-*.yaml 保持"脚本可再生成"不变，评审结论与资产解耦、可审计。

**验收**：`rule_check(patent-full)` 对一段含"编造案号"文本报违规且含法律依据；对正常专利检索文本零误报（用 T1 样本回归）；scope=patent 行为不变（回归测试绿）。

### 3.3 T3：B 链——规则驱动输出门禁生产接线（2–3 人日）

**目标**：让评审通过的规则在 **Agent 输出路径** 真实生效：block/review 命中 → 强制挂起审批（复用既有 GatewayApprovalBus 闭环），warn 命中 → 输出追加合规提示。

**改动**：

| 文件 | 改动 |
|---|---|
| `src/rule/runtime/output-gate.ts` | 保持 RuleOutputGate 纯函数语义不变；补 `processWithSource`（返回规则来源层级摘要，对齐 rule-pack 审计惯例） |
| `src/patent/output-gate.ts` | 新增 `RuleDrivenGate` 适配层：`new RuleOutputGate(loadPatentFullRuleSet())` 包装为 `PatentOutputGate` 同构接口（processMessage 语义：`needsApproval` / `processed` / `info`），使 TurnRunner 既有接线零改造 |
| `src/patent/quality-gate.ts` | 明确分工（决策 D3）：**关键词门禁（现有）负责"风险词/免责声明"**，**规则门禁（新增）负责"结构性合规"**——两段式串接，先关键词后规则；规则违规追加进同一 `info` 结构 |
| `src/cli/createLocalGateway.ts` | 装配点：把 RuleDrivenGate 注入 `prepared.patentOutputGate`（或新增并接字段，视质量门禁结构） |
| `tests/patent/output-gate.spec.ts` 等 | 新增：block/review 命中 → needsApproval=true 且消息仍入库（processed 版本）；warn 命中 → 文本追加提示；门禁规则集加载失败 → 降级放行不崩（对齐既有空集降级语义）；与关键词门禁两段式串接顺序正确 |

**关键决策（D3 双门禁分工）**：不合并两套门禁（合并会丢失关键词表的轻量语义与既有审批行为），采用**两段式串接**：PatentOutputGate（关键词，既有行为不变）→ RuleDrivenGate（规则，新增）。二者输出合并到同一挂起/提示通道，UI 审批卡片不变。
**关键决策（D4 审批语义）**：block 命中在输出层=**强制挂起审批**（输出已生成无法拦截，沿用 rules/README 既有语义），与 review 同走 needsApproval；**不**因 block 而丢弃消息（消息照常入库，审批仅流程控制——对齐 PatentOutputGate 既有"不丢消息"原则）。

**验收**：构造含"编造案号"的专利结论输出 → 消息挂起 + UI 审批卡片可放行/拒绝；构造缺"三步法"要素的创造性分析 → 挂起或追加提示（视评审后 action）；规则集损坏 → 降级放行 + 告警日志。

### 3.4 T4：C 链——policy-bridge 工具拦截（可选，1–2 人日，二期）

**目标**：把评审通过的 **keyword_blocklist block 规则（≤5 条）** 编译注入 `PermissionRuntime`，在**工具调用前**拒绝（如 agent 试图用文件工具写含编造案号的文本）。

**改动**：

| 文件 | 改动 |
|---|---|
| `src/rule/runtime/policy-bridge.ts` | 补齐生产入口：`createPolicyRulesFromRuleSet`（复用 `rulesToPolicyDenyRules`）+ 规则集变更监听（对齐 PilotConfigStore watch 或按需重载） |
| `src/permission/decision/PermissionRuntime.ts` | 接入 policy deny 注入点（`source: "policy"` 优先级最高，对齐阶段一"guard 优先于一切规则"）；错误信息含规则 id/法律依据 |
| `src/cli/createLocalGateway.ts` | 装配：专利域角色会话注入 policy 规则（或按 WorkSpace 开关） |
| `tests/permission/` | 新增：写含编造案号文本的工具调用被拒（错误码 + 依据）；非专利域/开关关闭不拦截；规则集更新后重载生效 |

**范围边界（必须文档化）**：31 条 block 中仅 5 条 keyword_blocklist 可编译为工具拦截；26 条 structural_analysis 只作用于输出层（T3）。README 明确"工具拦截 = 5 条词表级规则，结构性规则走输出审批"。
**风险提示**：C 链影响面最大（工具调用前拒绝），建议**默认关闭、按 WorkSpace 开关启用**（如 `.sati/rules.yaml` 声明 `enforceToolBlock: true`），首期仅内置测试验证。

**验收**：5 条词表规则注入后，构造触发调用被拒且错误可读；开关关闭时行为不变（全量回归绿）。

### 3.5 T5：验证与文档收尾（0.5 人日）

- `rules/README.md`：更新"加载状态（2026-08）"章节 → "已激活（2026-08-16）"：三链接线状态表、patent-full scope 说明、activation-overrides 约定、C 链开关与边界；
- `docs/technical-debt-report.md`：中期项 #9 勾选完成（评审结论引用 README）；
- CHANGELOG 新增 v0.0.30（或当期版本）条目；
- 全量验证链：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`；事件面若无改动则 `check:event-matrix` 自动保持绿。

---

## 4. 验收标准（DoD）

### 4.1 规则资产
- [ ] 31 条 block 逐条评审结论落 `rules/README.md`（通过/降级/拒绝 + 理由 + 日期）；48 条 warn / 17 条 log 批量结论齐备
- [ ] 评审调整全部经 `activation-overrides.yaml` 表达，nuo-*.yaml 未被手改（`git diff` 可证）

### 4.2 A 链（rule_check）
- [ ] `rule_check(patent-full)` 规则数 = compliance(4) + 电学增强 + 评审通过集；违规输出含规则 id / severity / action / 法律依据 / 命中证据
- [ ] scope=patent 原行为不变（存量测试绿）；被拒规则在加载结果中不出现

### 4.3 B 链（输出门禁）
- [ ] block/review 命中 → 消息挂起（仍入库）+ 审批闭环可放行/拒绝（复用既有 approvalDecide）
- [ ] warn 命中 → 输出追加合规提示（含规则依据）
- [ ] 规则集加载失败 → 降级放行不崩（既有空集语义）

### 4.4 C 链（工具拦截，二期可选）
- [ ] ≤5 条 keyword_blocklist block 规则注入 PermissionRuntime；触发调用被拒且错误含规则依据
- [ ] 默认关闭，开关启用后生效；关闭时全量回归绿

### 4.5 质量门禁
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test` 全绿；事件矩阵 --check 绿

---

## 5. 风险与注意事项

1. **keyword_blocklist 误伤（最高风险）**：案号/专利号/判决号类正则关键词（X-REF-003、CON-COMP-0101、CON-102）极易在合法检索报告、判例引用中误命中。缓解：T1 用真实文本样本验证、`negationContext` 放行、必要时降级 warn；T2/T3 各有一道回归样本守住零误报。
2. **structural_analysis 强制审批误挂**：26 条 structural block 作为输出层强制审批，会显著提高审批卡片出现频率。缓解：T1 按 minConfidence 与要素可达性评审，高误挂者降级 review/warn；审批是流程控制（消息不丢），可接受度高于拦截。
3. **双门禁语义重叠**：关键词门禁（现有）与规则门禁（新增）都作用于输出。缓解：D3 两段式串接 + 分工文档化（风险词 vs 结构性合规），单测锁顺序。
4. **rule_check 输出噪音**：96 条规则全量评估的违规清单可能很长，挤占上下文。缓解：scope 分层（patent-full 显式选择）、后续可加 `domain`/`severity` 过滤参数（本期不做，记入遗留）。
5. **C 链影响面**：工具调用前拒绝是行为突变。缓解：默认关闭 + WorkSpace 开关 + 只覆盖 5 条词表规则 + 错误信息可操作。
6. **资产可再生成约束**：nuo-*.yaml 由脚本生成，手改会在上游变更重生成时丢失。缓解：D2 override 文件解耦评审结论，README 标注"禁止手改"。

---

## 6. 任务清单（可勾选）

### T1 评审（0.5–1 人日）
- [ ] T1.1 31 条 block 逐条评审（keyword_blocklist 5 条样本验证 / structural 26 条误挂评估）
- [ ] T1.2 48 条 warn / 17 条 log 批量评审（按 domain 分组）
- [ ] T1.3 `rules/README.md` 评审章节 + `activation-overrides.yaml` 起草

### T2 A 链（1–1.5 人日）
- [x] T2.1 `loadPatentFullRuleSet()`（显式 nuo 清单加载 + mergeRuleSets + overrides 字段级覆盖）
- [x] T2.2 rule_check 新增 scope=patent-full（scope=patent 不变）
- [x] T2.3 spec：规则数 / 降级生效 / 字段级合并 / 目录容错（7 用例）

> **T2 实施实证修正（2026-08-16）**：
> 1. **显式清单替代扫目录**：`rules/patent/` 还含 evidence-rules.yaml（证据引擎自有格式）、
>    synonyms.yaml（同义词资产）等非宪法规则文件，`loadRuleSetDir` 扫目录会误加载产生噪音
>    → `NUO_RULE_FILES` 显式列出 7 个文件；
> 2. **「拒绝不出现」改为「降级 log」**：评审无「拒绝」（不加载）档，13 条语义弱/过宽规则
>    降级为 log（仍加载、仅记录），保留其在 `rule_check` 里的可检性——避免丢失信息；
> 3. **字段级覆盖而非整条覆盖**：`mergeRuleSets` 是整条覆盖（后覆盖前），override 若只写
>    action 会清空 name/check 等字段 → 新增 `applyRuleOverrides`（`RuleLoader.ts`）按 id 浅合并，
>    override 文件得以用轻量 `overrides: { id: { action, reason } }` 格式；
> 4. **patent-full 不含 electrical-section-h**：电学增强保持独立 scope（patent-electrical），
>    patent-full = compliance + nuo（经 override 降级），语义更清晰。
> 
> 验证：`loadPatentFullRuleSet` 规则数 100（compliance 4 + nuo 96），action 分布
> warn 66 / review 2 / block 2 / log 30；typecheck/lint/format:check 全绿；
> 新增 7 用例 + rule 域 91 + ruleCheck 工具 13 全绿。

### T3 B 链（2–3 人日）
- [x] T3.1 RuleDrivenGate 适配层（RuleOutputGate → PatentOutputGate 同构接口）
- [x] T3.2 两段式串接（关键词 → 规则）+ gateway 装配
- [x] T3.3 spec：block/review 挂起可放行、warn 追加、加载失败降级（6 用例）

> **T3 实施实证修正（2026-08-16）**：
> 1. **适配层改为「PatentOutputGate 内部集成」而非独立 RuleDrivenGate**：TurnRunner 依赖
>    具体 `PatentOutputGate` 类型（非接口），在类内新增可选 `ruleGate` 选项（两段式串接），
>    TurnRunner 接线零改动、审批流程（flushPending/approve/reject）全复用；
> 2. **structural 规则海量噪音（关键教训）**：实测发现 structural_analysis「缺失即违规」对
>    任意 assistant 输出会命中几十条（普通文本天然「缺失」大量期望要素），即使降级 warn
>    也会让每条输出追加 80+ 行提示——**structural 规则只适用 rule_check 显式自检（A 链），
>    绝不进输出门禁（B 链）**。新增 `selectGateRules()`：B 链只保留「出现即违规」的
>    keyword_blocklist 规则，并排除 compliance 的 PAT-*（已由关键词门禁镜像处理）——
>    最终 B 链 = nuo 9 条 keyword_blocklist（2 block / 1 review / 5 warn / 1 log）；
> 3. **T1 评审的「structural block → warn 完整性提醒」结论修正**：该降级对 rule_check 仍
>    成立（显式自检时「缺要素」提示有价值），但不构成 B 链接入理由——warn 提示的价值
>    仅在「agent 主动查产物」场景，输出门禁自动评估不可用。
> 
> 验证：门禁子集 9 条；block 命中挂起 + ruleViolations 带规则 id；warn 单条提示无噪音；
> 干净文本零污染；patent 域 355 + rule 域 104 全绿；typecheck/format:check 通过。

### T4 C 链（可选二期，1–2 人日）
- [ ] T4.1 policy-bridge 生产入口 + 规则集变更监听
- [ ] T4.2 PermissionRuntime policy deny 注入 + 开关（默认关）
- [ ] T4.3 spec：拦截 / 开关关闭不拦截 / 重载生效

### T5 收尾（0.5 人日）
- [x] T5.1 rules/README.md 加载状态更新 + technical-debt-report #9 勾选
- [x] T5.2 CHANGELOG + 全量验证链绿

> **T5 收尾回归修复（2026-08-16）**：全量测试发现 `llm-replay-real.spec.ts`
> 真实模型 fixture 重放失败（"never drove 1 recorded stream(s)")——根因是请求键
> （`replayRequestKey`）包含**工具 inputSchema**，而 T2 改了 `rule_check` 工具的
> inputSchema（scope description 加 patent-full）→ schema 变化 → 请求键不匹配。
> 修复：回退 inputSchema 的 scope description 改动（顶层 description 保留 patent-full，
> 不进请求键）；scope 逻辑（resolve 分支 + AVAILABLE_SCOPES）不受影响。教训：任何
> 内置工具的 inputSchema 改动都会破坏真实模型 fixture，需重录 fixture 或保持 schema 不变。

---

## 附录 A：31 条 `action: block` 规则清单（评审对象）

| 文件 | id | 名称 | domain | check 类型 |
|---|---|---|---|---|
| nuo-compliance-enforceable | CON-COMP-0101 | 禁止编造占位专利号 | patent_general | keyword_blocklist |
| nuo-compliance-enforceable | CON-COMP-0104 | 禁止编造审查指南内容 | patent_general | structural_analysis |
| nuo-patent-core-rules | X-REF-003 | 交叉—禁止编造案例案号 | patent_general | keyword_blocklist |
| nuo-patent-examination-rules | EX-CLM-001 | 权利要求—清楚性要求 | patent_claims | keyword_blocklist |
| nuo-patent-examination-rules | EX-CLM-002 | 权利要求—以说明书为依据 | patent_claims | structural_analysis |
| nuo-patent-examination-rules | EX-CMP-001 | 计算机程序—技术方案判断 | patent_general | structural_analysis |
| nuo-patent-examination-rules | EX-DIS-002 | 说明书—发明内容三要素 | patent_disclosure | structural_analysis |
| nuo-patent-examination-rules | EX-INV-001 | 创造性—三步法框架完整性 | patent_inventiveness | structural_analysis |
| nuo-patent-examination-rules | EX-PRC-001 | 审查程序—修改不得超范围 | patent_procedure | structural_analysis |
| nuo-patent-examination-rules | EX-SEL-001 | 不授权—智力活动的规则和方法 | patent_general | structural_analysis |
| nuo-patent-examination-rules | EX-SEL-002 | 不授权—疾病诊断和治疗方法 | patent_general | structural_analysis |
| nuo-patent-examination-rules | EX-SEL-003 | 不授权—计算机程序与商业方法排除 | patent_general | structural_analysis |
| nuo-patent-examination-rules | EX-SEL-004 | 不授权—违反法律与公序良俗 | patent_general | keyword_blocklist |
| nuo-patent-ipc-rules | IPC-B60-INV-003 | 车辆领域—公知常识的举证责任分配 | patent_inventiveness | structural_analysis |
| nuo-patent-ipc-rules | IPC-GEN-INV-001 | 通用—三步法是创造性判断的唯一框架 | patent_inventiveness | structural_analysis |
| nuo-patent-judgment-rules | JD-DEF-003 | 抗辩实务—现有技术证据必须完整公开全部特征 | patent_infringement | structural_analysis |
| nuo-patent-judgment-rules | JD-DMG-002 | 损害赔偿—惩罚性赔偿的双重要件 | patent_infringement | structural_analysis |
| nuo-patent-judgment-rules | JD-DMG-003 | 损害赔偿—惩罚性赔偿的重复侵权认定 | patent_infringement | structural_analysis |
| nuo-patent-judgment-rules | JD-INF-003 | 侵权判定—发明点特征等同从严把握 | patent_infringement | structural_analysis |
| nuo-patent-judgment-rules | JD-PRC-002 | 程序规则—举证妨碍的认定与后果 | patent_procedure | structural_analysis |
| nuo-patent-law | CON-101 | 发明定义-技术方案三要素 | patent_general | structural_analysis |
| nuo-patent-law | CON-102 | 禁止编造对比文件 | （无） | keyword_blocklist |
| nuo-patent-law | CON-201 | 充分公开-能够实现 | patent_disclosure | structural_analysis |
| nuo-patent-law | CON-301 | 权利要求清楚 | patent_claims | structural_analysis |
| nuo-patent-law | CON-302 | 权利要求以说明书为依据 | patent_claims | structural_analysis |
| nuo-patent-law | CON-401 | 创造性非显而易见性判断 | patent_inventiveness | structural_analysis |
| nuo-patent-law | CON-501 | 修改不超范围 | patent_procedure | structural_analysis |
| nuo-patent-law | CON-502 | 权利要求修改不得扩大保护范围 | patent_procedure | structural_analysis |
| nuo-patent-practice-rules | PR-CLM-001 | 权利要求撰写—独立权利要求布局 | patent_claims | structural_analysis |
| nuo-patent-practice-rules | PR-OA-001 | OA答复—逐点回应所有审查意见 | patent_oa_response | structural_analysis |
| nuo-patent-practice-rules | PR-OA-002 | OA答复—修改权利要求时的超范围检查 | patent_oa_response | structural_analysis |

（keyword_blocklist 5 条：CON-COMP-0101 / X-REF-003 / EX-CLM-001 / EX-SEL-004 / CON-102；structural_analysis 26 条：其余全部。domain 分布：patent_general 9、patent_claims 5、patent_procedure 4、patent_inventiveness 4、patent_infringement 4、patent_disclosure 2、patent_oa_response 2、无 domain 1。）
