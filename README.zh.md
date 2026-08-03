<p align="center">
  <img src="assets/banner.png" alt="Sati" width="680"/>
</p>

<p align="center">
  面向专利工程师、专利代理人、专利律师与知识产权从业者的可扩展桌面端专利智能体。
</p>

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

- **覆盖专利全流程**：技术交底书理解（PFE 三元组提取）→ 现有技术检索 → 新颖性 / 创造性分析（单独对比、三步法）→ 权利要求与说明书撰写（四领域模板、形式自检）→ 审查意见答复 → 侵权比对（全面覆盖 + 等同原则）→ 无效宣告（证据组合、成功率评估）→ 形式 / 充分公开 / 清楚性审查与统一质量评测。
- **内建专利知识底座**：IPC A–H 八部分类与 138 条审查标准、1500+ 张专利知识卡片、专利知识图谱（引用链可达 5 跳）、9000+ 部法律法规全文检索——分析结论有法条、有依据、可溯源。
- **工程化质量保障**：声明式五阶段工作流（解析→检索→逐特征比对→结论→人工确认）、人机协作计划状态机、法条引用自动核验、风险表述免责与审批挂起等质量门禁，降低"看起来专业、实则出错"的风险。
- **可扩展，随业务生长**：23 个专利技能（其中 9 个专家角色可作为子代理被调度）、7 个内置专利工具、原生支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)，技能与工具可随团队的审查实践持续沉淀。

Sati 以「WorkSpace」为基本单位，将文件、记忆、技能在项目级别完整隔离与沉淀，配套 **白盒记忆**、**智能路由**、**Always-on** 三大能力，跨前端（Web / CLI / IM）行为一致——只为让知识产权从业者，在长周期的多项目并行中，守住每一念。


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
cd ui && npm run dev     # 开发模式 (HMR)，访问 http://localhost:5173
# 或
cd ui && npm run start   # 生产模式，访问 http://localhost:3001
```

---

## 🛠️ 扩展与插件 (Extension Protocol)

Sati 采用开放的插件架构，插件代码与开源核心严格隔离。开发者可以通过 `plugin.json` 轻松扩展系统能力：

- **MCP Servers**: 原生支持集成 Model Context Protocol 服务器。
- **Tools & Skills**: 注册自定义工具，或通过 [ClawHub](https://www.npmjs.com/package/clawhub) 引入社区 Skill。
- **Lifecycle Hooks**: 拦截 `PreToolUse`、`UserPromptSubmit` 等关键生命周期。
- **Custom Memory**: 允许接入自定义的记忆存储 Provider。

---


## 📄 许可证

本项目基于 [GNU Affero General Public License v3.0](LICENSE) 开源。

## 🙏 Acknowledgements

Sati 源自 [PilotDeck](https://github.com/OpenBMB/PilotDeck)（最初为 [Gucc111/PilotDeck](https://github.com/Gucc111/PilotDeck)，后由清华大学 THUNLP 实验室、面壁智能、OpenBMB 与 AI9Stars 联合研发并开源，AGPL-3.0）。Sati 在其基础上聚焦专利业务场景独立发展。
