# Sati 宪法规则资产（src/rule/）

宪法规则引擎以**声明式 YAML 规则**描述"AI 在生成/执行时必须遵守的约束"，
由 `src/rule/` 模块加载并对文本做确定性检查（无 LLM 调用）。
设计引入自 BCIP `codex-patent-constitutional`。

## 目录结构

```
rules/
  base/                    基础规则包（全领域通用：创造性方法论 + 合规 + 引用核验）
  domains/<name>/          领域规则包（mechanical / medical / chemical / software）
  pack.schema.json         包清单（pack.yaml）的 JSON Schema
  patent/compliance.yaml   专利域合规规则（内置资产，随包发布，rule_check scope=patent 用）
  patent/nuo-*.yaml        自 XiaoNuo Agent 移植的确定性规则（7 个文件 96 条，
                           由 scripts/port-nuo-rules.ts 转换生成，可重新生成）
  README.md                本规范
```

### 移植规则说明（nuo-*）

`nuo-*.yaml` 由 `scripts/port-nuo-rules.ts` 从 XiaoNuo Agent 的 `data/rules/` 转换而来，
采用**双轨策略**：

> **加载状态（2026-08-16 已激活）**：nuo-*.yaml（7 个文件 96 条）**已接线激活**——
> 评审结论见文末「nuo 规则激活评审（2026-08-16）」章节，评审调整落
> `rules/patent/activation-overrides.yaml`（轻量补丁，加载时字段级覆盖 action）。
> 接线两链（第三链 policy-bridge 工具拦截为可选二期，默认未接线）：
> - **A 链（agent 显式自检）**：`rule_check` scope=patent-full = compliance + nuo 全量
>   （100 条，经 override 降级后 2 block / 2 review / 66 warn / 30 log）；
> - **B 链（输出门禁）**：`RuleOutputGate` + `selectGateRules()` 只接入「出现即违规」的
>   keyword_blocklist 规则（nuo 9 条，排除 compliance PAT-* 与 structural_analysis）——
>   structural「缺失即违规」对任意输出海量误报，仅适用 rule_check 显式自检。
> 详见 `docs/nuo-rules-activation-plan.md`。激活前这些规则零加载，
> `rule_check` 仅加载 `compliance.yaml`。

- **可执行转换**：`check.type` 属于本引擎支持的 4 种确定性检查 → 转换后由 RuleLoader 加载生效。
  关键语义映射（与 XiaoNuo agent-core 引擎源码核对）：
  - `keyword_blocklist`（命中即违规）→ 同义直转
  - `pattern_analysis`（XiaoNuo 语义为"期望模式"，任一命中即通过）→ 转 `structural_analysis` 单 element
  - `structural_analysis`（requiresAll 全部命中通过）→ 同义直转
- **原样资产**：全部源规则文件（含 LLM 评估型 `patent_novelty` 等约 213 条，以及 `message`/
  `fix_suggestion`/`assessment` 等指导字段）原样保存于 `assets/patent-rules/`，
  不经过 RuleLoader，供 SKILL.md / worker 作为参考知识使用。

新增规则前先用 `pnpm tsx scripts/port-nuo-rules.ts --help` 了解转换脚本行为。

## 规则格式

每个 YAML 文件是一个 `RuleSet`，`rules` 字段支持两种形态：

```yaml
# 形态一：数组
rules:
  - id: CON-101
    name: 规则名
    ...
```

```yaml
# 形态二：映射（BCIP 风格，内部名 → 规则）
rules:
  internal_key:
    id: CON-101
    name: 规则名
    ...
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 唯一规则编号（如 `CON-101`），重复 id 报错 |
| `name` | ✅ | 规则名（中文） |
| `description` | | 规则说明 |
| `domain` | | 适用领域（`mechanical` / `medical` 等）；`evaluateText(text, ruleSet, synonyms, { domain })` 可过滤异领域规则（未声明者始终评估） |
| `phase` | | 生命周期阶段（自由文本，如 `申请前` / `输出`） |
| `severity` | ✅ | `critical` / `major` / `minor` |
| `action` | | `block` / `warn` / `review` / `log`（缺省 `warn`） |
| `legalBasis` | | 法律/规范依据原文（展示给用户与模型） |
| `check` | ✅ | 检查定义（见下） |

### action 语义

> **接线状态（2026-08）**：`block` 的**工具拦截**目前**未接入生产路径**——
> `policy-bridge.ts` 的 `rulesToPolicyDenyRules` 仅被测试调用，无生产代码把
> block 规则编译注入 `PermissionRuntime`。因此 `action: block` 当前**只作用于
> 输出层**（强制挂起审批），不会在工具调用前拒绝。
> **HITL 审批闭环（2026-08-11 落地）**：输出层挂起审批已打通放行链路——
> `GatewayApprovalBus` 注册挂起条目 + `approval_pending` 事件 → UI 审批卡片 →
> `approvalDecide` 命令 → `approvePendingOutput` / `rejectPendingOutput` 完成流控。
> 依赖"block 阻止工具调用"前请先完成 policy-bridge 接线。

| action | 输出门禁（RuleOutputGate） | 工具拦截（policy-bridge） |
|--------|---------------------------|--------------------------|
| `block` | 强制挂起审批（输出已生成无法拦截） | ⚠️ 未接线：仅测试调用，生产不注入 deny 规则 |
| `review` | 挂起人工审批 | 不参与（留给输出层） |
| `warn` | 追加合规提示 | 不参与 |
| `log` | 仅记录 | 不参与 |

### check 检查类型

| 类型 | 字段 | 语义 |
|------|------|------|
| `keyword_blocklist` | `keywords`（`a\|b\|c` OR 组）、`negationContext`（否定语境放行）、`severityIfFound` | 关键词命中即违规 |
| `pattern_analysis` | `patterns`（正则）、`minMatches`（至少命中 N 次） | 正则命中次数 ≥ minMatches 即违规 |
| `structural_analysis` | `requiresAll`（element + patterns）、`minConfidence` | 命中要素占比低于阈值即违规 |
| `citation_analysis` | `statutes`（法条名 → `{ max }`） | 引用条号超出有效范围即违规（R1） |

## 加载与覆盖

- 内置资产定位：`SATI_RULES_DIR`（规则根，布局镜像仓库 `rules/`，其下 `patent/`）→ `./rules/patent/` → 仓库根 `rules/patent/`
- `mergeRuleSets` 按 id 覆盖（后出现者胜），可用于分层规则
- 单文件解析失败不阻塞目录加载（跳过并告警，见 `loadRuleSetDir`）

## 分层规则包（Rule Pack）

`src/rule/runtime/rule-pack.ts` 提供三层合并式加载：**base（通用）→ domains（清单声明顺序）→ overrides（项目私有）**，
后加载按 id 覆盖并记审计 warning。通过 `rule_check` 工具 `scope=pack` 消费。

### 包目录与清单

每个包目录含 `pack.yaml` 清单（schema 见 `rules/pack.schema.json`，运行时校验由
`validatePackManifest` 实现，两者须保持同步）：

```yaml
id: sati-rules-domain-mechanical   # 须形如 sati-rules-<slug>
version: 0.1.0                     # semver
domain: mechanical                 # 领域包必填；base 包不填
description: 包用途说明
```

内置包定位候选（从具体到通用）：`SATI_RULES_DIR/<name>` → `cwd/rules/<name>` →
`cwd/rules/domains/<name>` → WorkSpace 根同名目录；也支持绝对路径直接引用。

### 项目清单 `.sati/rules.yaml`

WorkSpace 根（或 cwd）的 `.sati/rules.yaml` 声明项目装配：

```yaml
base: base                  # 内置包名；或绝对路径（外部包 v1 用路径引用）
domains: [mechanical]       # 领域包，可多个，按声明顺序加载
overrides: ./local-rules/   # 可选，相对清单所在目录；项目私有规则，不强制 pack.yaml
```

**无清单时回退默认**：仅加载 `rules/base`（零配置可用）。坏包不阻塞：单层加载失败记 warning 继续。

> **接线状态（2026-08）**：`scope=pack` 仅接入 `rule_check` 工具（缓存按清单 mtime 失效）；
> 输出门禁（RuleOutputGate）仍只用 `compliance.yaml`，未消费规则包。
> `evaluateText` 的 `domain` 过滤参数 v1 由调用方显式传入；rule_check 暂不传（内容设计兜底），
> 为 v2 IPC 领域自动识别铺路。
> 注：`patent_inventiveness` 域的确定性规则（`INVENTIVENESS-*`，含原子化问题四检验）
> 在 `src/patent/checker/`（TS 代码形态）经 `defaultPatentRules()` 注册，随 Graph/收口双链路生效。

### 入库准入标准

- **base 层**：仅收跨领域方法论级规则（不涉特定技术领域的实体判断）；宁缺毋滥。
- **领域层**：样板规则入库前须用正/反例标定 minConfidence，误报由显式清单准入与 domain 过滤兜底。
- 判例要旨/案例叙述属知识资产（`assets/patent-rules/`），不进规则文件。

## 消费方

| 消费方 | 位置 | 说明 |
|--------|------|------|
| 输出门禁 | `src/rule/runtime/output-gate.ts` | `RuleOutputGate`：warn 追加提示 / review+block 挂起审批 |
| 工具拦截 | `src/rule/runtime/policy-bridge.ts` | block 规则 → policy deny 规则（`text:` 前缀匹配工具输入） |
| agent 显式调用 | `src/tool/builtin/ruleCheck.ts` | `rule_check` 工具：检查任意文本并返回违规清单；scope 支持 `patent` / `patent-electrical` / `pack` |

## 新增规则示例

```yaml
rules:
  patent_citation_range:
    id: PAT-CITE-001
    name: 法条引用范围核验
    domain: patent
    phase: 输出
    severity: major
    action: warn
    legalBasis: 引用核验 R1：条号不得超出有效范围
    check:
      type: citation_analysis
      statutes:
        专利法:
          max: 78
        专利法实施细则:
          max: 126
```

---

## nuo 规则激活评审（2026-08-16）

> 专项：`docs/nuo-rules-activation-plan.md`。评审目标：把 96 条沉睡规则激活前，先处置
> `action: block` 的 31 条（拦截面最大），并对 48 warn / 17 log 批量复核。评审结论的
> 机器可读权威 = `rules/patent/activation-overrides.yaml`（仅列被降级规则，未列保持原 action）。

### 评审原则

nuo 规则的 `check` 分两类语义，处置方式不同：

| check 类型 | 语义 | 与输出门禁匹配度 |
|---|---|---|
| `keyword_blocklist` | **出现即违规**（禁止性） | ✅ 匹配「禁止性合规」，可保留 block（前提：关键词无误伤） |
| `structural_analysis` | **缺失即违规**（期望模式 = 完整性检查） | ⚠️ 错配：完整性缺失 ≠ 合规违规，不应强制挂起审批；降级 warn（完整性提醒）或 log（仅 rule_check 可检） |

关键结论：**26 条 structural block 全部降级**——它们检查的是「产物应包含某要素」（如说明书三要素、三步法框架），缺失只是「不完整」而非「违规」，作为 block（强制挂起审批）会高频误挂正常中间输出；降级为 warn 后恰好承载「完整性提醒」的真实价值。

### 31 条 block 逐条评审结论

**处置统计**：保留 block 2 / 降级 review 1 / 降级 warn 15 / 降级 log 13。

#### 保留 block（2 条，出现即违规且无误伤，样本验证通过）

| id | 名称 | 样本验证 |
|---|---|---|
| CON-COMP-0101 | 禁止编造占位专利号 | 真实号 `CN201910123456A` 放行；占位符 `CNXXXXXX` 命中 |
| X-REF-003 | 交叉—禁止编造案例案号 | 真实案号 `（2020）最高法知民终123号` 放行；占位 `（202X）…` 命中（注：全角括号变体需增强，见「遗留」） |

#### 降级 review（1 条，编造风险保留人工关注，但词有正常合规用法）

| id | 名称 | 理由 |
|---|---|---|
| CON-102 | 禁止编造对比文件 | 「编造/虚构/捏造」在合规自我表述中高频出现（`不存在虚构的技术效果`），block 误伤严重 |

#### 降级 warn（15 条，完整性期望 → 完整性提醒）

| id | 名称 | 理由 |
|---|---|---|
| EX-CLM-001 | 权利要求—清楚性要求 | 误伤「讨论清楚性规则」的合规建议（`应避免使用大约/左右`）；keyword_blocklist |
| EX-SEL-004 | 不授权—违反法律与公序良俗 | 误伤「防窃听装置」合法主题；keyword_blocklist（后续补 negationContext） |
| EX-CLM-002 | 权利要求—以说明书为依据 | 完整性提醒 |
| EX-CMP-001 | 计算机程序—技术方案判断 | 完整性提醒（三要素） |
| EX-DIS-002 | 说明书—发明内容三要素 | 完整性提醒（技术问题/方案/效果） |
| EX-INV-001 | 创造性—三步法框架完整性 | 完整性提醒（四要素） |
| EX-PRC-001 | 审查程序—修改不得超范围 | OA 高频场景提醒 |
| CON-101 | 发明定义-技术方案三要素 | 完整性提醒（三要素） |
| CON-201 | 充分公开-能够实现 | 完整性提醒 |
| CON-302 | 权利要求以说明书为依据 | 完整性提醒 |
| CON-401 | 创造性非显而易见性判断 | 创造性核心词提醒 |
| CON-501 | 修改不超范围 | OA 高频场景提醒 |
| CON-502 | 权利要求修改不得扩大保护范围 | OA 高频场景提醒 |
| PR-CLM-001 | 权利要求撰写—独立权利要求布局 | 撰写完整性提醒（一种+其特征在于） |
| PR-OA-001 | OA答复—逐点回应所有审查意见 | OA 完整性提醒 |

#### 降级 log（13 条，语义弱 / pattern 过宽 / 领域窄 / 重复）

| id | 名称 | 理由 |
|---|---|---|
| CON-COMP-0104 | 禁止编造审查指南内容 | 单 element pattern=「审查指南」，缺失即违规语义错乱 |
| EX-SEL-001 | 智力活动的规则和方法 | pattern 含「组织」等宽泛词 |
| EX-SEL-002 | 疾病诊断和治疗方法 | pattern 含「诊断/治疗」宽泛词 |
| EX-SEL-003 | 计算机程序与商业方法排除 | pattern 含「算法/经营」宽泛词 |
| IPC-B60-INV-003 | 车辆领域—公知常识举证 | 领域过窄（IPC 单一场景） |
| IPC-GEN-INV-001 | 通用—三步法唯一框架 | 与 EX-INV-001 重复 |
| JD-DEF-003 | 现有技术证据完整公开 | 判例领域 pattern 宽泛 |
| JD-DMG-002 | 惩罚性赔偿双重要件 | 判例领域非主场景 |
| JD-DMG-003 | 惩罚性赔偿重复侵权 | 判例领域 pattern 宽泛 |
| JD-INF-003 | 发明点特征等同从严 | 判例领域 pattern 宽泛 |
| JD-PRC-002 | 举证妨碍认定与后果 | 判例领域 pattern 宽泛 |
| CON-301 | 权利要求清楚 | pattern 含「清楚/限定」宽泛词 |
| PR-OA-002 | OA修改权利要求超范围检查 | 与 CON-501/502 重复 |

### 48 warn / 17 log 批量评审结论

**全量按原 action 接入**（warn 追加提示、log 仅记录，均不阻塞，误伤代价 = 提示噪音，可接受）。

4 条 keyword_blocklist 复核（出现即违规，误伤面稍大）：

| id | 名称 | action | 结论 |
|---|---|---|---|
| CON-COMP-0105 | 禁止商业宣传用语 | warn | 词表合理（世界领先/行业首创等广告语），提示可接受 ✅ |
| EX-INV-007 | 创造性—避免事后诸葛亮 | warn | 元讨论词，正常技术分析少用，可接受；与 IPC-GEN-INV-002 重复 → 合并记入遗留 ✅ |
| IPC-GEN-INV-002 | 三步法不能与事后诸葛亮混淆 | warn | 与 EX-INV-007 重复 ✅ |
| X-STR-002 | 避免模糊措辞 | log | 「大概/也许/不确定」过宽，**保持 log 不升级**（升级 warn 会大量噪音）✅ |

其余 45 structural warn + 16 structural log：默认全量接入（完整性提醒/记录不阻塞）。

### 样本验证记录（keyword_blocklist 5 条，2026-08-16 实测）

| 样本 | CON-COMP-0101 | X-REF-003 | EX-CLM-001 | EX-SEL-004 | CON-102 |
|---|---|---|---|---|---|
| 真实专利号 `CN201910123456A` | ✅放行 | ✅放行 | ✅放行 | ✅放行 | ✅放行 |
| 真实案号 `（2020）最高法知民终123号` | ✅放行 | ✅放行 | ✅放行 | ✅放行 | ✅放行 |
| 合规建议 `应避免使用大约/左右` | ✅放行 | ✅放行 | ❌命中 | ✅放行 | ✅放行 |
| 防窃听装置（合法主题） | ✅放行 | ✅放行 | ✅放行 | ❌命中 | ✅放行 |
| `不存在虚构的技术效果` | ✅放行 | ✅放行 | ✅放行 | ✅放行 | ❌命中 |
| `不得编造对比文件`（自我提醒） | ✅放行 | ✅放行 | ✅放行 | ✅放行 | ❌命中 |
| 占位符 `CNXXXXXX`（真违规） | ❌命中 | ✅放行 | — | — | — |

（❌命中 = 误伤/命中证据；✅放行 = 无误伤。命中方向：CON-COMP-0101/X-REF-003 的 ❌ 是「正确命中真违规」，其余 ❌ 是「误伤合法文本」→ 已降级。）

### 遗留（接线时一并处理）

1. **X-REF-003 全角括号漏报**：规则用半角 `(202X)`，中文文本常用全角 `（202X）` → 增强 pattern 同时覆盖全/半角；
2. **EX-SEL-004 negationContext**：补「防/反/抑制/检测」放行语境，避免误伤合法安防专利主题；
3. **EX-INV-007 / IPC-GEN-INV-002 重复**：两条内容同（避免事后诸葛亮），接线时可合并为一条（跨域共享）；
4. **EX-INV-001 / IPC-GEN-INV-001 重复**：均检查三步法框架，评审已保留前者 warn、后者 log，无遗留动作。
