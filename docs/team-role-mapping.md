# 团队岗位 — Sati 角色映射表

> 来源：`skills/patent-team-composition/SKILL.md`（Task 9 移植的 dsh 专利团队资产，12 团队岗位）
> 对照：Sati 既有 `skills/` 下 `type: role` 角色（grep 统计 32 个，`skills/<name>/SKILL.md` 结构）
> 日期：2026-08-20
>
> **接线状态：T14 资产就绪，注册接线 T15 落地。** 12 岗角色资产与映射已就绪（5 新增角色 frontmatter 补全；7 复用岗以团队变体角色资产呈现，见下方映射表「复用/新增」列变更为「变体」）。`skills/patent-teams/` 二级目录角色（本表 12 岗）的注册装配路径（skills 加载递归扫描）由 M3 T15 接线——当前经 `subagent_type` / 团队 roleSlug 调度尚不可用，T15 落地后本表更新为「已注册可调度」。

## 一、总览

12 个团队岗位中 7 个可复用 Sati 既有角色（部分岗位需组合多个角色以覆盖职责），5 个无既有对应，以新增角色资产补齐（`skills/patent-teams/`）。

## 二、映射表

| 团队岗位 | role id | Sati 角色映射 | 新增/变体 | 差异说明 |
|---|---|---|---|---|
| 案件管理员 | `case-manager` | — | **新增** | 流程中立型管理岗位（案卷/期限/补充循环），Sati 无对应角色，见 `skills/patent-teams/case-manager/SKILL.md` |
| 检索员 | `researcher` | `patent-retriever` | 变体（基底 `patent-retriever`） | 职责高度重合（多源检索 + 三段式报告）。差异：dsh 岗位含**覆盖度评估与可专利性初判**，`patent-retriever` 聚焦检索与报告输出；覆盖度自评已由变体角色 systemPrompt 补充（差异资产 `skills/patent-teams/researcher/SKILL.md`，T15 落地），或由 captain（主会话，调度与收口方）在成员简报中要求 |
| 撰写员 | `drafter` | `patent-writer` + `provision-drafting-claims` + `provision-drafting-spec` | 变体（基底 `patent-writer` + 2 provision） | `patent-writer` 覆盖权利要求/说明书/摘要撰写（对接 `draft_claims`/`draft_specification`）；两个 provision worker 为 P-D01/P-D02 条款级撰写，按作业类型选用。差异：dsh 岗位含**逐特征比对**（撰写后自检），已由变体角色补充（差异资产 `skills/patent-teams/drafter/SKILL.md`，T15 落地），亦可比对 `patent-novelty-checker` 或交由对立审查员红队评审覆盖 |
| 技术专家 | `technical-expert` | `patent-analyzer` + `patent-electrical-agent` | 变体（基底 `patent-analyzer` + `patent-electrical-agent`） | `patent-analyzer` 做技术方案解构/四层对比/区别特征识别；电学领域（IPC H 部）补 `patent-electrical-agent`。差异：dsh 岗位含**实施例可实施性与效果数据真实性核验**（识别夸大/虚构技术陈述），`patent-analyzer` 偏技术分析；真实性核验指令已由变体角色补充（差异资产 `skills/patent-teams/technical-expert/SKILL.md`，T15 落地） |
| 对立审查员 | `adversarial-reviewer` | `patent-reviewer` + `patent-quality-checker` | 变体（基底 `patent-reviewer` + `patent-quality-checker`） | 审查方红队视角：`patent-reviewer`（格式 + A26.3/A26.4/A31.1 内容审查）与 `patent-quality-checker`（保护范围/撰写质量/授权前景多维评分）均为 `readOnly`，与"红队评审不改稿"的分工吻合。差异：dsh 岗位含**程序表述审查**（如答复期限表述），期限类核验由案件管理员承担，不在此角色重复；变体角色资产 `skills/patent-teams/adversarial-reviewer/SKILL.md`（T15 落地） |
| 申请人代理 | `applicant-counsel` | — | **新增** | 申请人方立场（范围最大化/争辩策略），Sati 既有撰写类角色均为中立代理人立场、无立场型代理角色，见 `skills/patent-teams/applicant-counsel/SKILL.md` |
| 形式审查员 | `formal-examiner` | — | **新增** | 初步审查视角（形式缺陷/补正彻底性）；`patent-formal-exam` 为技能资产（流程方法论）而非 `type: role` 角色，无法直接调度，见 `skills/patent-teams/formal-examiner/SKILL.md` |
| 无效请求人 | `invalidity-petitioner` | `patent-invalidity-checker` + `provision-invalidity-procedure` | 变体（基底 `patent-invalidity-checker` + `provision-invalidity-procedure`） | `patent-invalidity-checker`（无效理由/证据组合 ≥3 策略/成功率，`readOnly`）与 P-C02（A45/A46 程序梳理）覆盖主职责。差异：dsh 岗位含**预判专利权人应对**，对抗预判指令已由变体角色补充（差异资产 `skills/patent-teams/invalidity-petitioner/SKILL.md`，T15 落地） |
| 专利权人 | `patentee-defender` | `patent-invalidity-checker`（视角复用）+ `provision-defenses` / `provision-infringement-literal` / `provision-infringement-equivalent` / `provision-damages` | 变体（基底 `patent-invalidity-checker` + 4 provision） | 防御/主张立场：无效场景反向复用 `patent-invalidity-checker`（质证/反证/修改换维持）；诉讼场景复用 P-B02/P-B03（侵权比对）、P-B06（判赔计算）、P-B05（预演对方抗辩）。差异：既有角色均为中立分析视角，**防御/主张立场已由变体角色以 systemPrompt 显式反转声明**（差异资产 `skills/patent-teams/patentee-defender/SKILL.md`，T15 落地） |
| 合议组/裁判 | `adjudicator` | `patent-reviewer` + `provision-reexamination` | 变体（基底 `patent-reviewer` + `provision-reexamination`） | 中立裁判：`patent-reviewer`（审查基准） + P-C03（A41 复审程序：前置审查/合议审查/复审决定）。差异：dsh 岗位含**双方论点对抗评估、证据采信、结果预判**，中立裁判指令（不参与任一方策略起草）已由变体角色补充（差异资产 `skills/patent-teams/adjudicator/SKILL.md`，T15 落地） |
| 被告代理人 | `defendant-counsel` | — | **新增** | 抗辩方立场（不侵权/现有技术抗辩/禁反言/提无效反制），Sati 无抗辩方角色（`provision-defenses` 为条款 worker，无立场声明），见 `skills/patent-teams/defendant-counsel/SKILL.md` |
| 技术调查官 | `tech-investigator` | — | **新增** | 中立技术查明岗位，与技术专家（我方立场）区分，Sati 无中立技术调查角色，见 `skills/patent-teams/tech-investigator/SKILL.md` |

复用角色均为 `type: role`（`skills/<name>/SKILL.md`）；其中检查/评估类（`patent-reviewer`、`patent-quality-checker`、`patent-invalidity-checker`、`patent-novelty-checker` 等）声明 `readOnly: true`，与团队"只读评审不改稿"的分工一致。检索型角色 domains 含 `"search"`（如需 `paper_search` 需补 `"literature"`，以既有文件实际声明为准）。

## 三、新增 5 岗速览

| 角色 | 立场 | 一句话职责 | 资产 |
|---|---|---|---|
| 案件管理员 | 流程中立 | 立案登记/案卷目录、交底书接收、补充资料循环、期限/节点监控、补充合格判定收口 | `skills/patent-teams/case-manager/SKILL.md` |
| 形式审查员 | 审查方（初步审查） | 形式缺陷清单核验（文件齐全性/格式/附图/著录项目/签字盖章）、补正彻底性判定 | `skills/patent-teams/formal-examiner/SKILL.md` |
| 申请人代理 | 申请人方 | 权利要求范围最大化、从权布局、合并修改备选、争辩策略 | `skills/patent-teams/applicant-counsel/SKILL.md` |
| 被告代理人 | 抗辩方 | 不侵权/现有技术抗辩、禁反言与捐献排除等同、提无效反制、豁免抗辩 | `skills/patent-teams/defendant-counsel/SKILL.md` |
| 技术调查官 | 中立技术查明 | 实施例/特征比对/等同的技术维度独立判断，输出中立技术事实意见 | `skills/patent-teams/tech-investigator/SKILL.md` |

## 四、注册接线（T15 落地；本表先行资产）

- 现状（T14）：5 个新增角色（`case-manager`/`formal-examiner`/`applicant-counsel`/`defendant-counsel`/`tech-investigator`）已按 `skills/` 下 `type: role` SKILL.md 惯例补全 frontmatter（`tools`/`omitTools`/`readOnly`/`systemPrompt`；`domains` 以各文件"工具域建议"小节为准 + 追加 `"team"` 作业面），但**尚未注册**：当前运行时角色注册仅经插件贡献路径（`createLocalGateway.syncRoleDefinitions` → `roleFromContribution`，遍历 `pluginRuntime.getAllSkills()`），skills 扫描只检查一层子目录（`discoverSkillPaths` / `listSkillsIn`），`skills/patent-teams/`（自身无 SKILL.md）整目录被跳过；7 个变体角色资产由 T15 创建
- T15 接线：为 `skills/patent-teams/` 补注册装配路径（skills 加载递归扫描 → `roleFromSkill`/`rolesFromSkills` → `registerRoleDefinition`），完成后 12 岗（5 新增 + 7 变体）可按 `subagent_type` / 团队 roleSlug 调度，届时本表更新为已注册
- 本任务不涉及 `src/` 改动（注册装配路径属 T15）、不改 `assets/`、不改 `rules/`

## 五、参照资产

- `skills/patent-team-composition/SKILL.md` — 12 团队岗位定义、7 场景角色包与任务 DAG（Task 9 资产）
- `skills/patent-teams/*/SKILL.md` — 本任务新增 5 个缺位角色资产
- 既有角色惯例样例：`skills/patent-retriever/SKILL.md`、`skills/patent-writer/SKILL.md`、`skills/patent-reviewer/SKILL.md`
