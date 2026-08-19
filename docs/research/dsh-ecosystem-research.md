# DSH 生态与周边项目调研笔记

> 调研快照：2026-08-18 实测（GitHub API + 官方/社区文档）
> 用途：为 Sati（开源专利智能体 OS，自有 agent loop / gateway / 插件系统）提供"宿主 + 插件生态"层面的外部参照。

## 0. 调研快照（2026-08-18 实测，GitHub API + 官方/社区文档）

| 对象 | 数据 |
|---|---|
| deepseek-ai/deepseek-harness | 创建于 2026-08-13；调研时 165,406 stars / 17,571 forks；MIT；`master` 分支；明确自称 **developer preview、"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"**（[README](https://github.com/deepseek-ai/deepseek-harness)） |
| GitHub `topic:dsh-plugin` 仓库数 | **7,946**（非归档 7,926，GitHub Search API 实测）；中文媒体 2026-08-17 报道"上线三天近 6000 个"（含蹭热度/广告，精选清单约 1000+） |
| dsh-agent-teams | 599 stars；创建 2026-08-12（早于 dsh 公测一天，作者在 beta 上抢跑） |

## 1. deepseek-ai/deepseek-harness 本身

### 1.1 定位
- "an open-source agent harness… **everything is a plugin**"，由 [Cordis](https://github.com/cordiverse/cordis) 驱动（其设计论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)）——即"插件在时空上可组合"（注册即 effect、卸载回滚副作用）。运行形态是 `npx @deepseek-ai/dsh web` 起 Web UI（默认 127.0.0.1:3080），无 CLI 优先形态（[README](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md)）。
- monorepo 结构：219 包/49 组，npm scope `@deepseek-ai/dsh-*`；vendor/ 直接 vendored 整个 Cordis（[packages/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)）。

### 1.2 插件体系（核心机制）
- **Profile + Bundle 分层组合**：profile 是命名组合（存 `$DSH_HOME/profiles/<name>/`），列出有序 bundle 列表；bundle 是分发格式（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）；生效顺序 = profile bundles → profile `cordis.patch.yml` → 家目录 patch → CLI `--patch`，**后层按行 id 整段覆盖前层（非深合并）**。`dsh --profile web --dump-config` 可打印整棵配置树，任何一行都可被 patch 替换（[docs/architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）。
- **无特权内核**："There is no privileged core to patch"——模型适配器、工具注册表、会话日志、agent loop 本身（`dsh-agent-loop`）都是可替换插件（同上）。
- **能力接缝（capability seam）三角色**：Service Definition（接口） / Service Provider（实现） / Consumer（消费方，常为模型工具）。一个 provider 交换可搬动整个执行世界——换 `ctx.fs`/`ctx.subprocess` 两个 provider 就把 Bash/PTY/LSP 一起搬进 E2B 远程沙箱（POC 状态）（[architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[packages/e2b](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/e2b)）。
- **事件域三分类**：Session events（durable，append-only `SessionEvent` 日志）、Agent events（`agent/*` 活体拦截）、Capability events（`fs/*`、`tools/*`、`telemetry/*` 策略挂接）。turn/step 流水线：`turn/start → agent/pre-step → step/start → agent/request → llm/stream → tools/pre-execute|execute|post-execute → step/end → agent/turn-stopping → turn/end`，其中 `agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 是 **waterfall（必须 next() 让渡）**（同上）。
- **host/client 双面包**：`dsh.bundle` 管 host 半边，`dsh.client`（`platform: "web"` + `inject`）管浏览器半边；client bundle 经 `window.__ModuleLoader__.load()` 注入，UI 扩展走 **Slot 系统**（`conversation.session.header.actions`、`conversation.chat.node`、`conversation.composer.dock`、`shell.overlay` 等）与 **Conversation Node**（事件折叠 + keyed renderer，要求确定性重放）（[dsh-plugin-development SKILL.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/skills/dsh-plugin-development/SKILL.md)）。
- **事件溯源不变量："Model-visible ⟺ logged"**：凡进入模型请求的内容必须能从会话日志重建，`deriveMessages()` 从日志投影模型历史；fork/resume/transcript/telemetry 全部派生自同一条事件流，并有运行时断言（[architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)）。
- **双向适配器**：入站——`packages/hooks` 提供 Claude Code/Codex hook 桥（把外部 shell-hook 协议翻译到 dsh 类型化拦截点）；出站——subagent 接缝可经 ACP（Agent Client Protocol）把回合委派到另一个 agent 产品（[packages/hooks](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/hooks)、[packages/acp](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp)）。
- **其他能力族**：spill（工具结果溢出）、subagent（continuable provider 注册表 + 委派工具）、workflow（worker-thread 引擎 + `workflow`/`ralph` 工具）、job（后台任务 + `job_*` 工具）、guard（loop 卫生 + 工具超时）、extensions（**agent 运行时自修改：模型自己挂载/卸载插件**，见 [packages/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md)）。

### 1.3 与 Claude Code / Codex 的异同
第三方深度拆解（[deepseek-harness-deep-dive 第19章《竞品对比与生态定位》](https://github.com/xiaonancs/deepseek-harness-deep-dive/blob/main/Part%20III%20Comparative%20Analysis/19-%E7%AB%9E%E5%93%81%E5%AF%B9%E6%AF%94%E4%B8%8E%E7%94%9F%E6%80%81%E5%AE%9A%E4%BD%8D.md)）给出五维对比（dsh 侧源码可证，竞品侧社区口径）：
- **可替换性**：dsh 无特权内核、一切皆插件、`--dump-config` 逐行可换；Claude Code/Codex 扩展面在 hooks/MCP 而非换核。
- **插件模型**：dsh 用 Cordis 时空可组合 + 接缝三角色；Claude Code 用 hooks/plugins/skills，Codex 用 AGENTS.md + skills + MCP。
- **工具 schema 严格度**：dsh schema 参与提示词装配、走类型化事件，社区称严格度"超过 Codex"（仅单条评论口径）。
- **远程沙箱**：dsh 换 provider 即搬执行世界（POC）；竞品多为内建特定沙箱。
- **开放度**：dsh MIT + `dsh-plugin` topic + **官方仓库"非特权"**——CONTRIBUTING 明写"官方仓库不比社区包更重要，只是想法/示例/灵感来源"，且**暂不收外部 PR**、贡献路径改为"建插件 + 打 topic + Discussions"；另被诟病体积大（~47MB 下载/1.5GB 构建，rc.7 已开始裁剪装机面）、深度依赖 npm 供应链（Cordis 已 vendored 缓解）。国内视角见 [DeepSeek Harness 实测](https://developer.aliyun.com/article/1756625)、[10 个真实落地场景对比](https://news.qiniu.com/archives/1787048498830)。

## 2. NanmiCoder（程序员阿江）的 dsh 生态布局

- **个人画像**：程序员阿江 / Relakkes，42 个公开仓库、累计 79.4K stars（[GitHub 主页](https://github.com/NanmiCoder/NanmiCoder/blob/main/README.md)）。代表作 MediaCrawler（59k stars，小红书/抖音等爬虫）。
- **cc-haha（Claude Code Haha）**：macOS/Windows/Linux 桌面版 Claude Code 工作区（Electron + Bun + Ink + Anthropic SDK），功能含多会话工作区、分支/Worktree 启动、**Agent Teams workbench**（GUI 可视化多智能体协作：成员、任务、通信流、依赖泳道画布）、动态 Workflow 编排（模型即席写编排脚本）、视觉 SubAgent 管理器、技能市场（[README](https://github.com/NanmiCoder/cc-haha)）。
- **dsh-agent-teams**：把同一套"队长+成员"团队概念移植到 dsh 插件形态——10 个 `agent_teams_*` 工具（create / add_member / remove_member / create_task / claim_task / reassign_task / update_task / send_message / status / delete，实测于 [docs/usage.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/docs/usage.md)）、事件驱动共享任务调度器（真实 running/idle/ready 状态 + 原子领取 + attempt_id 撤销 + 冷恢复重试）、磁盘持久化（`<workspace>/.agent-teams/<teamId>/team.json` + inbox/*.jsonl 邮箱）、Web 活动面板（body-portal 浮层 + 1s 轮询读磁盘真相 + 小鲸鱼角色头像）（[README](https://github.com/NanmiCoder/dsh-agent-teams)）。
- **dsh-plugin-development Skill**：随插件仓库附赠的开源 Agent Skills 包（`npx skills add NanmiCoder/dsh-agent-teams --skill dsh-plugin-development`，[SKILL.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/skills/dsh-plugin-development/SKILL.md)），387 行执行型清单：host/client 形态判断、bundle/profile 契约、Service/函数插件、工具、HTTP、持久化、slot 四步契约、Conversation Node、双 tsc program、client 构建纯度门、Git 分发（`prepare` + `allowBuilds`）、完整验证矩阵——是目前公开可得的**最完整 dsh 插件开发实操文档**。
- **布局判断**：走的是"**多智能体团队 = 跨宿主产品理念**"路线——先在 Claude Code 生态（cc-haha 桌面）打磨 Agent Teams 概念，再借 dsh 公测红利把它插件化抢滩（dsh-agent-teams 创建早于 dsh 公测一天），并顺手把"dsh 插件开发"做成可安装 Skill 建立方法论护城河。属"生态卡位 + 方法论输出"型作者，而非单一工具深耕。

## 3. dsh 插件生态现状

- **规模与乱象**：GitHub `dsh-plugin` topic 实测 7,946 仓库；中文报道（[近6000个插件快"失控"了](https://m.163.com/dy/article_v5/L4HOORM8055674H6.html)）指出约 1/6 是换皮 UI、200 个左右能力插件、22 个"插件市场与管理器"，**官方治理缺位**（topic 任何人可自贴、无审核、Discussion 被广告攻占、普通用户不能开 Issue）。
- **生态精选与分类**：[awesome-dsh-plugin](https://github.com/Anil-matcha/awesome-dsh-plugin)（Anil-matcha，自称 curated "well over a thousand"）按 17 类整理：UI 增强、用量计费、主题皮肤、模型接入（codex-oauth、ollama、fallback 路由）、会话管理、**Memory（竞争最激烈：auto-memory、memento、negative-ledger、biomemory、dsh-memory-gate 等 10+ 方案）**、工具能力（computer-use、browser、monitor）、**Vision 桥（给无视觉能力的 DeepSeek 补眼：dsh-vision、free-vision、vision-mix 等 10+ 个）**、Skills、工作流编排（DAG 编排、任务波、plan-lattice）、通知集成（Feishu/WeChat/QQ/IM 桥）、Git 工程、安全治理（secret-guard、dsh-plugin-gate 安装扫描、dsh-gov 策略门禁+审计+配额）、领域插件（学术写作、金融、量化、PubMed）、插件市场管理器（dsh-store 550+ 收录、dsh-plugin-mall 反抢注、dsh-insight 体检）。
- **团队类插件细分市场（与本调研最相关）**：dsh-agent-teams（NanmiCoder）之外还有 **huxint/dsh-team**（[README](https://github.com/huxint/dsh-team)——2.5D 鲸鱼头套"办公室"协作室 UI、leader 权威投递、防横向循环预算 maxChainHops=4、虚拟工作区落 storageDomain，纯走能力缝零新运行时）、**toolclub/dsh-agent-team-gui**（[README](https://github.com/toolclub/dsh-agent-team-gui)——持久化多模型团队、每成员独立模型/工具策略、Settings→Teams 产品对象、有界 DAG + 重试 + 质量门 + 官方 token 用量，版本锁定 `>=0.1.0-rc.5 <0.2.0`）、alex04130/dsh-forge（跨会话邮箱+团队+插件市场）、npm 上还有 @limuyang2/dsh-agent-team、dsh-team 等多个同名实现——**"dsh 团队"已成为一个竞争中的插件子赛道**。
- **插件开发模式总结**（源自 [dsh-plugin-development SKILL.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/skills/dsh-plugin-development/SKILL.md)）：`cordis.patch.yml` 顶层数组 patch → `dsh plugin --profile web add <npm|path|github:owner/repo>` 安装 → host 半边写 Service/函数插件（`ctx.tools.register(defineTool(...))`、schema 用 value-schema DSL）、client 半边写 slot/Conversation Node → `--dump-config` 验证组合 → 验证矩阵（typecheck/build/test/verify + 真实组合 + 从零安装 + GUI）。GitHub 分发不需要发 npm（`prepare` 自构建或提交完整 lib/）。
- 生态治理类插件本身也成品类（插件门禁、体检、市场），社区在"自愈"官方治理缺位。

## 4. Agent Skills 生态

- **标准**：Anthropic 于 **2025-10-16** 发布 Agent Skills——一个含 SKILL.md（YAML frontmatter + Markdown 正文 + 可选 scripts/examples）的文件夹即一个 skill，无构建步骤、无中央审批；官方标准站点 [skill.md](https://skill.md/) / [agentskills.io](https://agentskills.io)（时间线见 [SKILLS-HISTORY.md](https://github.com/Lichens-Innovation/ai-dev-tools/blob/main/SKILLS-HISTORY.md)）。
- **行业采用**：GitHub Copilot 2025-12-18 支持（同格式，`.claude/skills` 与 `.github/skills` 互通，[changelog](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)）；Cursor 2.4（2026-01-22）集成 + 2.5（2026-02-17）把 skills 打包进 Plugins 走 Cursor Marketplace（[Cursor changelog](https://www.cursor.com/changelog/2-4)）。三大厂商对齐同一开放标准。
- **skills.sh**：开放技能目录，**无需注册**——任何公开 GitHub 仓库含 `skills/<name>/SKILL.md` 即自动被索引；安装命令 `npx skills add owner/repo --skill <name>` 或 `--all`；有安装量 leaderboard（All Time / Trending 24h / Hot）；可同时 `.claude-plugin/plugin.json` 双通道发布（[skill-factory/publishing-skills.md](https://github.com/rooftop-Owl/skill-factory/blob/main/handbook/publishing-skills.md)、[dev.to 综述](https://dev.to/nishilbhave/claude-skills-marketplace-skillssh-shipping-your-own-skill-9a5)）。
- **dsh 侧 skills 集成**：官方 `packages/skill` = skill provider 注册表 + 本地 provider + 模型可见的 catalog/loader 工具；UI 有 `/skill` 手势；社区有 dsh-skill-manager、awesome-dsh-skills（12 个过格式校验+加载冒烟测试）、dsh-ecc（273 个运营商技能移植）、oh-my-deepseek-harness（OMX 式工作流 skills）等；**dsh-plugin-development 本身就是"技能包分发"的范例**（[awesome-dsh-plugin#Skills](https://github.com/Anil-matcha/awesome-dsh-plugin)）。
- 与 Sati 的对照：Sati 的 `skills/`（SKILL.md 格式、type: role 即 agent 角色）与标准同构，缺的是 skills.sh 式分发与安装 CLI。

## 5. 类似的"agent 宿主 / agent 运行时"开源项目（重点 3 个）

- **opencode**（[anomalyco/opencode](https://github.com/anomalyco/opencode)，原 sst/opencode，dev 分支；npm `opencode-ai`；桌面版 BETA）：
  - 多智能体现状：两类 agent——**primary**（build 全权限 / plan 只读，Tab 切换）+ **subagent**（general 通用多步任务 / explore 只读代码探索 / scout 只读外部依赖调研），subagent 可由 primary 自动调用、用户 `@mention` 手动调用、或模型经 **Task tool** 调用；`permission.task` 用 glob 控制某 agent 可调哪些 subagent（`deny` 时直接从 Task tool 描述移除）（[agents.mdx](https://opencode.ai/v2/docs/agents)）。
  - **团队原语尚未落地**：PR #18753"multi-agent team coordination primitives"（DB 团队、background TaskTool + team_id、Bus.subscribe 跨会话消息、`team.max_agents` 默认 10 并发上限、崩溃级联 failed）**已关闭未合并**；[Issue #12711 "[DESIGN]: Agent Teams"](https://github.com/anomalyco/opencode/issues/12711) 仍开放——说明即使最大开源替代品，命名消息 + 多模型 + TUI 的平铺团队也仍在设计中。
- **crush**（[charmbracelet/crush](https://github.com/charmbracelet/crush)，Charm 生态，"Glamourous agentic coding for all"，Go + Bubble Tea）：
  - 定位：终端 AI 编程搭档；多模型（OpenAI/Anthropic 兼容 API）、会话管理、**LSP 增强**、**MCP 扩展（http/stdio/sse）**、全平台（macOS/Linux/Windows/Android/BSD）、nix 模块化配置；**无子代理/团队原语**，多智能体能力为零，靠 MCP 生态补（[README](https://github.com/charmbracelet/crush)）。
- **Qoder / Better Harness**（[QoderAI/better-harness](https://github.com/QoderAI/better-harness)，阿里云开源，MIT，npm `@qoder-ai/better-harness`）：
  - 这是"**harness 的 harness**"：一个跑在 10+ 个编码 agent 宿主（Claude Code / Codex Desktop/CLI / Qoder / Cursor / Copilot CLI / Qwen Code / Pi / Kimi Code / WorkBuddy / Grok）内的分析工具，用前馈（AGENTS.md/spec/Skill/验收标准）+ 反馈（lint/测试/hook/评估 agent）闭环评估 **Agent Work Loop 五维**（任务理解 / 受控执行 / 变更验证 / 可靠交付 / 经验沉淀），输出带证据标注的优先级发现报告 + 可审查修复计划（[README.zh-CN](https://github.com/QoderAI/better-harness/blob/main/README.zh-CN.md)、[IT 之家报道](https://m.ithome.com/html/982852.htm)）。
  - 启示：业界对"宿主本身"的评估/治理已产品化；Qoder 是阿里的编程平台（[百度百科](https://baike.baidu.com/item/Qoder/66330854)）。
- **横向小结**：dsh 在"可替换性/插件深度"上领先，opencode 在"agent 编排/权限细粒度"上领先但团队原语未定，crush 是轻量 MCP 生态型，Better Harness 代表"宿主治理"新品类；**"命名常驻成员 + 邮箱 + 共享任务 DAG"的平铺团队模式目前只有 dsh 生态（dsh-agent-teams/dsh-team/dsh-agent-team-gui）真正落地成产品**。

## 6. 总结

- **DSH 生态成熟度**：爆发式但不成熟。公测 5 天内 16.5 万 stars、近 8000 个 topic 仓库，但官方仍 developer preview、无 release tag、不收外部 PR、无审核机制，生态处于"高速增长 + 高度混乱"并存期；大量插件是皮肤/工具型浅层改造，深层（loop 级、持久化级）插件少；社区自组织出精选清单与治理类插件。对 Sati 的启示：**"无特权内核 + 一切皆插件 + 官方作 showcase"的姿态能撬动海量贡献，但必须以"安装门禁 + 审计 + 兼容性契约"兜底，否则生态即脏水**。
- **插件开发模式**：dsh 提供了罕见的完整工程化管线——bundle/profile 分层 patch、host/client 双面包、slot/Conversation Node 确定性 UI 接缝、`--dump-config` 可验证组合、Git 分发、以及"插件开发技能化"（SKILL.md 即文档即分发物）。这是目前开源 agent 宿主里**最系统、最可执行**的插件开发范式。
- **对 Sati 的启示（本仓库：开源专利智能体 OS，自有 agent loop / gateway / 插件系统）**：
  1. Sati 的 `src/extension/`（plugin.json + lifecycle hooks + skills + 7 种贡献点）与 dsh 的 Cordis 插件树同构，但缺"分层可覆盖配置（patch）+ 可 dump 的组合视图"；dsh 的 profile/bundle/`--dump-config` 值得直接借鉴。
  2. Sati 已具备 dsh 最骄傲的两条不变量：事件矩阵（`docs/event-producer-consumer.md`）≈ dsh 的 event map，"请求重建不变式 + Model-visible ⟺ logged"≈ dsh 的事件溯源断言——说明 Sati 架构哲学与 dsh 同向，可对照补齐 waterfall 事件语义（`agent/pre-step` 式拦截点）与"新模型可见输入必须新增 session event"的强约束。
  3. "命名成员 + 邮箱 + 依赖任务 DAG + 事件驱动调度 + attempt 撤销 + 冷恢复"的团队模式已被 dsh 生态 3-4 个插件验证为可行且需求旺盛，Sati 的 `src/agent/sub/` 子代理 + `src/task/` + `src/patent/plantask` HITL 状态机正是天然落点；专利撰写 SOP（22 阶段）可升级为"队长编排多个专利角色成员并行"的团队形态。
  4. dsh 插件开发方法论（SKILL.md 三章）可直接移植为 Sati 的"插件开发 SOP"技能；dsh 的失败教训（topic 失控、安全风险、兼容性破坏无 tag）提醒 Sati 在开放插件生态前先做安装门禁与兼容性承诺。

## 7. 5-8 条具体可借鉴设计点（每条一句话理由）

1. **能力接缝三角色化（Service Definition / Provider / Consumer）**：把 Sati 的 model/channel/fs/memory 等 provider 接缝显式拆成"接口+实现+消费方"三件套，换 provider 即可整体搬动下游消费者、无需分叉（dsh 借此一个 `ctx.fs`/`ctx.subprocess` 交换把 Bash/PTY/LSP 搬进远程沙箱）。
2. **"模型可见 ⟺ 已记录"强约束 + 新增模型可见输入必须新增日志事件**：Sati 已有请求重建对拍与事件矩阵门禁，补上"新模型可见输入未落日志即 load 期 fail-loud"即可获得 dsh 级的 fork/resume/审计同源保证。
3. **profile/bundle 分层 patch + `--dump-config` 等价物**：让 Sati 插件组合成为可打印、可逐行覆盖的有序配置层，用户不改代码即可替换任意一行（含 agent loop 本身）。
4. **注册即 effect、卸载回滚**：规定每个插件贡献（route/listener/timer/工具/UI 挂载点）都返回 disposer 并由 fiber 持有，卸载时按"停入口→等在途→关资源"顺序回滚——这是 dsh 插件可热装热卸而不污染宿主的前提。
5. **事件驱动团队调度 + attempt_id 原子撤销 + 冷恢复重试**：Sati 的 patent workflow/plantask 可直接复用 dsh-agent-teams 的"真实 running/idle/ready 状态原子领取、转派先失效旧 attempt 再等安静、重启后重试 stranded 任务"并发模型，避免迟到写入覆盖新结果。
6. **磁盘真相 + 事件流双轨 UI**：活动面板读磁盘快照（1s 轮询）+ 会话事件流各自独立职责（前者可恢复、后者可审计），Sati 的 workflow-runs/审批卡片可用同一模式降低 UI 对事件重放的强依赖。
7. **插件安装门禁 + allowBuilds 显式授权**：Git 分发默认拦截依赖构建脚本、用户显式 `allowBuilds` 后才执行——把"第三方代码在本机执行"变成可见、可审计的显式决策，预防 dsh 生态当前的供应链乱象。
8. **技能包即分发物（SKILL.md 随插件仓库发布 + `npx skills add` 安装）**：Sati 的 skills/ 已符合 Anthropic SKILL.md 标准，补一个 skills.sh 式发布/安装通道（含 leaderboard）即可让专利领域技能（撰写/检索/审稿角色）进入跨宿主复用生态。

**主要来源 URL 汇总**：[deepseek-harness 主仓库](https://github.com/deepseek-ai/deepseek-harness) · [architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) · [packages/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.md) · [AGENTS.md](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/AGENTS.md) · [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) · [dsh-agent-teams usage.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/docs/usage.md) · [dsh-plugin-development SKILL.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/skills/dsh-plugin-development/SKILL.md) · [awesome-dsh-plugin](https://github.com/Anil-matcha/awesome-dsh-plugin) · [cc-haha](https://github.com/NanmiCoder/cc-haha) · [NanmiCoder 主页](https://github.com/NanmiCoder/NanmiCoder) · [huxint/dsh-team](https://github.com/huxint/dsh-team) · [toolclub/dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) · [deepseek-harness-deep-dive 第19章](https://github.com/xiaonancs/deepseek-harness-deep-dive/blob/main/Part%20III%20Comparative%20Analysis/19-%E7%AB%9E%E5%93%81%E5%AF%B9%E6%AF%94%E4%B8%8E%E7%94%9F%E6%80%81%E5%AE%9A%E4%BD%8D.md) · [6000 插件报道](https://m.163.com/dy/article_v5/L4HOORM8055674H6.html) · [SKILLS-HISTORY](https://github.com/Lichens-Innovation/ai-dev-tools/blob/main/SKILLS-HISTORY.md) · [skill-factory publishing](https://github.com/rooftop-Owl/skill-factory/blob/main/handbook/publishing-skills.md) · [opencode agents docs](https://opencode.ai/v2/docs/agents) · [opencode team PR #18753](https://github.com/anomalyco/opencode/pull/18753) · [opencode Issue #12711](https://github.com/anomalyco/opencode/issues/12711) · [crush](https://github.com/charmbracelet/crush) · [QoderAI/better-harness](https://github.com/QoderAI/better-harness/blob/main/README.zh-CN.md)
