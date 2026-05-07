# Design Doc — ticket `<ticket_id>`

> 由 turnkey-design skill 生成。junior 选 chosen option 后写回 runlog.json。

## 0. Context (from clarify)

- ticket 一句话：`<…>`
- 改动范围（文件 / 模块）：
- consumer / owner（context-blindness 已识别）：
- success 判定（来自 Q5）：
- 是否需要 senior async review：☐ yes ☐ no（agent 提议） / 最终：☐ yes ☐ no（junior 决定）

## 1. 不变量 (invariants — 这些不能动)

- I-1: <…>
- I-2: <…>
- I-3: <…>

## 2. 候选方案

### Option A: <短名字>

- 一句话：
- 改动总览：file 1 / file 2 / file 3
- 估时：~ X h
- agent 信心：high / medium / low
- 优点：
  - …
- 缺点 / 风险：
  - …
- 适合 junior 的程度（基于 Q-onboard 的健康度）：高 / 中 / 低

### Option B: <短名字>
（同上结构）

### Option C: <短名字>（如果有）
（同上结构）

## 3. 推荐 + 理由

agent 推荐：Option `<X>`
理由（≤ 5 行）：

junior 选择：☐ A ☐ B ☐ C ☐ 我有第 4 种想法 → ……

## 4. chosen-option 的拆解

把 chosen option 分成 ≤ 8 个 micro-step，每步 ≤ 80 LoC、可独立 commit、可独立测：

- step 1: <…>
- step 2: <…>
- …

> 这个列表会被 turnkey-develop / turnkey-tdd 直接消费。

## 5. trust-blindness 高风险点

哪些第三方 API、库、约定可能 hallucinate？develop 阶段必须做真实校验：

- risk 1: 调用 `<lib.fn>`，agent 信心 = medium → develop 阶段跑真实 demo 校验
- …

## 6. 已知 risk 与 mitigation

- risk: <…> → mitigation: <…> → fallback: <…>

## 7. 影响与依赖

- 上游依赖：
- 下游 consumer：
- 数据迁移 / schema 变更：☐ none ☐ <描述>
- feature flag / rollout 策略（如适用）：

## 8. open questions

任何 junior 没拍 / agent 没把握的问题：
- OQ-1: <…> （必须在 spec / develop 之前关掉的标 ★）
