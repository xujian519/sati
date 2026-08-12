# 跨平台浏览器自动化备选与级联降级方案（2026-08）

> 背景：当前项目的主力浏览器自动化方案 ego lite（ego-browser）仅支持 macOS，Windows/Linux 用户无法使用；
> 即便是 macOS 用户，也可能遇到 ego lite 未安装、版本不兼容、CLI 进程挂死、企业安全策略限制闭源 App
> 安装等实际问题，同样需要一条可用的降级路径。
>
> 本文档研究 `browser-use`（Python，MIT）与 `BrowserOS neo`（Chromium fork，AGPL-3.0）作为 **全平台**
> 的备选技术栈，并给出「ego lite 优先 → BrowserOS neo → browser-use → @playwright/mcp 兜底」的统一级联策略，
> 以及配套的集成建议、迁移路径、风险评估与验收标准。
>
> Windows/Linux：备选 1/2/3 依次降级，无 ego 环节。
> macOS：先试 ego，失败（未装/不可达/doctor 探针不通）立即走备选链，避免用户被硬门禁阻塞。

---

## 1. 项目现状（基线）

### 1.1 当前浏览器自动化四层架构

```
┌─ 技能文档层 ────────────────────────────────────────────────┐
│ skills/**/SKILL.md（20+ 专利技能统一指引 ego_browser 优先）  │
├─ 内置工具层 ────────────────────────────────────────────────┤
│ ego_browser（通用脚本透传，src/tool/builtin/egoBrowser.ts） │
│ patent_pdf_download（下载拦截批量下载）                      │
│ → 共用 egoSession 统一执行封装                               │
├─ 既有数据通道 ──────────────────────────────────────────────┤
│ vendor/nuo-patent ego-browser.ts（反爬抓取，独立实现）       │
│ skills/patent-download/scripts/download_patent_ego.py       │
├─ 外部依赖 ──────────────────────────────────────────────────┤
│ ego lite app（闭源，macOS）→ ego-browser CLI → CDP          │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 现有核心代码位置

| 模块 | 文件 | 作用 |
|------|------|------|
| ego 内置工具 | [egoBrowser.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/egoBrowser.ts) | 定义 `ego_browser` 工具：输入校验 / 可用性检查 / 脚本执行 / 错误语义 |
| ego 会话封装 | [egoSession.ts](file:///Users/xujian/projects/Sati/src/patent/data/nuo/egoSession.ts) | 统一 CLI 调用：PATH 注入 / heredoc 构造 / 输出截断 / 结构化结果解析 / taskSpace 命名 |
| 专利下载工具 | [patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts) | 基于 egoSession 的下载拦截 + 录屏留证 |
| 现有 MCP 插件 | [plugin.json](file:///Users/xujian/projects/Sati/src/extension/plugins/builtin/browser-use/plugin.json) | **已有** `@playwright/mcp` 内置插件（跨平台可用，但无登录态与高级能力） |
| 集成设计文档 | [ego-lite-integration.md](file:///Users/xujian/projects/Sati/docs/ego-lite-integration.md) | ego × Sati 四层架构、版本追踪、能力映射 |

### 1.3 ego lite 能力清单（对照基线）

迁移时这些能力需要在备选方案上对齐或降级：

- ✅ 任务空间隔离（task space）+ 继承用户登录态（核心价值）
- ✅ 快照/定位器（snapshotText / @N ref / loc=...）
- ✅ 下载拦截（`page.waitForEvent("download")`）
- ✅ 站点经验包 learnings（`site.runTool(...)`）
- ✅ screencast 录屏留证
- ✅ `--doctor` 连接诊断与 `--reload`
- ✅ 多 space 并行（Promise.all 层级）
- ⚠️ 进度事件流（部分实现）

### 1.4 平台门禁现状

[egoSession.ts#L107-L124](file:///Users/xujian/projects/Sati/src/patent/data/nuo/egoSession.ts#L107-L124) 中已实现硬门禁：

```typescript
checkAvailability(env?: NodeJS.ProcessEnv): EgoAvailability {
  if (this.platform !== "darwin") {
    return { ok: false, code: "unavailable", reason: "ego-browser (ego lite) only supports macOS." };
  }
  // ... CLI 可执行性探测
}
```

目前实现的是「平台硬门禁」：Windows/Linux 直接返回 `unavailable`，但 macOS 侧一旦 ego lite
本机不可用（用户没装、CLI 版本落后、app 未启动或卡死、~/.local/bin 不在 PATH 等），agent 同样拿不到
可用浏览器，没有自动降级路径。

### 1.5 macOS 上同样需要备选的典型场景

ego lite 虽然是 macOS 的首选，但在以下情境下也会失效，备选方案可立即顶上：

| # | macOS 场景 | 触发概率 | 用户体感 |
|---|-----------|----------|----------|
| M1 | 全新机器未安装 ego lite（或装了但没完成首次 onboarding，`ego-browser` CLI 未注册到 PATH） | 高 | `ego-browser CLI not found`，任务直接失败 |
| M2 | 企业安全策略：禁止安装未签名/未经 MDM 白名单的第三方闭源桌面 App（ego lite 目前走独立签名不是 MAS） | 中高 | 同上；且用户没有绕过路径 |
| M3 | ego lite app 更新后 CLI 接口不兼容（例：CLI 0.4.5.8 → 0.4.6.x 之间 `page` facade 曾不可用；参见 [ego-lite-integration.md](file:///Users/xujian/projects/Sati/docs/ego-lite-integration.md#L39-L43) 版本追踪部分） | 中 | `cliLog` 输出异常或 helper 不存在，脚本运行时错误 |
| M4 | `doctorCheck=true` 探针失败：ego lite GUI 未启动或 Native Messaging 管道挂死（常见于休眠唤醒后） | 中 | 用户已装 App 但浏览器会话起不来 |
| M5 | 录屏回放 + 证据审计需求：ego lite 只有 `page.screencast` 输出 mp4 文件，没有 scrubbable 时间线 + 操作步骤列表 UI，难以满足专利案件留证与事后复盘 | 中 | 人工下载/截图补证，效率低 |
| M6 | 登录态冲突：ego lite 的任务空间默认继承 App 登录态，但若用户需要在不污染自己日常浏览会话的前提下跑独立 agent（例如批量下载、第三方账号登录），BrowserOS neo「第二浏览器」物理隔离反而更合适 | 中低 | 需要手动登出再登录，风险高 |
| M7 | 站点经验包 learnings 与 ego app 版本强绑定，升级/降级都受限；browser-use 的开源脚本更易自行改造 | 低 | 站点改版后升级慢，等 ego 官方发版 |

这些场景与 Windows/Linux 的「ego 完全不可用」在最终症状上一致——**agent 无法完成浏览器任务**。
因此，在 macOS 上同样需要「ego → BrowserOS neo / browser-use → Playwright」的级联退路，
而不是只给 macOS 留一条 ego 单行道。

---

## 2. 备选技术栈 A：browser-use（Python · MIT）

### 2.1 项目速览

| 维度 | 说明 |
|------|------|
| 仓库 | https://github.com/browser-use/browser-use |
| 语言 | Python >= 3.11（底层 `cdp-use` + Playwright 生态） |
| 协议 | **MIT**（商业友好，无传染性） |
| 平台 | ✅ macOS / ✅ Windows / ✅ Linux |
| 最新版本 | v0.13.7（2026-07） |
| Stars | 开源社区活跃，336 贡献者，2.8K 依赖者 |
| Odysseys 榜单 | **#1**（87.4%，领先 OpenAI/Anthropic/Google/Microsoft 官方方案） |

### 2.2 三层使用方式（Sati 可选路径）

```
┌─ Python Agent 库（最高级，带 Agent Loop）────────────────┐
│ Agent(task="...", llm=ChatBrowserUse()).run()            │
│ 适合：把浏览器自动化整个外包给 browser-use 的自主 agent   │
├─ CLI（中等粒度，后台 daemon 常驻）────────────────────────┤
│ browser-use open <url> → state → click 5 → input 3 txt  │
│ 适合：Sati 通过 bash 工具逐条调用，~50ms/次低延迟         │
├─ MCP Server（最契合 Sati 现有架构）──────────────────────┤
│ uvx browser-use --cli-mcp （stdio transport）            │
│ 适合：与 Sati 现有 MCP runtime 直连，复用 PluginToToolBridge │
└──────────────────────────────────────────────────────────┘
```

### 2.3 登录态继承（对齐 ego 核心价值）

browser-use 提供三种接入已登录浏览器的方式：

| 模式 | 命令 | 说明 |
|------|------|------|
| 连接已开 Chrome | `browser-use connect` | 要求 Chrome 启 `--remote-debugging-port=9222`，然后复用其全部 cookie/扩展 |
| 指定 Profile 启动 | `browser-use --profile "Default" open <url>` | 读真实 Chrome Profile 目录，启动独立 Chromium 实例，继承 cookie+登录+扩展 |
| 云端浏览器 | `browser-use cloud connect` | 付费 Browser Use Cloud，代理轮换 + 反爬指纹 + 云端持久 profile |

> **Sati Windows 用户推荐模式**：`--profile "Default"`，无需用户手动改 Chrome 启动参数，体验最接近 ego lite。

### 2.4 CLI 完整能力清单（与 ego helper 对照）

| 能力 | browser-use CLI | ego lite helper |
|------|-----------------|-----------------|
| 导航 | `open`, `back`, `tab new/switch/close/list` | `openOrReuseTab`, `gotoAndWait` |
| 元素快照 | `state`（返回可点击元素 + 索引） | `snapshotText`（@N refs） |
| 点击 | `click <index>` 或 `click <x> <y>` | `click('@N' \| css \| loc=...)` |
| 输入 | `input <index> "text"`, `type "text"`, `keys "Enter"` | `fillInput`, `typeText`, `pressKey` |
| 滚动 | `scroll down --amount N` | `scrollBy` |
| JS 执行 | `eval "(() => {...})()"` | `js('...')` |
| 等待 | `wait selector "css"`, `wait text "..."` | 脚本内 `wait(5)` + `page.waitForLoadState` |
| 截图 | `screenshot path.png --full` | `page.screenshot({ path })` |
| 文件上传 | `upload <index> <path>` | `uploadFile` |
| 下载拦截 | 通过 `eval` + CDP 或 Python 库层 | `page.waitForEvent("download")` |
| Cookies | `cookies get/set/clear/export/import` | 间接通过 CDP |
| 录屏留证 | 需 `[video]` extra 依赖（imageio+ffmpeg） | `page.screencast.start/stop` |
| 多会话 | `--session NAME` + `sessions` / `close --all` | task space 名称隔离 |
| 诊断 | `doctor`, `setup`, `config list/set/get` | `--doctor`, `--reload` |

### 2.5 MCP Server 集成方式（Sati 推荐）

browser-use 已原生发布 MCP registry 注册包：

```json
{
  "name": "com.browser-use/browser-use",
  "packages": [{
    "registryType": "pypi",
    "identifier": "browser-use",
    "runtimeHint": "uvx",
    "packageArguments": [{ "type": "positional", "value": "--cli-mcp" }],
    "transport": { "type": "stdio" }
  }]
}
```

Sati 侧只需新增一份 MCP 插件清单（类似现有 `@playwright/mcp` 插件）：

```json
{
  "name": "browser-use-python",
  "version": "1.0.0",
  "description": "Browser automation by browser-use (Python, cross-platform with Chrome profile support)",
  "mcpServers": {
    "browser-use-python": {
      "command": "uvx",
      "args": ["browser-use", "--cli-mcp"],
      "perSession": true
    }
  }
}
```

### 2.6 环境依赖（Windows）

```powershell
# 1. 安装 Python >= 3.11 + uv
winget install Python.Python.3.12
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 2. 安装 browser-use + Chromium
uv tool install browser-use
uvx browser-use install    # 下载受管 Chromium

# 3. 可选：连接真实 Chrome profile（继承登录态）
uvx browser-use profile list
uvx browser-use --profile "Default" open https://example.com
```

### 2.7 优势与劣势

**优势：**
- MIT 协议，商业无风险
- 全平台一致（Windows/macOS/Linux 同一套 CLI + MCP）
- CLI 粒度与 ego `nodejs heredoc` 接近，Sati 技能层 prompt 改写量最小
- 提供 Python Agent 库 + CLI + MCP 三种接入方式，灵活度高
- 基准测试排名领先，社区迭代快
- 与 Sati 现有 `@playwright/mcp` 插件在 MCP 层同构，只需新增 plugin.json

**劣势：**
- 录屏留证需要额外装 `[video]` 依赖（imageio+ffmpeg），不是默认能力
- 下载拦截在 CLI 层没有直接命令，需走 `eval(CDP)` 或在 Python 库层封装
- 站点经验包 learnings 体系与 ego lite 不同套，需要重新适配
- Windows 上 `uvx` 冷启动比 macOS 上的 ego-browser 原生 CLI 慢 ~200-500ms

---

## 3. 备选技术栈 B：BrowserOS neo（Chromium fork · AGPL-3.0）

### 3.1 项目速览

| 维度 | 说明 |
|------|------|
| 仓库 | https://github.com/browseros-ai/BrowserOS |
| 构成 | 双产品同仓：① BrowserOS（人类用的 AI 浏览器）② **BrowserOS neo**（agent 专用第二浏览器） |
| 语言 | 主体 Chromium fork（C++） + Agent 平台（Rust claw-server + Bun/TypeScript + Go CLI） |
| 协议 | **AGPL-3.0** + Ungoogled Chromium 附加条款（**协议传染性风险，见 3.6**） |
| 平台 | BrowserOS neo：✅ macOS / ✅ Windows / ❌ Linux；BrowserOS：三端全有 |
| Stars | ~12K GitHub stars |

### 3.2 BrowserOS neo 架构（重点，Windows 可用）

```
┌─ BrowserOS neo App（用户安装的桌面程序）────────────────────┐
│  ┌─ Chromium fork（从 Chrome 一键导入登录态/书签/扩展）    │
│  ┌─ claw-server-rust（MCP HTTP Server: 127.0.0.1:9010/mcp）│
│  └─ claw-app（新标签页仪表盘：实时看 agent 操作 + 回放）    │
└──────────────────────────────────────────────────────────────┘
              ▲ Streamable HTTP（MCP 2025-06-18 spec）
              │
┌─ Sati MCP Runtime ──────────────────────────────────────────┐
│  createMCPClient({ transport: { type: 'http', url: '...' } })│
└──────────────────────────────────────────────────────────────┘
```

### 3.3 一键连接体验

1. 用户安装 `BrowserOS_installer.exe`（Windows 版，官网直下）
2. 首次启动 → 「从 Chrome 导入」（勾选密码/书签/扩展/设置）
3. 新标签页点击 **MCP** → 复制 endpoint：`http://127.0.0.1:9010/mcp`
4. BrowserOS neo 后台识别已安装的 Claude Code / Codex / Cursor / VS Code 并**一键写 config**

对 Sati 的意义：**用户在 BrowserOS neo UI 里点一下「Connect」旁边的自定义按钮，
Sati 可以自动读取其写入标准化 MCP 配置文件（或 Sati 提供 UI 粘贴 endpoint URL）。**

### 3.4 MCP 工具能力（53+ 浏览器工具 + 40+ App 集成）

| 分类 | BrowserOS neo MCP 工具 | 对应 ego 能力 |
|------|------------------------|---------------|
| Tab 管理 | `new_page`, `new_hidden_page`, `close_page`, `list_pages`, `show_page`, `get_active_page`, `move_page` | task space + tab 管理 |
| 导航 | `navigate_page`（含 back/forward/reload） | `openOrReuseTab`, `gotoAndWait` |
| 快照 | `take_snapshot`, `take_enhanced_snapshot` | `snapshotText` |
| 内容提取 | `get_page_content`(Markdown), `get_dom`, `get_page_links`, `search_dom` | `js(...)` 手写提取 |
| 交互 | `click`, `click_at`, `fill`, `clear`, `hover`, `drag`, `press_key`, `check`, `uncheck`, `select_option`, `focus`, `scroll`, `upload_file` | `click`, `fillInput`, `typeText` 等 |
| 文件导出 | `take_screenshot`, `save_screenshot`, `save_pdf`, **`download_file`** | `page.screenshot`, `page.waitForEvent("download")` ✅ |
| 窗口管理 | `list_windows`, `create_window`, `create_hidden_window`, `close_window`, `activate_window` | 无对应（ego 无多窗） |
| Tab Groups | `list_tab_groups`, `group_tabs`, `update_tab_group`, `ungroup_tabs`, `close_tab_group` | 无对应 |
| 书签/历史 | `get_bookmarks`, `create_bookmark`, `search_bookmarks`, `search_history`, `get_recent_history` | 无对应 |
| JS 执行 | `evaluate_script` | `js(...)` |
| Cookies | 通过 `evaluate_script` 或 App 集成侧管理 | `cookies get/set` |
| **录屏回放** | **内建：会话自动保存为可 scrub 视频 + 步骤时间线** ✅ | `page.screencast`（但 BrowserOS 回放 UI 完整体验更好） |
| 反爬/指纹 | 用户真实本机 IP + 日常使用的 Chrome profile，最低封禁率 | 同（真实浏览器） |
| 40+ App 集成 | Gmail / Slack / GitHub / Notion / Calendar 等，通过单 MCP 连接暴露 | 无对应（ego 只有浏览器） |

### 3.5 核心差异化能力（比 ego lite 更强的地方）

1. **登录态导入完整体验**：从 Chrome 一键迁移（密码/扩展/设置/书签），无需 `--remote-debugging-port`，Windows 用户零门槛
2. **实时仪表盘 + 视频回放**：每个 agent 会话自动录屏，像视频播放器一样 scrub 回看，对专利证据留证是刚需级提升
3. **并行 agent tabs**：多个 agent 同时跑，每个 agent 一个 tab，用户肉眼监控进度；ego lite 多 space 是 headless 不可见
4. **Token 消耗显著更低**：官方宣称对比同类方案 token 用量大幅减少（snapshot 语义压缩更好）
5. **40+ App MCP 集成单点暴露**：连 BrowserOS neo 一次，同时拿到 Gmail/Slack/GitHub 等外部工具能力

### 3.6 协议风险（AGPL-3.0）—— ⚠️ 必须评估

BrowserOS 主仓的 BrowserOS 本体（Chromium fork + claw-server-rust + Bun agent loop）
使用 **AGPL-3.0** 许可。AGPL-3.0 的传染性边界：

| 使用方式 | 是否触发开源义务 |
|----------|------------------|
| 用户安装 BrowserOS neo **桌面 App**，Sati **通过 MCP HTTP 调用其公开接口** | ❌ 网络服务调用不触发；AGPL 传染性仅在「修改代码 + 向第三方提供服务」时触发。Sati 作为调用方不改 BrowserOS 源码，没有开源义务（这与 MongoDB AGPL、Elastic AGPL 的使用边界一致）。 |
| Sati 代码库中**复制/链接** BrowserOS 源码（例如把 claw-server-rust 嵌入 Sati 发行包） | ✅ **触发**：Sati 整体需按 AGPL-3.0 开源。严禁这种集成方式。 |
| Sati 文档中**指引用户**自行下载安装 BrowserOS 官方安装包 | ❌ 不触发，等同「用户装 Chrome、Sati 调 CDP」。 |

> **结论**：如果 Sati 只把 BrowserOS neo 当作「用户自选安装的外部浏览器应用」，通过 MCP 标准协议调用，
> 不分发其二进制、不修改其源码，则**协议风险可控**。但仍建议法务侧做最终确认。

### 3.7 优势与劣势

**优势：**
- 登录态继承体验最接近（甚至超越）ego lite：Chrome 一键导入，Windows 用户零配置
- 录屏留证 + 回放 UI 是完整产品级能力，专利场景刚需
- MCP 工具 53+，覆盖率远超 browser-use CLI 和 ego lite（窗口管理/Tab Groups/书签/历史都是现成能力）
- HTTP MCP endpoint（不是 stdio），跨进程调用更健壮，Sati 崩溃不连带浏览器
- 真实本机 IP + 完整 Chrome profile，反爬封禁率最低

**劣势：**
- **AGPL-3.0 协议**：需要公司/项目层面确认（Sati 是私有代码仓，需要确认不触发传染性）
- BrowserOS neo Linux 不支持（只 macOS + Windows）；若未来有 Linux 需求需切换到 BrowserOS 本体
- Windows 首次安装包体积大（完整 Chromium fork ~300MB）
- 本地端口占用：默认 `9010`（neo）或 `9239`（BrowserOS 本体），需冲突检测
- 不是 Sati 同技术栈（TypeScript），排查 BrowserOS 问题需要跨团队

---

## 4. 三方技术栈矩阵对比

| 维度 | ego lite（现态·macOS） | browser-use（备选 A） | BrowserOS neo（备选 B） | @playwright/mcp（已有·兜底） |
|------|------------------------|----------------------|------------------------|-----------------------------|
| **平台** | macOS 仅 | Win/macOS/Linux | Win/macOS | Win/macOS/Linux |
| **协议** | 闭源商业 | MIT ✅ | AGPL-3.0 ⚠️ | MIT |
| **登录态继承** | ✅ 原生最佳 | ✅ `--profile` 或 connect | ✅ Chrome 一键导入 | ❌ 默认无（需手动 profile path） |
| **真实浏览器指纹** | ✅ | ✅（connect/profile） | ✅ | ❌（纯净 Chromium，易被封） |
| **任务空间隔离** | ✅ task space | ✅ `--session` | ✅ 多 tabs/windows | ⚠️ MCP 实例即浏览器，perSession 即隔离 |
| **下载拦截** | ✅ `waitForEvent(download)` | ⚠️ 需 eval(CDP) 封装 | ✅ `download_file` | ⚠️ 无独立工具；经 `browser_run_code_unsafe` 可拦截（RCE 等价，需启用 unsafe caps）|
| **录屏留证** | ✅ `screencast` | ⚠️ 需装 video 依赖 | ✅ **自动 + 回放 UI** ✨ | ✅ `browser_start/stop_video` |
| **元素快照** | ✅ `snapshotText` @N | ✅ `state` index | ✅ `take_snapshot` + enhanced | ✅ `browser_snapshot` a11y refs |
| **站点经验包** | ✅ learnings + `site.runTool` | ❌ 需自行在 Sati 层封装 | ❌ 无对应（有 40+ App 集成补位） | ❌ |
| **会话级复用** | ✅ taskSpaceName 跨调用 | ✅ daemon 常驻 | ✅ 完整 profile 持久 | ✅ perSession MCP 实例 |
| **集成复杂度** | 低（已做） | **中低**（MCP 插件 + 小封装） | **中**（HTTP MCP + endpoint UI + 协议评审） | 极低（已做） |
| **反爬能力** | ✅✨ | ✅ | ✅✨ | ❌ |
| **Windows 用户门槛** | ❌ 完全不能用 | 低（装 Python + uv + 一条命令） | 极低（装 exe，点导入） | 低（Sati `install:browser`） |
| **Sati 发行包增量** | 外部 App，0 | Python/uv 可选（或 Sati 脚本装） | 外部 App，0 | 已有（~300MB Chromium 下载可选） |

---

## 5. 推荐集成方案（跨平台级联降级）

### 5.1 总体策略：全平台四层可用性级联（含 macOS）

**macOS、Windows、Linux 共用同一条级联链**，唯一差异是 macOS 多一个「ego lite」首位环节。
任何一层通过 `checkAvailability + doctor 探针` 不通过，立刻跳到下一层，不阻塞用户。

```
用户发起浏览器任务（任意平台）
    │
    ├─ 1️⃣ [macOS only] ego lite 检测（平台=darwin AND CLI 存在 AND doctor 探针通过）
    │       命中 → 现有 ego_browser / patent_pdf_download 行为不变
    │       不通过（未装 / CLI 缺 / app 挂 / Native Messaging 管道死）
    │         │
    │         └───────┐
    │                 ▼
    ├─ 2️⃣ [全平台通用] BrowserOS neo 存活检测
    │       HTTP GET http://127.0.0.1:9010/mcp 健康
    │         OR 用户在 Sati 设置里粘贴的自定义 endpoint 存活
    │       命中 → 走 browseros-neo 插件（HTTP MCP，Chrome 一键导入 + 录屏回放）
    │       不通过 → 继续
    │
    ├─ 3️⃣ [全平台通用] browser-use 检测（CLI 可执行）
    │       macOS/Linux: `command -v browser-use` 或 `uvx browser-use --help` 成功
    │       Windows:     `Get-Command browser-use` 或 `uvx --version` 成功
    │       命中 → 走 browser-use-python 插件（stdio MCP，MIT + 全平台一致）
    │       不通过 → 继续
    │
    └─ 4️⃣ [全平台兜底] @playwright/mcp（Sati 自带，install:browser 可选）
            永远命中；但**明确标注无登录态**，返回结果中标注 backend=playwright
            公开页面（如 Google Patents 公开检索）100% 可用，登录受限站点引导用户
            返回上两层（2️⃣ BrowserOS neo 或 3️⃣ browser-use --profile）完成登录。
```

**跨平台对照表（每层在各平台的期望命中概率）：**

| 层级 | macOS 命中概率 | Windows 命中概率 | Linux 命中概率 | 核心价值 |
|------|---------------|-----------------|---------------|---------|
| 1️⃣ ego lite | **90%**（主力体验） | 0%（不支持） | 0% | 原生体验 + learnings 站点包 + 零配置登录态 |
| 2️⃣ BrowserOS neo | **40%**（用户主动装过） | **50%**（Windows 用户首选体验） | 0%（neo 暂不支持 Linux） | Chrome 一键导入 + 录屏回放 UI + 53+ MCP 工具 |
| 3️⃣ browser-use | **60%**（Python 环境开发者多有 uv/brew） | **30%**（需要装 Python+uv） | **70%**（Linux 开发者普遍 Python-ready） | MIT 协议 + CLI/MCP 双模式 + 三端一致 |
| 4️⃣ @playwright/mcp | **100%** | **100%** | **100%** | 零外部依赖 + 公开页面可靠兜底 |

> **设计原则**：
> 1. 每一层对上层透明，`createBrowserBackendForPlatform()` 统一路由；
> 2. 技能文档层 prompt **不需要按平台分支**，ego helper DSL 写一遍即可在四 backend 上自动翻译；
> 3. macOS 上用户如果明确偏好（M5 回放需求 / M6 隔离会话），可在设置里把 BrowserOS neo 或 browser-use 设为「优先于 ego」；
> 4. 专利证据留证场景自动**选择带录屏能力的 backend**（BrowserOS neo > ego screencast > browser-use video 扩展 > playwright video），并在结果元数据中记录 `backend` 名与 `recordingPath`。

### 5.1.1 macOS 上 ego → 备选的自动降级触发条件（明确）

在现有 [egoSession.ts](file:///Users/xujian/projects/Sati/src/patent/data/nuo/egoSession.ts#L107-L124) 基础上，
当 `EgoBackend.checkAvailability(doctor=true)` 返回以下任一情况时，**不再报错给用户**，而是 router 直接跳到第 2 层：

| 条件 | 对应 1.5 节场景 |
|------|----------------|
| `platform === "darwin"` 但 `isCommandExecutable("ego-browser") === false` | M1 / M2 |
| CLI 存在但 `runConnectionProbe(8000ms)` 返回 false（app 没启动、管道挂死） | M4 |
| 用户在设置中勾选了「macOS 上优先使用 BrowserOS neo 进行证据留证」 | M5 / M6 |
| `sati.yaml` 设置了 `browser.preferredBackend = browseros-neo | browser-use | playwright` | 任何显式偏好 |

用户会在 agent 返回结果的**元数据段**看到「本任务使用了 BrowserOS neo 作为浏览器后端（因 ego lite 未安装）」，不会感知到失败重试。

### 5.2 阶段一（P0 · 最速落地）：扩展 MCP 路由层

**目标**：Windows 用户装完 BrowserOS neo 或 browser-use 就能用，不改现有 `ego_browser` 工具签名。

#### 5.2.1 新增 MCP 插件（2 份 plugin.json）

**文件 A**：`src/extension/plugins/builtin/browseros-neo/plugin.json`

```json
{
  "name": "browseros-neo",
  "version": "1.0.0",
  "description": "BrowserOS neo — agent's second browser (Chromium fork, real Chrome profile, session replay)",
  "mcpServers": {
    "browseros-neo": {
      "command": "node",
      "args": [
        "-e",
        "// HTTP 代理：Sati MCP runtime 默认走 stdio，这里包一层 stdio↔HTTP 转发",
        "// 或直接扩展 McpClient 支持 http transport（更优，见 5.2.2）"
      ],
      "perSession": false,
      "env": {
        "SATI_BROWSEROS_MCP_URL": "http://127.0.0.1:9010/mcp"
      }
    }
  }
}
```

**文件 B**：`src/extension/plugins/builtin/browser-use-python/plugin.json`（已在 2.5 节给出）

#### 5.2.2 McpClient 原生支持 HTTP transport（关键）

目前 [McpClient.ts](file:///Users/xujian/projects/Sati/src/mcp/client/McpClient.ts) 主要为 stdio 设计（playwright 就是 stdio），
需新增对 Streamable HTTP 的支持（BrowserOS neo 需要）：

- 复用 `@modelcontextprotocol/sdk` 自带的 `streamablehttp_client`（该 SDK 已包含 HTTP 实现）
- 在 `plugin.json → mcpServers` schema 中新增 `transport: "http"` + `url` 字段
- `PluginToToolBridge` 层无需改动，因为桥接层只看 tool 不看 transport 类型

#### 5.2.3 可用性级联提示（按平台差异化输出）

在 [egoSession.ts](file:///Users/xujian/projects/Sati/src/patent/data/nuo/egoSession.ts) 的
`checkAvailability` 返回结果里，当 ego 不可用时，按**当前平台**差异化附加 `hints`：

```
──────────────────────────── [macOS 平台提示] ────────────────────────────
ego-browser (ego lite) is unavailable: <具体原因，如 CLI 未找到 / 探针失败>
可选方案（按体验排序）：
  1. Install / Launch BrowserOS neo (https://browseros.com/agents)
     → Chrome 一键导入登录态 + 录屏回放 + session dashboard UI
  2. Install browser-use CLI: brew install uv && uv tool install browser-use
     → MIT 协议 + 三端一致 CLI/MCP，Python 开发者 30s 装好
  3. 直接使用 Sati 内置 @playwright/mcp
     → 无需额外安装，公开页面 100% 可用（无已登录会话）
──────────────────────────── [Windows 平台提示] ──────────────────────────
ego-browser (ego lite) does not support Windows. 可用方案：
  1. Install BrowserOS neo (https://browseros.com/agents) — 下载 .exe
     → Chrome 一键导入 + 录屏回放，Windows 体验最佳
  2. Install browser-use CLI: winget install Python.Python.3.12; uv tool install browser-use
     → MIT 协议，命令行友好
  3. Fallback: Sati 内置 @playwright/mcp（无需额外安装）
──────────────────────────── [Linux 平台提示] ────────────────────────────
ego-browser (ego lite) does not support Linux. 可用方案：
  1. Install browser-use CLI: (apt|yum|pacman) install python3-uv; uv tool install browser-use
     → MIT 协议，Linux 首选（三端一致）
  2. 直接使用 Sati 内置 @playwright/mcp
     → 无需额外安装，公开页面 100% 可用
注：BrowserOS neo 暂不支持 Linux，如需完整录屏与登录态管理可关注 BrowserOS
    (主产品，非 neo) 的 Linux AppImage/Deb 包。
```

此外，在 `sati status` 命令输出中新增一行浏览器后端矩阵：

```
Browsers:
  ✅ ego lite (macOS, CLI v0.4.6.12, doctor ok)
  ✅ BrowserOS neo (http://127.0.0.1:9010/mcp, ok)
  ✅ browser-use (uvx, v0.13.7)
  ✅ @playwright/mcp (built-in, perSession)
```

用户一眼看到自己当前机器上哪些浏览器后端是可达的。

### 5.3 阶段二（P1 · 体验对齐）：抽象 BrowserBackend 接口

**目标**：把 ego_browser / patent_pdf_download 等现有「直接写死调 egoSession」的代码，
改为依赖 `BrowserBackend` 抽象，从而在 Windows 上自动切到 browser-use 或 BrowserOS neo，
**技能层 prompt 与专利下载逻辑零修改**。

#### 5.3.1 接口定义（新增）

```typescript
// src/browser/BrowserBackend.ts （新增文件）
export interface BrowserBackend {
  /** 平台级 + 安装级可用性探测（可带 doctor 探针） */
  checkAvailability(env?: NodeJS.ProcessEnv, doctor?: boolean): Promise<EgoAvailability>;

  /** 统一的「执行一段浏览器自动化脚本」入口
   *  - ego 实现：走 `ego-browser nodejs <<HEREDOC`（原 egoSession.runScript）
   *  - browser-use 实现：把 Sati 约定的 helper DSL 翻译成 CLI 调用链或 MCP tools 调用链
   *  - BrowserOS 实现：把 helper DSL 翻译成其 MCP tools 调用
   */
  runScript(script: string, options: EgoRunOptions): Promise<EgoScriptResult>;

  /** 下载拦截：给定触发下载的动作，把文件落盘到 targetDir */
  downloadWithInterception?(
    triggerScript: string,
    targetDir: string,
    options?: { timeoutMs?: number; recordScreencast?: boolean },
  ): Promise<{ savedPath: string; status: "ok" | "fallback"; fallbackUrl?: string; recordingPath?: string }>;

  /** 会话级 task space / profile 命名（决定复用粒度） */
  taskSpaceName(domain: string, sessionId?: string): string;
}
```

#### 5.3.2 Backend 实现与路由

| Backend | 优先级 | 触发条件 | 关键实现思路 |
|---------|--------|----------|-------------|
| `EgoBackend` | P0 (macOS) | `platform==darwin && ego-browser CLI 存在` | 直接复用现有 egoSession.ts，不动 |
| `BrowserOsNeoBackend` | P1 (Win) | `fetch(http://127.0.0.1:9010/mcp) 健康` | 把 ego 约定的 helper 函数（useOrCreateTaskSpace / openOrReuseTab / snapshotText / click / fillInput / js / cliLog）逐个映射为 BrowserOS neo 的 MCP 工具调用；翻译脚本用轻量 AST walker 或正则替换（ego 脚本 helper 集合很小） |
| `BrowserUsePyBackend` | P2 (Win/Linux) | `uvx browser-use --help` 成功 | 同上，但映射到 browser-use CLI 命令链或其 MCP tools；注意 `downloadWithInterception` 需 CDP `Fetch.enable` + `Browser.setDownloadBehavior` 封装 |
| `PlaywrightMcpBackend` | 兜底 | 永远命中（Sati install:browser 后可用） | 映射到现有 `@playwright/mcp` 的 browser_navigate / browser_snapshot / browser_click 等；**此 backend 不承诺登录态**，结果中标注 `state: "no-login-profile"` |

#### 5.3.3 路由器：`createBrowserBackendForPlatform()`

```typescript
// src/browser/createBrowserBackendForPlatform.ts
export async function createBrowserBackendForPlatform(
  options: { doctorCheck?: boolean; prefer?: "browseros-neo" | "browser-use" | "playwright" } = {},
): Promise<BrowserBackend> {
  const backends: Array<() => Promise<BrowserBackend | null>> = [
    // 1. macOS: ego
    async () => process.platform === "darwin" ? new EgoBackend() : null,
    // 2. 平台通用：BrowserOS neo（如果用户已安装运行）
    async () => browserOsNeoHealthy() ? new BrowserOsNeoBackend() : null,
    // 3. 平台通用：browser-use Python（如果 CLI 可用）
    async () => browserUseCliAvailable() ? new BrowserUsePyBackend() : null,
    // 4. 兜底：@playwright/mcp
    async () => new PlaywrightMcpBackend(),
  ];
  for (const factory of backends) {
    const b = await factory();
    if (!b) continue;
    const ok = await b.checkAvailability(process.env, options.doctorCheck);
    if (ok.ok) return b;
  }
  throw new Error("No browser backend available");
}
```

#### 5.3.4 调用方替换

- [egoBrowser.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/egoBrowser.ts) 的 `execute` 不再直接 new `EgoBrowserSession`，改为 `createBrowserBackendForPlatform().runScript(...)`
- [patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts) 改为先拿 backend，优先调用 `backend.downloadWithInterception`，没有则降级

#### 5.3.5 输出协议兼容

所有 backend 的 `runScript` 返回结构严格对齐现有 `EgoScriptResult`：

- `output`（stdout+stderr 合并截断）
- `stdout` / `stderr`（原始）
- `exitCode` / `timedOut` / `durationMs`

脚本内「结果通过 `cliLog(...)` 输出」的约定也继续保持；
BrowserOS neo / browser-use 侧把最终 return 值格式化成 `cliLog(...)` 包裹的 stderr 行，
这样 `extractTaggedJson` 零修改。

### 5.4 阶段三（P2 · 高级能力补齐）

只在阶段二落地验证后推进：

1. **站点经验包兼容层**：把 ego lite 的 `learnings/google-patents/` 这类站点脚本，
   转写成「Backend 无关的 TS 函数 + 针对每个 backend 的动作映射」，实现跨栈复用
2. **Sati UI 内置 BrowserOS neo endpoint 配置页**：用户粘贴 endpoint URL → 自动写入 MCP config，
   并一键 health check
3. **录屏证据自动入库**：BrowserOS neo 会话视频路径回写到 Sati session artifacts，
   专利证据提交时自动引用
4. **Windows 安装脚本**：`install.ps1` 中新增 `-IncludeBrowserAutomation` switch，
   自动尝试 `winget install Python.Python.3.12` + `uv tool install browser-use`
   并引导用户安装 BrowserOS neo（可选）
5. **测试矩阵补齐**：在 CI（目前只有 GitHub Actions？）中加 Windows matrix job，
   用 headless Playwright 跑 `PlaywrightMcpBackend`，保证基础能力不回归

---

## 6. 风险与缓解

| # | 风险 | 等级 | 缓解措施 |
|---|------|------|----------|
| R1 | BrowserOS AGPL 协议理解有误，后续被迫开源 Sati | 中 | ① 方案明确只调 MCP 不分发代码；② 正式启动前拉公司法务过协议边界；③ 保留随时切回纯 browser-use（MIT）的退路 |
| R2 | browser-use `uvx` 在 Windows 企业内网/无 Python 环境装不上 | 中 | ① 阶段一不把 browser-use 设为 Windows 默认（而是 BrowserOS neo 或兜底 Playwright）；② 安装脚本检测 Python 缺失时给出 BrowserOS neo 的 exe 下载链接；③ 文档提供「离线 wheel 包 + 本地 Chromium」操作手册 |
| R3 | ego helper → BrowserOS MCP 工具翻译器覆盖不全，老脚本在 Windows 上报错 | 中高 | ① 翻译器维护一张完备的 helper→tool 映射表（本文档 2.4 + 3.4 已列清单）；② 翻译失败时给出可读错误并提示用户降级到 Playwright backend；③ 专利域高频路径（google-patents / cnipa）先人工跑通作为冒烟用例 |
| R4 | BrowserOS neo MCP 默认端口假设错误（文档/代码假设 9200，实机为 9010） | 低 | **已确认并修复（2026-08-12 实机）**：真实 MCP URL 为 `http://127.0.0.1:9010/mcp`（见 `~/.browserclaw/runtime.json`）；`BROWSEROS_NEO_DEFAULT_URL`/plugin.json/`sati browsers` 提示已统一为 9010，并支持 `env SATI_BROWSEROS_MCP_URL` 覆盖。未来如端口被占，用 `lsof -i :9010` 确认归属后按上述 env 覆盖 |
| R5 | 登录态导入失败（浏览器版本差异 / profile 锁） | 低 | ① browser-use 侧同时暴露「connect」「--profile」两条路径给用户选；② BrowserOS neo 侧导入向导本身有校验和 FAQ（直接借力）；③ 失败时回退到无登录态 Playwright + 明确标注「结果可能被封/需人机验证」 |
| R6 | 专利 PDF 下载拦截在 BrowserOS/browser-use 上与 ego lite 实现不一致，导致下载失败或拿错文件 | 中高 | ① `downloadWithInterception` 先写三方 backend 的单元测试，用已知专利 URL 打桩；② 首次上线时强制开启「fallback URL 双保险」（即使拦截成功也同时拿到 CDN 直链，失败切直链）；③ 录屏留证自动开启，便于事后审计 |

---

## 7. 验收标准（Definition of Done）

### 7.1 Sprint 1（阶段一 · 跨平台可用）

> 实施状态（2026-08-12）：除标 🔜 的两项外全部完成并通过 typecheck/lint/单测。详见 10.7 实施记录。

- [x] **MCP server 接入能力**：`McpClient` 原生支持 `streamable_http` transport 与 `plugin.json → url` 解析**已存在**（[McpClient.ts](file:///Users/xujian/projects/Sati/src/mcp/client/McpClient.ts#L174-L194) / [types.ts](file:///Users/xujian/projects/Sati/src/mcp/protocol/types.ts#L22-L27)），无需新增代码；评审 L-E 的「node -e 代理」方案已废弃
- [x] Sati 启动后，MCP 列表在**所有平台**都能看到可选 server：
  - [x] `browseros-neo`（新增 [plugin.json](file:///Users/xujian/projects/Sati/src/extension/plugins/builtin/browseros-neo/plugin.json)）
  - [x] `browser-use-python`（新增 [plugin.json](file:///Users/xujian/projects/Sati/src/extension/plugins/builtin/browser-use-python/plugin.json)）
  - [x] `@playwright/mcp`（原有 [plugin.json](file:///Users/xujian/projects/Sati/src/extension/plugins/builtin/browser-use/plugin.json)）
- [ ] 🔜 macOS 上 `ego lite` 不可用时（M1/M2/M4 场景），agent **不再硬失败**，而是自动尝试 BrowserOS neo → browser-use → Playwright 级联 —— **级联提示已实现，自动级联（BrowserBackend 抽象）属 Sprint 2**
- [x] 技能 `patent-search` / `patent-download` 在 Windows/Linux 上不直接报「ego 不支持」，而是给出三平台差异化级联提示与安装命令（[egoBrowser.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/egoBrowser.ts#L343-L391) `buildEgoUnavailableReason`）
- [ ] 🔜 `@playwright/mcp` 兜底在**三平台**手动 dry-run 全通过（仅 macOS 本机验证过插件注册；Windows/Linux 需真实机器冒烟）
- [x] 浏览器后端矩阵输出：**实现为 `sati browsers` 命令**（sati 无 status 子命令）——四层探测 + `--doctor`/`--json`，含 BrowserOS 端口归属 pid 探测（S4 缓解）
- [x] 文档评审完成（第 10 章）；`install.sh`/`install.ps1` 引用属 Sprint 3 安装脚本统一增强

### 7.2 Sprint 2（阶段二 · 体验对齐）

> 实施状态（2026-08-12）：**BrowserBackend 抽象 + 路由器 + 能力位已合入**（代码部分完成，见 10.8）。
> 剩余为依赖实机的验证项（Track B 兼容层、三平台 dry-run、CI matrix、SKILL 意图层）。

- [x] `BrowserBackend` 抽象 + **四个 backend 探测实现**合入主分支（能力位对齐 POC §3）：
  - [x] [types.ts](file:///Users/xujian/projects/Sati/src/browser/backend/types.ts)：`BrowserBackendId` / `BrowserCapabilities`（6 项能力位）/ `BrowserBackendProbe` / `BrowserBackend`
  - [x] [egoBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/egoBackend.ts)：macOS 首选，能力位全开，复用 egoSession（零改造）
  - [x] [browserosNeoBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/browserosNeoBackend.ts)：HTTP 探测 + 端口归属 pid（S4 缓解），download/screencast 能力位为真
  - [x] [browserUsePyBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/browserUsePyBackend.ts)：CLI 探测，download/screencast 标 false（POC §3.2 短板）
  - [x] [playwrightBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/playwrightBackend.ts)：内置插件探测，loginState/antiBot 为 false（兜底语义）
  - [x] [index.ts](file:///Users/xujian/projects/Sati/src/browser/backend/index.ts)：`buildBackendCandidates`（级联顺序 + `prefer`/`exclude`）+ `resolveBrowserBackend`（cold decision）+ `probeAllBackends`（sati browsers 共用）
- [x] `sati browsers` 重构为复用 `src/browser/backend`（消除重复探测逻辑，探测与路由单一事实来源）
- [x] 单测 [backend.spec.ts](file:///Users/xujian/projects/Sati/tests/browser/backend.spec.ts)：级联顺序 / prefer / exclude / 能力位 / cold decision / 全不可用抛错 —— 6/6 通过
- [ ] 🔜 **Track B 兼容层（ego-helper）**：依赖 BrowserOS neo 实机（Sprint 2 前置实测清单），未开始
- [ ] 🔜 技能层 20+ SKILL.md **backend 无关意图层**（Track A 指引，SKILL.md 零修改承诺已按评审 §S2 修正为「意图层」），未开始
- [ ] 🔜 三平台 × 多 backend dry-run、CI matrix、四 backend 录屏验证：依赖实机，未开始

### 7.3 Sprint 3（阶段三 · 高级能力补齐，可选）
- [ ] **三平台安装脚本统一增强**：
  - macOS `install.sh` 新增 `--install-browser-use`（brew install uv → uv tool install browser-use）
  - Windows `install.ps1` 新增 `-IncludeBrowserAutomation`（winget Python → uv）+ BrowserOS neo .exe 下载提示
  - Linux（deb/rpm/AUR 后续）：`install.sh` 识别发行版包管理器
- [ ] Sati UI 提供 **BrowserOS neo endpoint 粘贴 + health check** 入口 + browser-use/Playwright 一键安装按钮
- [ ] ego 站点经验包 google-patents 的核心动作在 3+ backend 都能用（脚本翻译器覆盖率达到 90%）
- [ ] macOS 场景 M5（专利证据留证）验收：用户发起批量专利下载，router 自动**优选 BrowserOS neo**（即使 ego 可用），产出完整可回放视频 + 步骤时间线，存入 session artifacts
- [ ] `browser.preferredBackend` 配置项在 `sati.yaml` + UI 设置中生效，用户可显式指定 ego / browseros-neo / browser-use / playwright 为默认后端

---

## 8. 推进建议（下一步）

1. **本周（先在一台 macOS + 一台 Windows 上跑基线 dry-run）**：
   - 法务确认 BrowserOS neo 作为外部 App 通过 MCP 调用的 AGPL 边界
   - **macOS 机**：依次手动跑通四件事
     ① ego lite 正常工作（现态基线）；
     ② kill ego app 后模拟 M4 场景，验证「手动切 BrowserOS neo」是否完成同等任务；
     ③ `brew install uv && uv tool install browser-use` 跑 browser-use CLI；
     ④ `pnpm install:browser` 后确认 Playwright MCP 通。
     同时记录耗时、token 消耗、成功率。
   - **Windows 机**：依次手动跑通三件事
     ① BrowserOS neo 安装 + Chrome 一键导入 + MCP 通；
     ② winget Python + uv → browser-use CLI 通；
     ③ 兜底 Playwright MCP 通。
   - 共用最小冒烟脚本：`google-patents 搜索 "pcm thermal management" → 截图 → 提取 10 个专利号`，四条路径各跑一遍做对比报告。

2. **下周（先出两个最小 PR，不碰核心逻辑）**：
   - PR 1：`McpClient → HTTP transport` 支持（最小改动，复用 `@modelcontextprotocol/sdk` 的 streamablehttp_client），先把 BrowserOS neo 作为一个普通 MCP server 接进来，手工能用。
   - PR 2：在 `egoSession.checkAvailability` 返回值里加本文档 5.2.3 节的三平台差异化 hints + 在 `sati status` 里加浏览器后端矩阵行。这两个改动不改变行为，先给用户出口。

3. **下 Sprint（阶段二，动架构）**：
   - 按 5.3 节推进 `BrowserBackend` 抽象 + 路由器 + 翻译器实现；
   - 把 GitHub Actions CI 加上三平台 matrix，专利域核心冒烟在三平台上强制绿了才能合入。

---

## 9. 参考链接

- ego lite × Sati 现状文档：[ego-lite-integration.md](file:///Users/xujian/projects/Sati/docs/ego-lite-integration.md)
- browser-use GitHub：<https://github.com/browser-use/browser-use>
- browser-use MCP Registry：<https://github.com/browser-use/browser-use/blob/main/server.json>
- browser-use SKILL（CLI 全量命令）：<https://github.com/browser-use/browser-use/blob/main/skills/browser-use/SKILL.md>
- BrowserOS GitHub：<https://github.com/browseros-ai/BrowserOS>
- BrowserOS neo MCP 接入文档：<https://docs.browseros.com/neo/mcp>
- BrowserOS MCP vs Chrome DevTools MCP 工具清单对比：<https://docs.browseros.com/comparisons/chrome-devtools-mcp>
- Playwright MCP（Sati 已有）：<https://playwright.dev/mcp/introduction>

---

## 10. 方案评审（2026-08-12）

> 评审视角：跨平台浏览器自动化可行性 / 与 Sati 现有架构的耦合度 / 工程成本与风险。
> 结论先行：**方案整体成立、分层设计正确、与现状基线对齐度高，可以进入实施，但「翻译器」是最大技术假设，必须先 POC 验证，不能直接按 5.3 节全量投入。**
> 评审分级：S=阻断项（不解决不进入阶段二） / M=中等问题（影响成立性，需缓解） / L=轻微问题（建议修订）。

### 10.1 评审通过项

| 设计点 | 结论 |
|--------|------|
| 四层级联（ego → BrowserOS neo → browser-use → Playwright） | ✅ 正确。层级顺序 = 体验优先级 + 安装门槛优先级，自洽 |
| macOS 同样需要备选（1.5 节 M1-M7） | ✅ 成立，尤其 M1（新机未装）与 M4（休眠后管道挂死）是高频真实场景 |
| BrowserOS AGPL 边界判断（3.6 节） | ✅ 基本正确：Sati 只调 MCP、不改源码、不分发二进制 → 不触发传染。**补充精确边界见 10.3-S4 旁的说明** |
| BrowserOS neo 登录态导入 / 录屏回放作为差异化能力 | ✅ 判断准确，确实强于 ego 与 browser-use |
| P0 先做 HTTP transport + 提示语 + sati status 矩阵 | ✅ 改动面小、不动核心逻辑、先给用户出口，优先级合理 |
| R2/R6 已有缓解措施 | ✅ R6 的「fallback URL 双保险」特别关键，应保留 |

### 10.2 阻断项（必须解决才能进入阶段二）

#### S1 【最高风险】翻译器可行性被严重低估

**问题**：5.3.2 声称「翻译脚本用轻量 AST walker 或正则替换（ego 脚本 helper 集合很小）」。
但 ego 脚本是**任意 JS**，真实代码包含：

- `await Promise.all([...])` 多 space 并行
- `page.waitForEvent("download")` / `page.screencast` / `site.runTool(...)` facade 调用
- `js('(() => {...})()')` 内嵌**任意页面代码**（无法静态翻译）
- 条件分支、循环、异常处理

正则/轻量 AST 无法处理以上任意一项。可行的翻译器本质是：**在 Node 侧实现一个 ego-helper 兼容层**（mock `useOrCreateTaskSpace`/`openOrReuseTab`/`snapshotText`/`click`/`cliLog` 等 API，内部桥接到目标 backend 的 MCP tools），工程量 ≈ **用 Node 重新实现一个浏览器驱动库**，不是「一张映射表」。

**必须做**：进入阶段二前先做 **POC**（见 10.6 新增 Sprint 1.5）。POC 不通过则放弃「脚本级兼容」，改走 10.3-S2 的「原子 tool 直出」路线。

#### S2 【高风险】执行模式冲突：透传脚本 vs 原子 MCP tools

**问题**：ego 是**一次 tool call 透传整段 JS**（agent 心智简单、token 省）；BrowserOS neo / browser-use / Playwright 的 MCP 是**几十个原子 tool call**（`click`、`type`、`screenshot`…由 agent 逐步规划）。两者对 LLM 的消耗与行为完全不同。

5.3.5 声称「cliLog 输出约定保持，`extractTaggedJson` 零修改」——**在 MCP backend 上不成立**：MCP 没有 heredoc 脚本概念，tool 返回值就是结构化 JSON，不存在 stderr 里的 `cliLog(...)` 行。

**结论**：对非 ego backend，「脚本透传」这条抽象不能维持。**修正为双轨策略**：
- **Track A（P1 先做）**：直接把 backend 原子 MCP tools 暴露给 agent（与现有 `@playwright/mcp` 插件同构，零翻译成本），SKILL.md 改为「backend 无关的意图层指引」。接受 token 成本上升（BrowserOS 官方宣称其 snapshot 压缩可缓解）。
- **Track B（P2 视 POC 而定）**：ego-helper 兼容层（Node 执行器），达到脚本级复用后才谈「SKILL.md 零修改」。

> 推论：7.2「`ego_browser` 工具签名与 20+ SKILL.md 零修改」的验收标准**无法满足**，须改为「专利域核心 SKILL.md 提供 backend 无关意图层；原子 tool 直出路径下 agent 按意图层指引操作」。

#### S3 【高风险】级联切换时的会话中断（cold vs warm decision）

**问题**：`taskSpaceName` 是会话级复用（登录态 + 已开 tab 跨调用保留）。若任务**进行中**因探针失败切换到下一层 backend，登录态、已打开页面、已收集证据全部丢失；专利批量下载场景会直接造成证据链断裂。

**必须明确**：backend 选择是 **cold decision** —— 只在任务/会话开始前由路由器决定一次；任务进行中**禁止 warm-switch**。若运行中发生故障：
- 返回明确错误 + 建议「重试整个任务（换 backend）」；
- 已产出的下载文件/截图不受影响（落盘产物保留）；
- 幂等性：专利任务支持断点重试（现有 workflow 已有 checkpoint 能力可复用）。

#### S4 【中高风险】BrowserOS neo 本机安全面（文档风险表缺失项）

**问题**：BrowserOS 官方文档原文——「Anyone who can reach this URL has full control of your browser, including every account you are signed into」。`127.0.0.1:9010/mcp` **无认证**。任何本机进程（含恶意软件、浏览器劫持类木马）都能控制用户所有已登录账户。Sati 默认探测并接入该端口 = 把浏览器控制权交给任意本机进程。

**缓解（补入风险表）**：
1. 接入前**校验端口归属进程**确实是 BrowserOS（macOS `lsof -i :9010` 核对进程名 / Windows `Get-NetTCPConnection` + 进程名，与 BrowserOS 二进制路径比对），防止恶意进程抢占端口钓鱼；
2. Sati UI 对自定义 endpoint 做**首次授权确认**（用户手动粘贴 URL 即视为授权，但给出安全提示）；
3. 文档与 `sati status` 输出中提示该端口风险，建议用户仅在信任的本机环境启用。

#### S4 旁注【AGPL 精确边界补充】

即便将来 Sati 安装脚本**自动下载并捆绑分发** BrowserOS 二进制，触发的是「AGPL 分发义务」（向接收者提供可修改源码，即 claw-server-rust 等组件源码），**并非 Sati 整体开源**——除非 Sati 修改并合并了 BrowserOS 源码。R1 的「只调 MCP 不分发代码」判断正确，建议法务确认时带上这个精确表述。

### 10.3 中等问题（需缓解）

| # | 问题 | 影响 | 缓解措施 |
|---|------|------|----------|
| M-A | **doctor 探测累积延迟**：级联逐层探测（ego spawn 8s + BrowserOS HTTP + browser-use CLI），冷启动第一个任务可能 +10s 以上 | 体验 | 探测结果 TTL 缓存（如 5min）；各层**并行**探测；doctor 探测与首次实际使用分离（懒探测） |
| M-B | **CI 三平台矩阵可测性**：BrowserOS neo 是 GUI App，Windows/Linux CI runner 无交互桌面，难以自动化验收 | 验收失真 | 区分两层：CI 只自动化 headless 可测的 Playwright / browser-use；BrowserOS neo 走「手工验收清单 + 真实用户环境冒烟」，不写进 CI 强制项 |
| M-C | **版本号漂移**：browser-use pyproject v0.12.6 / server.json v0.13.5 / README v0.13.7 三者不一致；ego app 内置 harness 落后仓库 | 集成基线不稳 | 集成处一律 **feature-detect**（沿用 patent_pdf_download 已有模式），不依赖固定版本号；文档维护「版本基线快照」章节，随 `scripts/update.sh` 更新 |
| M-D | **多 Chromium 资源占用**：级联链可能同时存在 3 个 Chromium 系实例（BrowserOS fork + browser-use Chromium + Playwright Chromium），每实例 500MB+ | 用户机器卡顿 | 提供 `browser.enabledBackends` 配置，默认只启用 1-2 个；级联探测不常驻浏览器进程（browser-use daemon 按需启停） |

### 10.4 轻微问题（建议修订）

| # | 问题 | 建议 |
|---|------|------|
| L-A | 文档名 `windows-browser-automation-plan.md` 与跨平台内容不符 | 重命名为 `cross-platform-browser-automation-plan.md`，并更新 7.1 验收中对文档名的引用 |
| L-B | 「20+ SKILL.md 零修改」承诺与 S2 冲突 | 改为「专利域核心 SKILL.md 提供 backend 无关意图层」 |
| L-C | 1.5-M5 将 BrowserOS 录屏回放称为「刚需级」，但未评估其作为**专利法律证据**的 chain-of-custody（时间戳、防篡改、哈希留档） | 放 P2：证据入库时补哈希 + 时间戳 + 步骤序列导出，不依赖回放 UI |
| L-D | 4 章矩阵 Playwright 下载拦截标为「✅ browser_wait_for('download')」 | ✅ 已实测修正（2026-08-12）：@playwright/mcp 无独立下载工具；经 `browser_run_code_unsafe`（RCE 等价、需启用 unsafe caps）可拦截。矩阵已改标「⚠️」 |
| L-E | 5.2.1 中 browseros-neo 插件示例用 `node -e` 做 stdio↔HTTP 代理，复杂度高于直接支持 HTTP transport | 阶段一优先实现 5.2.2（McpClient 原生 HTTP transport），去掉代理方案 |

### 10.5 修订后的推进路径

```
Sprint 1（P0，已完成 2026-08-12）   → McpClient HTTP transport（现状已支持）+ 两份新 MCP 插件
                                     + ego 三平台提示 + sati browsers 探测命令（详见 10.7）
Sprint 1.5（P0.5，已完成 2026-08-12）→ 翻译器 POC：结论见 docs/browser-backend-poc.md
                                     Gate 结果：✅ 条件性通过 —— BrowserOS neo ~85% 兼容走 Track B；
                                     browser-use ~65%（补 CDP 下载封装 ~80%）走 Track A
Sprint 2（P1，按 POC 结论分轨）     → Track B：ego-helper 兼容层（Node 侧实现 + BrowserOS neo
                                     MCP tools 桥接，只实现 8 个核心 helper + 能力位探测）
                                     Track A：backend 原子 tools 直出 + SKILL.md 意图层（必做，
                                     覆盖 browser-use 与 @playwright/mcp）
                                     Sprint 2 前置实测：BrowserOS neo 实机 dry-run（S1 样本）+
                                     browser-use --cli-mcp 实机 + playwright 下载能力实测（L-D）
Sprint 3（P2，不变）                → UI 配置 / 证据入库（含 L-C 哈希）/ 安装脚本 / 站点包兼容
```

### 10.6 评审遗留待办

- [ ] POC 前先做 1.5 节 M1/M4 场景的**真实复现**（新机不装 ego / kill ego app 后跑任务），确认 macOS 降级路径的真实触发频率
- [ ] 实测 @playwright/mcp 的下载拦截能力（L-D），修正 4 章矩阵
- [ ] 法务确认 AGPL 边界时附带 10.3-S4 旁注的「分发义务 vs 整体开源」精确区分
- [ ] 确认 BrowserOS neo 是否提供 endpoint 认证/token 机制（若有，S4 风险降级）
- [ ] 确认 browser-use `--cli-mcp` 在 Windows 上的稳定性（M-C 的 feature-detect 是否需要 fallback 到 CLI 命令链）

### 10.7 实施记录（Sprint 1 · 2026-08-12）

| 变更 | 文件 | 验证 |
|------|------|------|
| 新增 BrowserOS neo 插件（HTTP MCP，url=127.0.0.1:9010/mcp） | [browseros-neo/plugin.json](file:///Users/xujian/projects/Sati/src/extension/plugins/builtin/browseros-neo/plugin.json) | dist 构建产物含该目录；McpRuntime 自动纳入（builtin 插件默认启用） |
| 新增 browser-use Python 插件（stdio MCP，uvx browser-use --cli-mcp） | [browser-use-python/plugin.json](file:///Users/xujian/projects/Sati/src/extension/plugins/builtin/browser-use-python/plugin.json) | 同上 |
| ego 不可用提示三平台差异化（macOS 保留 lite.ego.app 文案以兼容单测） | [egoBrowser.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/egoBrowser.ts#L343-L391) | `tests/tool/builtin/egoBrowser.spec.ts` 14/14 通过 |
| 新增 `sati browsers` 探测命令（四层矩阵 + `--doctor` + `--json` + 端口归属 pid） | [browserBackends.ts](file:///Users/xujian/projects/Sati/src/cli/commands/browserBackends.ts) | 本机实测输出正确（ego ✅ / neo 未装 / browser-use 未装 / playwright ✅）；dist 版本同样可用 |
| 注册 `sati browsers` 命令 + usage | [sati.ts](file:///Users/xujian/projects/Sati/src/cli/sati.ts#L568-L579) | `--help` 展示；tsx 与 dist 双跑通过 |

**验证结论**：`pnpm typecheck` ✅ · `eslint` ✅ · `npm run build` ✅ · egoBrowser 单测 14/14 ✅ · 本机 `sati browsers` 实测输出符合预期 ✅。

**执行中的偏差与决策**：
1. **`sati status` → 改名 `sati browsers`**：sati 实际没有 status 子命令，新增轻量 `browsers` 命令（不改动现有命令分发，零回归面）。
2. **McpClient HTTP transport 无需新代码**：现状已支持（评审 L-E 修正落地，直接废弃代理方案）。
3. **BrowserOS 端口归属校验在 P0 已做**（`probePortOwner`：macOS/Linux `lsof`、Windows `netstat`，仅输出 pid/进程名供人工确认），完整归属校验（对比 BrowserOS 二进制签名）留 Sprint 2。
4. **级联提示在 P0 完成、自动级联在 Sprint 2**：本阶段 agent 拿到的是「ego 不可用 + 备选安装指引」而非自动切换；自动切换依赖 BrowserBackend 抽象（7.2），避免半成品路由引入风险。

**Sprint 2 前置（承接 10.6）**：`@playwright/mcp` 下载拦截能力实测（L-D）、browser-use `--cli-mcp` Windows 实测（M-C）、Sprint 1.5 翻译器 POC（Gate 项）。

### 10.8 实施记录（Sprint 2 · 2026-08-12）

**范围**：按评审 §S2/S3 与 POC Gate 结论，先落地「不依赖实机、可单测」的路由与能力位基础设施；Track B 兼容层与三平台 dry-run 留待实机验证（避免无法验证的代码）。

| 变更 | 文件 | 验证 |
|------|------|------|
| 后端类型定义（能力位 6 项 + probe） | [types.ts](file:///Users/xujian/projects/Sati/src/browser/backend/types.ts) | typecheck ✅ |
| EgoBackend（macOS 首选，能力位全开，复用 egoSession 零改造） | [egoBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/egoBackend.ts) | 单测能力位 ✅ |
| BrowserOsNeoBackend（HTTP 探测 + 端口归属 pid） | [browserosNeoBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/browserosNeoBackend.ts) | 单测能力位 ✅ |
| BrowserUsePyBackend（CLI 探测） | [browserUsePyBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/browserUsePyBackend.ts) | 单测能力位 ✅ |
| PlaywrightMcpBackend（内置插件探测） | [playwrightBackend.ts](file:///Users/xujian/projects/Sati/src/browser/backend/playwrightBackend.ts) | 单测能力位 ✅ |
| 路由器：`buildBackendCandidates`（prefer/exclude）+ `resolveBrowserBackend`（cold decision）+ `probeAllBackends` | [index.ts](file:///Users/xujian/projects/Sati/src/browser/backend/index.ts) | 单测 6/6 ✅ |
| `sati browsers` 重构复用抽象（删除原重复探测实现） | [browserBackends.ts](file:///Users/xujian/projects/Sati/src/cli/commands/browserBackends.ts) | 本机实测输出正确 ✅ |
| 单测：级联顺序 / prefer / exclude / 能力位 / cold decision / 全不可用 | [backend.spec.ts](file:///Users/xujian/projects/Sati/tests/browser/backend.spec.ts) | 6/6 ✅ |

**验证结论**：`pnpm typecheck` ✅ · `eslint` ✅ · `npm run build` ✅ · `backend.spec.ts` 6/6 ✅ · egoBrowser 回归 14/14 ✅ · `sati browsers` 本机实测输出正确 ✅。

**设计要点（对接评审约束）**：
1. **不抽象「脚本执行」**（评审 §S2）：接口只抽象探测与能力位，规避透传脚本 vs 原子 tools 的模式冲突；
2. **cold decision**（评审 §S3）：`resolveBrowserBackend` 只在会话开始前调用，能力位由下游工具（如 patent_pdf_download）决定承接语义；
3. **能力位对齐 POC**（§3/§5.2）：browseros-neo download/screencast 为真（超集）、browser-use 标 false（CDP/video 短板待补）、playwright loginState/antiBot 为 false（兜底语义）；
4. **单一事实来源**：`sati browsers` 与未来 Track B 兼容层共用 `probeAllBackends`，无重复探测逻辑。

**剩余（依赖实机）**：Track B 兼容层（ego-helper × BrowserOS MCP tools 桥接）、SKILL.md 意图层、三平台 dry-run、CI matrix、四 backend 录屏验证。

### 10.9 前置实测清单执行报告（2026-08-12）

> 对应 POC 报告 §5.3。执行环境：macOS 本机（ego lite ✅）。沙箱限制：npx/npm-cache 写入被阻止；browser-use 旧安装 shebang 损坏。

| # | 实测项 | 状态 | 结论 / 证据 | 用户侧操作 |
|---|--------|------|-------------|-----------|
| 1 | browser-use `--cli-mcp` 实机 | ⛔ 受阻 | 本机旧安装 shebang 指向不存在的 `/usr/local/bin/python3`（环境迁移遗留）→ **M-C 的实证**：CLI 环境漂移后 `sati browsers` 正确报 missing；`uv tool install browser-use` 重装被跳过 | 有 Python 3.11 + 网络后执行 `uv tool install browser-use && uvx browser-use install`，重跑 `sati browsers` |
| 2 | @playwright/mcp 下载拦截（L-D） | ✅ 静态实测 | 官方 README 工具面：导航/点击输入/截图/键盘鼠标/对话框/标签页/网络监控/storage state，**无独立 download 工具**；下载拦截仅可经 `browser_run_code_unsafe`（RCE 等价、需显式启用 unsafe caps）实现。矩阵已改标「⚠️」；PlaywrightMcpBackend 注释已更新 | — |
| 3 | BrowserOS neo 实机 dry-run（MCP 探测 + 真实价格查询） | ✅ 通过 | **macOS 实机完成**：① 确认真实 MCP URL `http://127.0.0.1:9010/mcp`（非文档假设的 9200，R4 确认）；② 枚举真实工具面 = **18 个**（tabs/navigate/snapshot/diff/act/read/grep/evaluate/run/wait/screenshot/pdf/download/upload/history/tab_groups/windows/name_session），非文档假设的 53+；③ 用 `tabs new` → `evaluate(innerText)` → Bing 搜索完成 Netflix/Disney+/Hulu/Max/Apple TV+ 月度价格查询；④ 发现 `tabs` 代理归属权限制（须用 `tabs new` 自建页）；⑤ 发现重负载下窗口/profile 失效需重启 app | — |
| 4 | `take_enhanced_snapshot` / `state` 输出采样（F5） | ⛔ 依赖 #1 | BrowserOS neo 实机已具备 snapshot 工具（等价 F5 采样面）；browser-use `state` 采样待 #1 完成后补 | 随 #1 完成 |

**新增发现（写回方案）**：
1. **M-C 实证**：browser-use 在本机因 Python 环境迁移而 shebang 失效 —— 佐证「版本/环境漂移」风险，`sati browsers` 的探测（`spawnSync --version` 非 0 即 missing）能正确捕获该场景。另实测发现：`browser-use --version` 首次运行会创建 `~/.config/browser-harness`，在只读 HOME/sandbox/CI 下写入失败会**误报 missing** —— 已加固 `probeBrowserUse()`（注入临时 HOME/XDG 目录再探测，2026-08-12 落地，实测受限环境下四后端全部正确识别）；
2. **L-D 定论**：Playwright 下载拦截能力位维持 `false` 是正确的保守决策；后续若启用 unsafe caps，需在 Sati 侧单独把关（RCE 等价工具默认不暴露给 agent）；
3. **R4 确认**：BrowserOS neo 真实 MCP 端口为 **9010**（`~/.browserclaw/runtime.json`），方案/代码/插件此前假设 9200 —— 已统一修复为 9010 并支持 `env SATI_BROWSEROS_MCP_URL` 覆盖；
4. **真实工具面修正**：BrowserOS neo v0.0.28 实机为 18 个工具（见上），方案 §3.4 的 53+ 为文档高估 —— plugin.json instructions 已改写为真实工具面；
5. **稳定性实证**：连续大量 `tabs new/close` 后 BrowserOS 窗口/profile 会失效（`No browser window available` / `No profile available`），需重启 app —— Track B 兼容层应内置「窗口存活探测 + 自动重建」。

**结论**：#2、#3 已完成；#1/#4 需用户在真实环境补装 browser-use 后继续。Track B 兼容层实现可以 #3 为前提推进。
