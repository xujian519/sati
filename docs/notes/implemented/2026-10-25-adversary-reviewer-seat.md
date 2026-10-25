# Agent Note: 对抗审查席位落成（worker 契约 + 断言链 + 工具面收紧）

Status: implemented

## Problem

`adversarial-reviewer` 是「席位已设、工序为空、隔离未构造」：`skills/patent-teams/adversarial-reviewer/SKILL.md` 声明了 `type: role` / `readOnly: true`，却用 `tools: ["*"]` 放开全部工具、七个域全开；`src/patent/worker-contract.ts` 虽在 `ROLE_WORKER_TIERS` 给了 `["checker"]`，但没有对应 worker 契约，也没有输出字段约束。结果是「对抗审查」只靠提示词自律：第二个 agent 能读到撰写方的全部中间产物，审查意见也没有统一的脆弱点/反驳钩子结构。

## Decision

**worker 契约**

- `defaultPatentWorkers()` 新增 `patent-adversary-reviewer`（tier `checker`），输入固定三条路径：交付件（`outputs/*.md`）、对比文件原文（`source/**`）、权利要求/交底书（`disclosure/*.md`）。
- 输出 `data/cases/{caseId}/outputs/adversarial-review.md`，`contractLevel: "hard"`，`requiredFields` 为「主张 / 前提 / 脆弱点 / 反驳钩子 / factRef / articleRef」；`forbiddenActions` 列出写稿、起草与渲染类动作。
- `WORKER_ROLE_MAP` 补 `patent-adversary-reviewer → adversarial-reviewer`；`ROLE_WORKER_TIERS` 既有 `["checker"]` 保持不变（两处同步，任一缺失都会「声明了但不可调度」）。

**断言链复用 syllogism**

四段映射到既有 `Syllogism` 字段：主张 → `conclusion`、前提 → `majorPremise`/`minorPremise`、脆弱点 → `vulnerableAt`、反驳钩子 → `rebuttalHook`。S-09 已补的两个可选字段是本席位的唯一新增结构；`factRef` / `articleRef` 沿用三段论的强制引用语义，不新造第三套论证结构。

**工具面收缩为显式白名单**

- `tools` 从 `["*"]` 改为 20 项只读白名单：文件读取（`read_file`/`glob`/`grep`）、法条与专利检索、claim-chart/evidence/eval/rule 评审、`paper_search`、团队作业面 3 工具。
- `domains` 从七域全开收缩为 `patent` / `legal` / `quality` / `literature` / `filesystem` / `team`。`filesystem` 与 `team` 是为「白名单真正可见」而保留的：`scopeTools` 先按白名单再按域过滤，缺 `filesystem` 会让 `read_file`/`glob`/`grep` 静默不可见，缺 `team` 会让子代理模式下的 `team_*` 作业面不可见（团队成员会话另有 job-surface 兜底，但 `subagent_type` 路径没有）。
- SKILL 正文新增「输入与信息隔离」「断言链」两节，写明「只审三条输入路径、不读 diff/hint/conclude」「隔离靠声明，不靠 prompt」。
- `skills/patent-team-composition/SKILL.md` 把该席位钉在「交付件定稿后、质量门禁/收口/归档前」，未完成不得归档。

## Alternatives considered

- **保留 `tools: ["*"]` + 只在 prompt 里写纪律** — 正是本议题要修的形态：prompt 不承担权限边界，工具面仍会让审查员读到撰写方的中间推理，信息隔离只剩口头承诺。
- **`domains` 严格只留 `patent`/`legal`/`quality`** — 字面符合议题摘要，但 `scopeTools` 的过滤顺序会让白名单里的 `read_file`/`glob`/`grep` 全部不可见（当前全部专利角色都缺 `filesystem`，是一个已存在的隐性缺口）；白名单会退化成装饰。补 `literature` 的理由同样来自 `paper_search` 的域。保留 `team` 是为了让 `subagent_type` 路径也能回报团队状态。
- **照抄计划白名单里的 `list_dir`** — 该工具在 `createBuiltinRegistry` 中不存在；幽灵工具名不会被引用门禁覆盖（frontmatter 数组不是反引号 token），因此本次删除，并由测试对「白名单 ⊆ 真实注册表」做硬断言。
- **在 worker 契约里再声明一份 `allowedTools`** — 执行侧没有消费者，且会与 SKILL 白名单形成两份事实源；工具面只保留 SKILL 一处声明，契约里用注释说明分工。
- **新造对抗审查专用结构（`AdversarialFinding` 等）** — S-09 刚把三套论证结构收敛到 `ArgumentRef`，再加一套会立刻回到「结构并存」。四段链直接映射 `Syllogism` 字段，观察口径统一。
- **要求输出自由文本、只靠人工判断引用** — `validateWorkerOutput` 只能做子串校验；把 `factRef`/`articleRef` 放进 hard requiredFields，至少能把「没有引用」的输出判为降级，而不是假装通过。

## Consequences

- 对抗审查现在有可注册的 worker 契约、可校验的四段输出与真实收紧的工具面；`tools` 改回 `["*"]` 或从 `domains` 删任一依赖域，测试会转红。
- 读取面仍是「文件系统只读」而非法条级路径白名单：`read_file` 仍可读工作区任意文件，隔离的上限是「只读 + 声明三条输入 + prompt 纪律」。要做到路径级强制，需要新增 path-scoped 读取工具，不在本工作包。
- `patent_worker_validate` 的可用 worker 清单多一项（输入 schema 未变，无需重录 llm-replay）。
- 域收缩后 `analysis` / `session` 下的工具对该角色不可见（当前白名单没有依赖它们）；后续若给该角色加分析工具，须同步补域与白名单。
