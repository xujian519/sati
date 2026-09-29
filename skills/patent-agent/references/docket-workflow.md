# 案卷迭代参考（docket-workflow）

> 仅在用 `patent_docket` 做多轮返工时按需读取。状态机语义与工具契约见
> `src/patent/docket/state.ts`、`src/tool/builtin/patentDocketTool.ts`；决策背景见
> `docs/notes/implemented/2026-09-29-patent-docket-state-machine.md`。

## 缺口问题清单格式

`set_gaps` / `create.gaps` 每条缺口：

```jsonc
{ "id": "exp-data",          // 案卷内唯一，^[A-Za-z0-9][A-Za-z0-9._-]*$
  "question": "弱光场景下的采样频率调整缺少实测数据支撑",
  "source": "交底书" }         // 来源：检索缺证据 / 交底缺参数 / 审查意见质疑……
```

`record_revision` 的 `answered` 填缺口 `id` **或**问题原文（二者皆可匹配）。同一 id 再次出现在 `set_gaps` 视为"缺口复现"，会被重开（`resolved` 回退）。

## 修订轮次模板

```
第 N 轮（round=N/maxRounds）
├─ triage 派工：revise(N) + 未决缺口清单
├─ flexible_plan：rollback 到问题阶段 → run → 逐阶段 confirm
├─ 回答缺口：record_revision(answered=[...], artifacts=[{name,path}])
│    └─ 阶段产物另存 revisions/round-N/（旧稿不动）
└─ 未决缺口 >0 且 round==maxRounds → escalate_human（转人工，停止自动修订）
```

定稿：`finalize` 要求未决缺口清零且 round≥1；否则 fail-closed。

## 示例案件（三类）

### A. 发明专利（多轮补实验数据）

- 立案：`create(caseId="inv-sensor-001", caseType="drafting", maxRounds=3)`
- 缺口：`set_gaps` 登记 `exp-strong`（强日照参数未实测）、`exp-weak`（弱光照未实测）、`claim-support`（"能量预测算法"首次出现无定义）
- 第 1 轮：发明人补 `exp-strong` → `record_revision(answered=["exp-strong"], artifacts=[{name:"spec-实施方式", path:"drafts/spec-v1.md"}])`
- 第 2 轮：补 `exp-weak` + 定义术语 → `record_revision(answered=["exp-weak","claim-support"], ...)`
- 缺口清零 → `finalize`

### B. 实用新型（结构改进，一轮即收敛）

- 立案：`create(caseId="um-drive-002", caseType="drafting", maxRounds=2)`
- 缺口：`gear-position`（变速箱档位相对位置未在附图标记）
- 第 1 轮：补附图标记并 `rollback` 附图说明阶段重跑 → `record_revision(answered=["gear-position"], artifacts=[{name:"附图说明", path:"drafts/fig-desc.md"}])`
- `finalize`

### C. 外观设计（视图口径缺口，超限升级）

- 立案：`create(caseId="des-lamp-003", caseType="drafting", maxRounds=2)`
- 缺口：`six-views`（缺立体图/后视图）、`surface-material`（表面材质是否主张不明）
- 第 1 轮：补六面视图 → 仍缺 `surface-material`，发明人无法确认
- 第 2 轮：`record_revision` 后 `surface-material` 仍未决且 `round==maxRounds`
- `triage → escalate_human`：停止自动修订，转代理人就"材质是否写入简要说明"做专业判断（不得替发明人补造）

## 边界

- 一次性分析（单轮检索/创造性判断）不建案卷，直接走对应技能。
- 案卷只管轮次与缺口闭环，阶段执行仍归 `flexible_plan`；两者按 caseId 关联（`linkedPlanCaseId`）。
