# Sati 宪法规则资产（src/rule/）

宪法规则引擎以**声明式 YAML 规则**描述"AI 在生成/执行时必须遵守的约束"，
由 `src/rule/` 模块加载并对文本做确定性检查（无 LLM 调用）。
设计引入自 BCIP `codex-patent-constitutional`。

## 目录结构

```
rules/
  patent/compliance.yaml   专利域合规规则（内置资产，随包发布）
  patent/nuo-*.yaml        自 XiaoNuo Agent 移植的确定性规则（96 条，
                           由 scripts/port-nuo-rules.ts 转换生成，可重新生成）
  README.md                本规范
```

### 移植规则说明（nuo-*）

`nuo-*.yaml` 由 `scripts/port-nuo-rules.ts` 从 XiaoNuo Agent 的 `data/rules/` 转换而来，
采用**双轨策略**：

> **加载状态（2026-08）**：nuo-*.yaml（8 个文件约 96 条）**当前未加载**——
> `loadRuleSetDir(rules/patent)` 在生产代码零调用，`rule_check` 仅加载
> `compliance.yaml`。这些规则属"沉睡资产"：激活前请先评审其中 `action: block`
> 的 keyword_blocklist（如 X-REF-003 案例案号模式），避免接通后意外拦截。

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
| `domain` | | 适用领域（`patent` 等），用于按域过滤 |
| `phase` | | 生命周期阶段（自由文本，如 `申请前` / `输出`） |
| `severity` | ✅ | `critical` / `major` / `minor` |
| `action` | | `block` / `warn` / `review` / `log`（缺省 `warn`） |
| `legalBasis` | | 法律/规范依据原文（展示给用户与模型） |
| `check` | ✅ | 检查定义（见下） |

### action 语义

> **接线状态（2026-08）**：`block` 的**工具拦截**目前**未接入生产路径**——
> `policy-bridge.ts` 的 `rulesToPolicyDenyRules` 仅被测试调用，无生产代码把
> block 规则编译注入 `PermissionRuntime`。因此 `action: block` 当前**只作用于
> 输出层**（强制挂起审批），不会在工具调用前拒绝。依赖"block 阻止工具调用"
> 前请先完成 policy-bridge 接线。

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

- 内置资产定位：`SATI_RULES_DIR` 环境变量 → `./rules/patent/` → 仓库根 `rules/patent/`
- `mergeRuleSets` 按 id 覆盖（后出现者胜），可用于分层规则
- 单文件解析失败不阻塞目录加载（跳过并告警，见 `loadRuleSetDir`）

## 消费方

| 消费方 | 位置 | 说明 |
|--------|------|------|
| 输出门禁 | `src/rule/runtime/output-gate.ts` | `RuleOutputGate`：warn 追加提示 / review+block 挂起审批 |
| 工具拦截 | `src/rule/runtime/policy-bridge.ts` | block 规则 → policy deny 规则（`text:` 前缀匹配工具输入） |
| agent 显式调用 | `src/tool/builtin/ruleCheck.ts` | `rule_check` 工具：检查任意文本并返回违规清单 |

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
