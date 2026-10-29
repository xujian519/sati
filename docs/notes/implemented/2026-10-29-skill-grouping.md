# Agent Note: 技能清单按域分组（prompt 渲染层，不改注册）

Status: implemented

## Problem

技能导入后内置技能到 225 个（`legal-*` 131 个），`<available-skills>` 是逐条平铺的
`- name — description`。实测该块 **33,031 字符 ≈ 10.3k tokens**（按 3.2 字符/token 粗估），
在首个请求的固定开销里占大头；其中 131 条 `legal-*` 的描述约 6.6k tokens。
同时模型要在一个 225 行的清单里选技能，选择信号被长描述稀释。

## Decision

**分组只发生在 prompt 渲染层；技能目录、注册、`read_skill` 契约全部不动。**

- 归组按 **slug 前缀规则**（`src/context/prompt/skillGroups.ts`）：
  - `legal-<子域>-<动作>` → `Legal · <子域>`（子域语义由第二段决定）
  - 其余 `legal-*`（`legal-agent` / `legal-matter` / `legal-research` / `legal-setup`）→ `Legal · General`
  - `patent-*` / `provision-*` / `drafting-*` → `Patent`（与 `isPatentSkillName` 同一前缀集合）
  - `docx/pptx/xlsx/pdf/spreadsheets` → `Office documents`；`html-*` → `HTML deliverables`；
    前端/图表/React 约定 → `Design & frontend`；外部应用与 CLI → `Apps & integrations`；
    浏览/检索/技能作者工具 → `Research & authoring`
  - 未命中任何规则的技能 → `General`（**新增技能不需要手工重排**；新增 `legal-*` 子域按
    第二段自动成组，已登记子域顺序不变，未登记子域用稳定散列槽位排在后面）
- **compact / verbose 两级渲染**：
  - compact 组（`legal/*`、`patent`）只列 `names: a, b, c`，逐条描述省略，语义由组头
    一句话摘要承担（摘要随子域固定，例如 litigation = "Matters, demand letters, pleadings,
    discovery, privilege logs, and hearing prep."）
  - verbose 组（办公文档、HTML、设计、外部应用、研究/作者）**保留逐条描述**：
    `gog` / `tmux` / `pdf` / `spike` 这类名字不透明的技能，省描述会直接伤选技能准确率
- **按需展开**：`read_skill`（按名字取 SKILL.md 全文）保持不变，另加 `list_skills`
  （组 → 名字 + 描述）做中间粒度：
  - 无 `group` 参数时返回组 id / 组名 / 计数 / 组摘要（不返回逐条技能）；
  - 带 `group` 时返回该组 `skills[].name/description`；父 id（如 `legal`）展开
    `legal/*` 全部子组；未知组返回空 + 可用组 id 列表（可区分，不是静默空）。
  - 归组直接调用 `skillGroups.ts` 的 `groupSkills()`，与 prompt 渲染同源，不产生第二套规则。
  - `PromptAssembler` 仅在 `list_skills` 已注册时追加一句「按组展开描述」的提示；
    没有该工具时渲染字节与上一版完全一致。
  - **不新增第二层目录结构**：技能目录继续平铺 `skills/<slug>/`，`check:skills` 的递归发现
    逻辑不受影响。
- `patentDomainEnabled: false` 时先按既有判据过滤专利技能，再分组（整组消失，不留空壳）。

**实测（本机 225 个技能，模拟 `read_skill` 在场）**

| 范围 | 旧块 | 新块 | 变化 |
|---|---|---|---|
| 全部 225 技能 | 33,031 字符 ≈ 10.3k tokens | 15,721 字符 ≈ 4.9k tokens | **-52%**（22 个组） |
| 试点：131 个 `legal-*` | 21,123 字符 ≈ 6.6k tokens | 6,926 字符 ≈ 2.2k tokens | **-67%**（16 个组） |

**落点**

| 文件 | 作用 |
|---|---|
| `src/context/prompt/skillGroups.ts` | 前缀归组规则、`skillGroupFor()`、`groupSkills()`、组级摘要 |
| `src/context/prompt/PromptAssembler.ts` | `formatSkills()` 改为分组渲染 + `names:` 折行；其余段落不变 |
| `tests/context/prompt-skill-groups.spec.ts` | 7 条单测：归组/新子域自动成组/排序/compact 与 verbose 渲染/无 `read_skill` 时带路径/`list_skills` 在场时追加按组展开提示 |
| `src/tool/builtin/listSkills.ts` | `createListSkillsTool()`（`kind: "session"`，`outputSchema.required=["total","groups"]`） |
| `src/tool/registry/createBuiltinRegistry.ts` | 仅在传入 `options.readSkill` 时注册 `list_skills`（技能清单为空的环境不加工具） |
| `tests/tool/builtin/listSkills.spec.ts` | 5 条单测：概览不含逐条描述/按组展开/父组展开子组/未知组可区分/无技能不报错 |
| `tests/context/prompt-patent-skills.spec.ts`、`prompt-skill-path.spec.ts` | 同步断言：专利组为 compact（`names:` 行），办公组仍逐条带描述 |

**llm-replay**：本批改了 `<available-skills>` 渲染，但录制 fixture 的请求里
**不含该块**（重放测试的 `createBuiltinRegistry` 不装配技能依赖，技能清单为空），
改动不进入该请求字节，重放测试改后实测 green（`dist/tests/test-support/llm-replay-real.spec.js`
1/1 pass）。**因此没有重录，也没有伪造 fixture**。谁因此漏了什么：带真实技能清单的请求
形态没有 fixture 覆盖，这条渲染路径只有单测（`prompt-skill-groups` /`prompt-patent-skills`）
守护，不是真实模型重放核验。

## Alternatives considered

- **把技能目录改成 `skills/<域>/<slug>/` 子目录** — `SkillManager.listSkillsIn()` 只 readdir
  一层，嵌套技能直接不出现在注册面（导入时的 P1 已经踩过这个坑）；要让注册支持递归就得改
  `SkillManager`、`check:skills`、teamRoleAssembly 的既有路径假设，风险远大于收益。落选。
- **新增 `list_skills` 工具做「组 → 描述」按需展开** — 第一版认为工具面 +1、`toolSchemaDigest`
  变化、工具白名单与 `protectedContext` 都要跟着改，收益不足以覆盖契约面扩张，**当时落选**。
  后续用户拍板改为**按需展开**后已落地（见 Decision），且把契约面收窄为：
  只在传入 `readSkill` 依赖时注册、`inputSchema` 只有一个可选 `group`、归组复用同一套规则。
  关键事实：录制 llm-replay fixture 时 registry 未传 `readSkill`，工具表不含 `list_skills`，
  `toolSchemaDigest` 不变，**因此没有重录**。
- **只截断描述（例如截到 60/80 字符）** — 实测 225 条截到 60 字符仍约 5.8k tokens
  （描述均值约 114 字符），省得少且把「何时用」的信息截没；落选。
- **全部组都 compact（连 `gog` / `1password` 也只列名字）** — 省到约 3.6k tokens 的收益，
  换来最差的选择信号：名字不透明的技能失去唯一语义。落选。
- **按工作区判据整组隐藏 `legal-*`（类似 patent 裁剪）** — 法律域没有可靠的工作区判据
  （不存在 `.sati/rules.yaml` 里的 legal 段这种硬信号），误判会让用户静默失去 131 个技能；
  分组比隐藏安全。落选。
- **什么都不做，等真实会话观察选技能质量** — 现状 10.3k tokens 的固定开销已经在挤压任务
  空间，且 131 条同域描述本就在互相稀释。落选。

## Consequences

- 固定开销实测下降约 5.4k tokens（全量）/ 4.4k tokens（法律试点）。
- **选技能准确率本批没有量测**：仓库内没有技能选择基准集（现有 benchmark 是专利/法条
  检索评测，不含技能路由）。谁因此漏了什么：无法给出「分组前后选对率」的数字，只能给出
  设计上的缓解（组头摘要、verbose 组保留描述、名字仍是 `read_skill` 入参）与后续观察点。
  若后续出现选错技能的真实案例，优先考虑把该组从 compact 降级为 verbose（规则表一行改动）。
- 组级摘要是**人工维护**的语义说明（`LEGAL_DOMAINS` / `FAMILY_RULES`）：新增子域不写摘要也能
  成组（只有名字 + 组头计数），不会失配；但摘要缺失时该组的语义只剩名字。
- 未改 `AgentEvent` / gateway frames；`list_skills` 是新增工具而非改既有 `inputSchema`，
  且只在 `readSkill` 依赖存在时注册，llm-replay fixture 的工具表不变，`check:event-matrix` 不受影响。
- `list_skills` 的展开文本与 prompt 渲染同源：分组规则改动会同时影响两处（这是有意的，
  避免 prompt 里显示的分组与工具返回的分组不一致）。
- `check:skills` 不校验分组（分组不是目录结构），分组规则本身由 `prompt-skill-groups.spec.ts`
  覆盖；规则表新增家族时不需要改 `validate-skills.mjs`。
