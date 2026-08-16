# Sati（正念智能体）

> 面向专利工程师、专利代理人、专利律师与知识产权从业者的可扩展桌面端专利智能体。

---

## 💡 关于 Sati

> **Sati，巴利语"念"——本是记忆，亦是正念。**
>
> **忆持不忘**——是知识产权的第一美德。权利生于一念，存于念念，亡于忘失。Sati 为从业者守住每一念：权利要求、审查意见、期限与法条，念念有据、时时可溯。
>
> **觉知当下**——是专业工作的最高状态。对每一份交底书、每一件对比文件保持如实觉知，不落模棱两可之见，方能"开示悟入"本有的技术真相。
>
> **正念——忆持不忘，觉知当下。**
>
> *Sati — never forgetting, fully present.*

**Sati（正念智能体）** 是一个可扩展的桌面端专利智能体，唯一目标：为专利工程师、专利代理人、专利律师与知识产权从业者，把重复的检索、撰写、比对与审查工作，变成专业而可靠的生产力。

通用 AI 助手能写代码、能问答，却常常"不懂专利"：分不清新颖性与创造性、不熟悉单独对比原则、引错法条、写出模糊的权利要求。专利业务是长周期、多项目并行、低容错的知识工作——每一念都不能失，每一步都要可追溯。

Sati 围绕专利业务的真实链路构建能力：

- **覆盖专利全流程**：技术交底书理解（PFE 三元组提取）→ 现有技术检索 → 新颖性 / 创造性分析（单独对比、三步法）→ 权利要求与说明书撰写（四领域模板、形式自检）→ 审查意见答复 → 权利要求对照图（claim-chart，要素级证据网格）→ 侵权比对（全面覆盖 + 等同原则）→ 无效宣告（逐特征证据收集、证据组合、成功率评估）→ 形式 / 充分公开 / 清楚性审查与统一质量评测。
- **内建统一专利知识底座**：以 `knowledge.db` 为单一数据源，零重新构建——专利知识图谱（21.5 万+ 节点：IPC 分类 / 判例 / 证据 / 法条，引用链可达 5 跳）、7.4 万无效复审决定与 6.9 千+ 专利判决全文检索（FTS5 trigram 全文 + 14.4 万条 bge-m3 语义向量双路召回）、法律法规全文（96 部法规条文 + 9,000+ 条目 laws-full 降级库）、1,500+ 张专利知识 wiki 卡片与 138 张审查标准卡片（IPC A–H 八部分类）——分析结论有法条、有依据、可溯源。
- **专利数据引擎**：内置 23 个专利域工具，覆盖专利检索（`patent_search`）、按号元数据（`patent_metadata`）、全球法律状态（`patent_legal_status`）、知识图谱查询（`patent_kg_query`）、判例全文检索（`patent_case_search`）、附图智能分析与检索（`analyze_patent_figure` / `search_patent_figure`）、专利 PDF 下载（`patent_pdf_download`）、权利要求对照图构建（`claim_chart_build`）、专利文书专业交付物渲染（`render_patent_document`，HTML/PDF）、化学式识别（`recognize_chemical_structure`）、工作流执行（`patent_workflow` / `patent_workflow_run`）、阶段级灵活计划（`flexible_plan`）、知识笔记沉淀（`knowledge_note_save`）等——结构化 TS 数据通道，替代"浏览器降级取数"。
- **工程化质量保障**：声明式工作流引擎（解析→检索→逐特征比对→结论→人工确认）、阶段级灵活计划（运行中增删改阶段 + 检查点回退）、人机协作计划状态机、宪法规则引擎（声明式 YAML 规则 + `rule_check` + 输出门禁）、输出门禁 HITL 审批闭环（审批门放行 + 审批卡片）、Pregel 图引擎（三性领域子图可自动执行/可降级/可评估）、原子化技术问题合规校验、权利要求对照图三关校验（要素级证据网格 + gap 检测 + 引用核验）、TRIZ 方法论组件（40 发明原理 + 39×39 矛盾矩阵查表）、权限守卫体系（`ToolGuard` 注册机制）、AgentLoop 模块化核心（8 模块拆解 + 遮蔽式压缩重放 + Web 消息投影收敛）、超大工具结果溢出存储（落盘 + 引用块取回）、LLM 重放测试与请求重建不变式（无 key 重放完整回路 + request/header 快照对拍）、durable 边界检查点与跨进程任务续算（崩溃后自动续算到完成）、工具 canonical 输出契约强制校验、事件生产者/消费者矩阵自动生成（`--check` 门禁）、法条引用自动核验、风险表述免责与审批挂起等质量门禁，降低"看起来专业、实则出错"的风险。
- **可扩展，随业务生长**：27 个专利技能（其中 10 个专家角色可作为子代理被调度，另有 4 个内置通用子代理预设）、23 个专利域内置工具 + 免费无 key 学术论文检索（arXiv / OpenAlex / Semantic Scholar / Crossref 四源）、原生支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)、多模态模型路由与 DeepSeek / Kimi / GLM / MiniMax / Qwen 等国产模型开箱即用，技能与工具可随团队的审查实践持续沉淀。


## 📦 安装与快速开始

我们提供了 macOS/Linux 与 Windows PowerShell 下的一键安装脚本，以及适合开发者的源码启动方式。

### 方式一：一键安装 (推荐, macOS/Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/xujian519/sati/main/install.sh | bash
```

该脚本会检查/使用受支持的 Node.js 运行时（22.13+，内置 SQLite 运行时所需）、克隆代码、安装依赖并编译前端。在 Linux 上，如果存在 `sudo` 和支持的包管理器，脚本可安装缺失的系统依赖；在 macOS 上，请先确保 Xcode Command Line Tools 以及带 `distutils` 的 Python 可用。安装完成后，直接运行：

如果所在网络下载 Node.js 或 npm 依赖较慢、连接不稳定，可以在运行安装器时指定国内镜像：

```bash
curl -fsSL https://raw.githubusercontent.com/xujian519/sati/main/install.sh | \
  SATI_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node \
  NPM_CONFIG_REGISTRY=https://registry.npmmirror.com bash
```

如果希望优先使用官方 Node.js 下载地址，也可以通过 `SATI_NODE_DIST_FALLBACK_MIRRORS` 显式设置一个或多个可信的备用镜像。

```bash
sati            # 在 http://localhost:3001 启动服务
sati status     # 查看运行状态
```

之后如果想在 macOS / Linux 上再次打开 Sati，请在终端运行 `sati`，然后在浏览器中打开终端打印的地址。如果当前 shell 还没有刷新 PATH，请新开一个终端，或先 source 对应的 shell 配置文件。

```bash
sati
# 然后打开 http://localhost:3001，或命令打印的地址
```

### 方式一补充：一键安装 (Windows PowerShell)

在普通用户 PowerShell 中执行：

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/xujian519/sati/main/install.ps1 | iex"
```

PowerShell 安装脚本会使用 `%USERPROFILE%\.sati` 下的 Windows 原生路径，检查 Node.js 22.13+ 与 `node:sqlite`，在可用时通过 `winget` 安装缺失依赖，构建 Sati，并在 `%USERPROFILE%\.sati\bin` 生成 `sati.cmd` 启动器。Git LFS 媒体资源对核心功能是可选的；如果 Git LFS 不可用或下载超时，安装脚本会跳过演示视频/GIF 并继续安装。

安装完成后，脚本会启动 Sati 并打印 UI 地址，通常是 `http://localhost:3001`。脚本不会自动打开浏览器，请把该地址复制到浏览器中完成初始化配置（Provider + API key）。也可以在 PowerShell 中打开：

```powershell
Start-Process http://localhost:3001
```

如果脚本刚刚更新了用户 `PATH`，请新开一个 PowerShell 窗口后运行：

```powershell
sati            # 在 http://localhost:3001 启动服务
sati status     # 查看运行状态
```

之后如果想再次打开 Sati，请在新的 PowerShell 窗口运行 `sati`，然后在浏览器中打开终端打印的地址。如果当前窗口还识别不到 `sati`，可以直接运行启动器：

```powershell
& "$HOME\.sati\bin\sati.cmd"
```

#### Windows PowerShell FAQ

**首次运行 `npm run dev` 报错：`npm.ps1` 因系统禁止运行脚本而无法加载**

这个问题现在仍可能出现：当你在 Windows PowerShell 中直接运行 `npm run dev` 等开发命令时，PowerShell 可能优先解析到 `npm.ps1`，而默认执行策略会阻止该脚本。

对当前用户设置一次执行策略，然后重新打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

如果不想修改用户执行策略，也可以显式调用 cmd shim：

```powershell
npm.cmd run dev
```

**原生依赖构建失败（提示 `node-gyp`、`MSBuild` 或 Python 缺失）**

安装脚本通常会使用 `node-pty`、`better-sqlite3`、`bcrypt`、`sharp` 等原生依赖的预编译包。全新的 Windows 机器上，如果 npm 无法下载匹配的预编译包并回退到源码编译，请先安装带 C++ 工作负载的 Visual Studio Build Tools 和 Python，然后重新运行安装脚本。

**下载 `install.ps1` 时 GitHub 返回 `429: Too Many Requests`**

共享网络下频繁访问 `raw.githubusercontent.com` 可能触发 GitHub 限流。请等待几分钟后重新运行一键安装命令，或从仓库下载 `install.ps1` 后用 `powershell -ExecutionPolicy Bypass -File .\install.ps1` 本地执行。

### 方式二：源码启动 (适合开发者)

> 需要按平台安装依赖的命令？请查看[源码安装指南](./README_SOURCE_INSTALL.md)。

**1. 克隆代码与安装依赖**

> 源码安装默认跳过 Git LFS 管理的大型演示媒体文件，以保持安装轻量。如果之后需要演示视频/GIF，可在克隆后运行 `git lfs pull` 下载。

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/xujian519/sati.git
cd Sati

node --version          # 必须为 v22.13.0 或更新版本
corepack enable         # 启用 package.json 中固定的 pnpm 版本
corepack pnpm install --frozen-lockfile
```

Sati 使用仓库提交的 `pnpm-lock.yaml` 保证源码安装可复现。请优先使用上面的 `corepack pnpm ...`，不要改用 `npm install`；在 macOS 上，这也能减少原生依赖不必要地回退到源码编译的概率。

**2. 配置模型 Provider**
Sati 依赖 `~/.sati/sati.yaml` 进行配置。您可以手动创建、运行启动脚本自动生成，**或者在启动 Web UI 后直接在设置界面中进行可视化配置**。
支持 OpenAI、Anthropic、原生 Google Gemini、DeepSeek、Qwen、Kimi、MiniMax 等多种协议。

如果本机还没有配置文件，生产模式启动前请先准备 Web UI 的首次 onboarding 流程：

```bash
node scripts/bootstrap-sati-config.mjs
```

该命令会初始化 `~/.sati/sati.yaml`，让 Gateway 可以启动并进入首次 onboarding。随后打开 Web UI，在 onboarding/设置面板中完成 Provider 和 API Key 配置。

```yaml
schemaVersion: 1
agent:
  model: deepseek/deepseek-v4-pro
model:
  providers:
    deepseek:
      protocol: openai
      url: https://api.deepseek.com/v1
      apiKey: sk-your-api-key
```

原生 Gemini 可以使用 `protocol: google`：

```yaml
schemaVersion: 1
agent:
  model: google/gemini-3.1-pro-preview
model:
  providers:
    google:
      protocol: google
      url: https://generativelanguage.googleapis.com
      apiKey: ${GEMINI_API_KEY}
      models:
        gemini-3.1-pro-preview: {}
```

**3. 启动服务**

```bash
pnpm dev          # 开发模式（HMR），访问 http://localhost:5173
# 或
pnpm server       # 生产模式，访问 http://localhost:3001
```

> 也可进入 `ui/` 目录单独启动前端（`cd ui && pnpm dev`）。

---

## 🖥️ 桌面端

Sati 提供 Electron 桌面壳（`apps/desktop/`），当前维护 **macOS（DMG，arm64）** 与 **Windows（NSIS exe，x64/arm64）** 双平台构建与发布（mac 走 `apps/desktop/scripts/release.sh` 签名 + 公证，win 走 `build-win.bat`）；Linux 桌面端不维护。

桌面端内置 node/bun 运行时与三件套 bundle（sati-main / satiui / sati-memory-core），启动时自动拉起本地 Gateway 服务，支持自动更新（`release(desktop)` 版本与根 `package.json` 由 `scripts/bump-version.mjs` 同步维护）。macOS 专属行为（应用菜单 / About 面板 / Dock / 关闭即隐藏）在 Windows 上不可用。

## 🛠️ 扩展与插件 (Extension Protocol)

Sati 采用开放的插件架构，插件代码与开源核心严格隔离。开发者可以通过 `plugin.json` 轻松扩展系统能力：

- **MCP Servers**: 原生支持集成 Model Context Protocol 服务器。
- **Tools & Skills**: 注册自定义工具，或通过 [ClawHub](https://www.npmjs.com/package/clawhub) 引入社区 Skill。
- **Lifecycle Hooks**: 拦截 `PreToolUse`、`UserPromptSubmit` 等关键生命周期。
- **Custom Memory**: 允许接入自定义的记忆存储 Provider。

---

## 📌 版本状态与已知限制

**当前版本：0.1.0（Beta 测试版）**。Sati 的功能面已基本成型（专利全流程 + 统一知识底座 + 桌面端 + IM 渠道），本版本宣告进入公开测试阶段；后续版本聚焦细节打磨与稳定性增强。

**已知限制（截至 0.1.0）**：

- **桌面端平台**：仅维护 macOS（arm64 DMG）与 Windows（x64/arm64 NSIS）；Linux 桌面端不维护（可用 CLI / 源码方式）。
- **专利数据通道**：外部数据源（如全球法律状态、在线检索）依赖网络与上游服务，网络不可达时相关工具可能返回降级结果或失败。
- **依赖安全**：`pnpm audit` 剩余 1 条告警（`extract-zip`，仅 Electron 安装期依赖，无可用修复版本，不触及生产运行时）。
- **测试覆盖**：专利 / 工具 / 知识域覆盖较深，个别模块（browser / lifecycle / fs / status）测试较薄，持续补齐中。
- **工程欠账**：存在少量超大文件与 `any` 类型逃逸（详见 `docs/technical-debt-report.md`），作为持续工程逐批治理，不影响核心功能。

> Sati 为开源软件（AGPL-3.0），按"现状"提供；专利分析结论仅供专业参考，正式法律意见请由执业人员复核。

---

## 📄 许可证

本项目基于 [GNU Affero General Public License v3.0](LICENSE) 开源。

## 🙏 Acknowledgements

Sati 源自 [PilotDeck](https://github.com/OpenBMB/PilotDeck)（最初为 [Gucc111/PilotDeck](https://github.com/Gucc111/PilotDeck)，后由清华大学 THUNLP 实验室、面壁智能、OpenBMB 与 AI9Stars 联合研发并开源，AGPL-3.0）。Sati 在其基础上聚焦专利业务场景独立发展。
