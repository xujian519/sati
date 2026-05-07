# Junior-Answerable Questions — v0 (B-11 实现)

> **设计原则**：每个问题都是 junior 通过 IDE / git / grep / 文件浏览**就能回答**的。
> 任何要求 junior "判断业务价值 / 谈策略 / 给 OKR" 的问题**不出现**在这里——那是 v1 PM 问卷的失败模式（参见 `assumptions/baseline-v2.md` B-11）。
>
> **agent 使用规则**：
> 1. agent **先**用 codebase 工具尝试自答每一题
> 2. 自答可信度 ≥ high → 跳过，记入 §agent-self-answered
> 3. 自答可信度 = medium → 拿"我的猜测 + evidence"找 junior 二次确认（不重新问）
> 4. 自答可信度 = low / 不能回答 → 才问 junior，且**附带**怎么找答案的具体提示

---

## Q1. 这个 ticket 改的是哪个文件 / 模块？

- agent 可自答：grep ticket 关键词、看 ticket 提到的文件路径
- 给 junior 兜底：
  - "ticket 文本里出现了 `<word>`，仓库里 `git grep <word>` 命中 N 个文件，最有可能是 [X, Y]，对吗？"

---

## Q2. 现在这个 feature/页面/接口入口在哪？跑一遍 happy path 看看

- agent 可自答：grep 主路由 / API endpoint 注册、找 `routes.ts` / `urls.py` 等
- 给 junior 兜底：
  - "我猜入口是 `<file>:<line>`。请你**真的跑一遍**应用，从 UI 或 curl 走到这个入口，告诉我看到了什么"
  - **重要**：让 junior 真的跑，因为 trust-blindness 的常见来源是"agent 猜入口对了 80%、剩下 20% junior 没去验证"

---

## Q3. 这个改动有没有"给谁用"的明确 consumer？

- agent 可自答：grep import / git log 找谁最近 touch 同一文件
- 给 junior 兜底：
  - "我看到 `<X>` import 这个 module，意味着改动会影响 X。你知道 X 是谁在维护吗？"
  - "如果改了接口 signature，X 那边谁负责跟你 sync？"
- ⚠️ 这是 context-blindness 的高发问题——junior 通常不知道 consumer 是谁

---

## Q4. 有没有"应该不动"的部分？

- agent 可自答：看 codeowners / 相邻目录 README / 最近 git log 提到 "do not touch / freeze / locked" 的文件
- 给 junior 兜底：
  - "目录 `<X>` 里有 CODEOWNERS，意味着改之前最好 ping `<owner>`，对吗？"
  - "我看到这个文件最近 3 个月没人动，但你的 ticket 文字里有 `<word>` 暗示要碰它。要先确认 owner 吗？"

---

## Q5. success 怎么算？（最浅版本）

- agent **不能** 自答（这是 ticket-specific business intent）
- 给 junior 兜底（**单选 + 跟一个 follow-up**）：
  - "下面哪条最贴近这个 ticket 的成功标准？"
    - (a) 用户做 X 看到 Y（手工 happy path 跑通）
    - (b) API/CLI 返回 Z 形状的数据（接口契约满足）
    - (c) 某 metric 指标不下降（observability 不退化）
    - (d) 其他（让我描述）
  - follow-up: "举一个你能在本机**直接观察到**的判定方式（CLI 命令 / 一个 URL / 一个测试名）"
- ⚠️ 这是**唯一**真正需要 junior 给业务输入的问题——压到一题，因为 junior 在这一题上失败的成本最高

---

## Q6. 这个 ticket 是不是 epic-sized？（agent 自评 + junior 复议）

- agent 自答（基于 Q1-Q5 综合）：
  - 影响 ≥ 5 个文件 / 跨 3 个模块 / clarify 阶段问题超 1 小时没收敛 → 暗示是 epic
- 给 junior 兜底：
  - "我感觉这个 ticket 的范围 = `<scope estimate>`，预估 `<X>` 小时。如果你觉得范围太大，建议先拆成 sub-feature 1: `<...>`、sub-feature 2: `<...>`。要拆吗？"
- ⚠️ 这是 R1/R2 研究**最关心**的信号点（"junior 对范围的感知是否准"）

---

## Q7. 你想走哪条工作流？

- agent **不能**自答
- 给 junior 兜底（**单选**）：
  - (a) 直接写代码（develop → test → review → ship）—— 最快路径，适合改动小 / 你熟此模块
  - (b) 先 spec 再写（spec → develop → test → review → ship）—— 适合接口变更 / 多人协作
  - (c) 先 TDD 再写（tdd → develop → test → review → ship）—— 适合关键逻辑 / 历史 bug 多
  - (d) spec + TDD 都走（spec → tdd → develop → test → review → ship）—— 最严
- 默认推荐：基于 Q6 自动给一个建议（如果 junior 选 (a) 但 agent 评估 epic-sized → AskUserQuestion 二次确认）

---

## §agent-self-answered

agent 跳过的问题**必须**写在这里，每条带：
- question id
- agent's answer
- evidence (file:line / grep query / git command)
- self-assessed confidence (high / medium / low)

junior 可以在 clarify 阶段**任何时候**回到这里 challenge agent 的答案。这不是装饰——是 trust-blindness 的核心抗体。

---

## §deferred-decisions

任何 junior 选 "我现在还不知道" 或 follow-up 不能立即回答的，写到这里：
- decision id
- question
- 决定 deferred 的原因
- 何时回头（哪个 stage 必须解决）

deferred 的决定**会在 design / spec / review 阶段被重新检查**——没有"假装回答了"的余地。
