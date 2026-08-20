# 团队岗位 — Sati 角色映射表

> 来源：`skills/patent-team-composition/SKILL.md`（Task 9 移植的 dsh 专利团队资产，12 团队岗位）
> 对照：Sati 既有 `skills/` 下 `type: role` 角色（grep 统计 32 个，`skills/<name>/SKILL.md` 结构）
> 日期：2026-08-20
>
> **接线状态：已落地（M3）。** 12 岗全部经 registerRoleDefinition 注册（装配路径：`createLocalGateway.syncRoleDefinitions` + `skills/patent-teams/` 目录遍历补丁 `registerNestedTeamRoleDefinitions`，见第四节），可按 `subagent_type` / 团队 roleSlug 调度。运行时装配由 `tests/cli/team-role-assembly.spec.ts` 集成用例断言（真实 createLocalGateway 首会话装配后 `listRegisteredRoleIds()` 含 12 岗 id）。

## 一、总览

12 个团队岗位中 7 个可复用 Sati 既有角色（部分岗位需组合多个角色以覆盖职责），5 个无既有对应，以新增角色资产补齐（`skills/patent-teams/`）。

## 二、映射表

| 团队岗位 | role id | Sati 角色映射 | 新增/变体 | 差异说明 |
|---|---|---|---|---|
| 案件管理员 | `case-manager` | — | **新增** | 流程中立型管理岗位（案卷/期限/补充循环），Sati 无对应角色，见 `skills/patent-teams/case-manager/SKILL.md` |
| 检索员 | `researcher` | `patent-retriever` | 变体（基底 `patent-retriever`） | 职责高度重合（多源检索 + 三段式报告）。差异：dsh 岗位含**覆盖度评估与可专利性初判**，`patent-retriever` 聚焦检索与报告输出；覆盖度自评已由变体角色 systemPrompt 补充（差异资产 `skills/patent-teams/researcher/SKILL.md`，已注册可调度），或由 captain（主会话，调度与收口方）在成员简报中要求 |
| 撰写员 | `drafter` | `patent-writer` + `provision-drafting-claims` + `provision-drafting-spec` | 变体（基底 `patent-writer` + 2 provision） | `patent-writer` 覆盖权利要求/说明书/摘要撰写（对接 `draft_claims`/`draft_specification`）；两个 provision worker 为 P-D01/P-D02 条款级撰写，按作业类型选用。差异：dsh 岗位含**逐特征比对**（撰写后自检），已由变体角色补充（差异资产 `skills/patent-teams/drafter/SKILL.md`，已注册可调度），亦可比对 `patent-novelty-checker` 或交由对立审查员红队评审覆盖 |
| 技术专家 | `technical-expert` | `patent-analyzer` + `patent-electrical-agent` | 变体（基底 `patent-analyzer` + `patent-electrical-agent`） | `patent-analyzer` 做技术方案解构/四层对比/区别特征识别；电学领域（IPC H 部）补 `patent-electrical-agent`。差异：dsh 岗位含**实施例可实施性与效果数据真实性核验**（识别夸大/虚构技术陈述），`patent-analyzer` 偏技术分析；真实性核验指令已由变体角色补充（差异资产 `skills/patent-teams/technical-expert/SKILL.md`，已注册可调度） |
| 对立审查员 | `adversarial-reviewer` | `patent-reviewer` + `patent-quality-checker` | 变体（基底 `patent-reviewer` + `patent-quality-checker`） | 审查方红队视角：`patent-reviewer`（格式 + A26.3/A26.4/A31.1 内容审查）与 `patent-quality-checker`（保护范围/撰写质量/授权前景多维评分）均为 `readOnly`，与"红队评审不改稿"的分工吻合。差异：dsh 岗位含**程序表述审查**（如答复期限表述），期限类核验由案件管理员承担，不在此角色重复；变体角色资产 `skills/patent-teams/adversarial-reviewer/SKILL.md`（已注册） |
| 申请人代理 | `applicant-counsel` | — | **新增** | 申请人方立场（范围最大化/争辩策略），Sati 既有撰写类角色均为中立代理人立场、无立场型代理角色，见 `skills/patent-teams/applicant-counsel/SKILL.md` |
| 形式审查员 | `formal-examiner` | — | **新增** | 初步审查视角（形式缺陷/补正彻底性）；`patent-formal-exam` 为技能资产（流程方法论）而非 `type: role` 角色，无法直接调度，见 `skills/patent-teams/formal-examiner/SKILL.md` |
| 无效请求人 | `invalidity-petitioner` | `patent-invalidity-checker` + `provision-invalidity-procedure` | 变体（基底 `patent-invalidity-checker` + `provision-invalidity-procedure`） | `patent-invalidity-checker`（无效理由/证据组合 ≥3 策略/成功率，`readOnly`）与 P-C02（A45/A46 程序梳理）覆盖主职责。差异：dsh 岗位含**预判专利权人应对**，对抗预判指令已由变体角色补充（差异资产 `skills/patent-teams/invalidity-petitioner/SKILL.md`，已注册可调度） |
| 专利权人 | `patentee-defender` | `patent-invalidity-checker`（视角复用）+ `provision-defenses` / `provision-infringement-literal` / `provision-infringement-equivalent` / `provision-damages` | 变体（基底 `patent-invalidity-checker` + 4 provision） | 防御/主张立场：无效场景反向复用 `patent-invalidity-checker`（质证/反证/修改换维持）；诉讼场景复用 P-B02/P-B03（侵权比对）、P-B06（判赔计算）、P-B05（预演对方抗辩）。差异：既有角色均为中立分析视角，**防御/主张立场已由变体角色以 systemPrompt 显式反转声明**（差异资产 `skills/patent-teams/patentee-defender/SKILL.md`，已注册可调度） |
| 合议组/裁判 | `adjudicator` | `patent-reviewer` + `provision-reexamination` | 变体（基底 `patent-reviewer` + `provision-reexamination`） | 中立裁判：`patent-reviewer`（审查基准） + P-C03（A41 复审程序：前置审查/合议审查/复审决定）。差异：dsh 岗位含**双方论点对抗评估、证据采信、结果预判**，中立裁判指令（不参与任一方策略起草）已由变体角色补充（差异资产 `skills/patent-teams/adjudicator/SKILL.md`，已注册可调度） |
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

## 四、注册接线（已落地，M3 T15）

- **落地方式**：`createLocalGateway.syncRoleDefinitions`（`src/cli/createLocalGateway.ts`）在遍历插件贡献角色（`pluginRuntime.getAllSkills()` → `roleFromContribution` → `registerRoleDefinition`）之后，追加调用 `registerNestedTeamRoleDefinitions(builtinSkillsRoot)`（`src/cli/teamRoleAssembly.ts`）：对 `skills/patent-teams/` 下每个含 SKILL.md 的子目录走**同一**装配路径——frontmatter（yaml 解析，多行 `systemPrompt` 块/数组字段完整）→ `parseRoleConfig` → `roleFromContribution` → `registerRoleDefinition`。不修改 `discoverSkillPaths`/`listSkillsIn` 的全局扫描（影响所有 skills 加载路径，风险大）
- **12 岗**（5 新增 + 7 变体）：`case-manager`/`researcher`/`drafter`/`technical-expert`/`adversarial-reviewer`/`applicant-counsel`/`formal-examiner`/`invalidity-petitioner`/`patentee-defender`/`adjudicator`/`defendant-counsel`/`tech-investigator`，全部经 registerRoleDefinition 注册，可按 `subagent_type` / 团队 roleSlug 调度
- **运行时验证**（M3 完成判据）：`tests/cli/team-role-assembly.spec.ts` 集成用例——真实 `createLocalGateway`（fake model）+ sati.yaml，消费一个 turn 触发首会话准备后断言 `listRegisteredRoleIds()` 含 12 岗 id（真实运行时装配，非文件存在性）
- 已知既有缺陷（T15 范围外）：`skills/` 一层子目录角色经插件贡献路径注册时，frontmatter 由简易解析器读取（`PluginCommandLoader.parseMarkdownFrontmatter`），多行 `systemPrompt` 块与数组字段（`domains`/`omitTools`）会丢失；`skills/patent-teams/` 嵌套目录角色经 T15 补丁（yaml 解析）注册，内容完整。修复 plugin 链路简易解析属独立事项，未纳入 T15
- **已知边界（domains 缺口，T15 复审记录）**：部分岗 domains 未含 `"literature"`/`"legal"`（adjudicator/adversarial-reviewer/applicant-counsel/case-manager/formal-examiner 缺 literature；drafter 缺 legal+literature；tech-investigator 缺 legal——后者为其中立技术查明定位的设计意图），相应角色不可见 `paper_search`/`law_search`；文献检索职责由 researcher（含 literature）承担，法条核验以案件管理员/既有检索工具为准。资产经 spec 逐字批准，补全列 backlog

## 五、参照资产

- `skills/patent-team-composition/SKILL.md` — 12 团队岗位定义、7 场景角色包与任务 DAG（Task 9 资产）
- `skills/patent-teams/*/SKILL.md` — 12 团队岗位角色资产（5 新增 + 7 变体）
- 既有角色惯例样例：`skills/patent-retriever/SKILL.md`、`skills/patent-writer/SKILL.md`、`skills/patent-reviewer/SKILL.md`
