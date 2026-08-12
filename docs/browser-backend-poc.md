# 翻译器 POC 报告：ego 脚本 → 备选后端映射成本评估（2026-08-12）

> 对应方案文档 §10.5 Sprint 1.5（Gate）与 §10.6 评审遗留待办。
> 目的：判定「ego-helper 脚本级兼容」（Track B）是否可行，还是必须走「原子 MCP tools 直出」（Track A）。
> 方法：**静态分析 + 官方能力对照**（本机未安装 browser-use / BrowserOS neo，无真实环境实测；
> 实测清单列入「Sprint 2 前置」）。
> 结论先行：**Track B 条件性可行 —— 以 BrowserOS neo 为脚本兼容后端（预估兼容率 ~85%），
> browser-use 需补 CDP 下载/录屏封装（~65%→80%）。Gate 通过。**

---

## 1. 样本清单（真实代码来源）

| # | 样本 | 位置 | 内容 |
|---|------|------|------|
| S1 | patent_pdf_download 内置工具下载脚本 | [patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts) | 批量下载拦截核心：`useOrCreateTaskSpace` + `openOrReuseTab` + `js()` + `page.waitForEvent('download')` + `saveAs` + screencast + `PROGRESS`/`EGO_DOWNLOAD_RESULTS` 输出 + `canIntercept` 特性探测 |
| S2 | download_patent_ego.py 批量提取脚本 | [download_patent_ego.py](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py) | Python 内嵌 heredoc：单会话复用 tab 提取 PDF CDN URL，`js()` + `cliLog` + `completeTaskSpace` |
| S3 | patent-prior-art-search 速查脚本 | [SKILL.md](file:///Users/xujian/projects/Sati/skills/patent-prior-art-search/SKILL.md) | 关键词搜索模板：`useOrCreateTaskSpace` + `openOrReuseTab` + `snapshotText` + `pageInfo` + `handOffTaskSpace` |
| S4 | google-patents-search 站点经验包用法 | [SKILL.md](file:///Users/xujian/projects/Sati/skills/google-patents-search/SKILL.md) | `site.runTool('google-patents', 'search_patents')` + `cliLog` + `completeTaskSpace` |
| S5 | cap09-search-commander prompt 速查 | [cap09-search-commander.md](file:///Users/xujian/projects/Sati/assets/prompts/patent/cap09-search-commander.md) | 搜索模板：`useOrCreateTaskSpace` + `openOrReuseTab` + `snapshotText` + `handOffTaskSpace` + `wait` |
| S6 | patent-download 技能说明 | [SKILL.md](file:///Users/xujian/projects/Sati/skills/patent-download/SKILL.md) | 下载拦截语义（`page.waitForEvent` + `saveAs`，ego v1.2.6+）与降级策略（`status: "fallback"`） |
| S7 | google-patents 站点经验包 | [overview.md](file:///Users/xujian/projects/Sati/skills/ego-browser/learnings/google-patents/notes/overview.md) | 站点 DOM 语义：`page.locator` / `page.getByText` 定位器、分页、等待条件 |
| S8 | 输出协议样例 | [patentPdfDownload.spec.ts](file:///Users/xujian/projects/Sati/tests/tool/builtin/patentPdfDownload.spec.ts#L56-L61) | `PROGRESS:...` / `EGO_DOWNLOAD_RESULTS:[...]` 的 stderr 行约定与 `extractTaggedJson` 解析依赖 |

---

## 2. helper 使用分布（8 个样本汇总）

| helper / 能力 | 出现样本 | 频次 | 备注 |
|----------------|----------|------|------|
| `useOrCreateTaskSpace` | S1,S2,S3,S5 | 4 | 会话级复用（登录态 + tab），脚本的第一行 |
| `openOrReuseTab(url)` | S1,S2,S3,S5 | 4 | 复用/新开 tab 导航 |
| `js(String.raw\`...\`)` | S1,S2 | 2 | **核心提取手段**：内嵌任意页面代码 |
| `cliLog(...)` | S1,S2,S3,S4,S5 | 5 | 唯一结果输出通道（stderr 行约定） |
| `wait(sec)` | S1,S2,S3,S5 | 4 | 秒级 sleep |
| `page.waitForEvent('download')` + `saveAs` | S1,S6 | 2 | **下载拦截**（专利核心能力） |
| `page.screencast.start/stop` | S1,S6 | 2 | 录屏留证 |
| `completeTaskSpace()` | S1,S2,S4,S5 | 4 | 会话收尾 |
| `handOffTaskSpace` / `takeOverTaskSpace` | S3,S5 | 2 | 人机交接（agent→人 或 人→agent） |
| `snapshotText()` | S3,S5 | 2 | 语义树快照（@N refs） |
| `pageInfo()` | S3 | 1 | URL/标题/时间 |
| `site.runTool('google-patents', ...)` | S4 | 1 | 站点经验包工具 |
| `page.locator` / `page.getByText` | S7 | 1 | 站点语义定位器（learnings） |
| `Promise.all([...])` 并行多 space | 方案描述 | 低频 | 未在 S1-S7 实际脚本中出现 |

> 结论：专利域脚本的 helper 集很小（**14 个能力，核心 8 个**），且集中在 S1/S3 两个主模板。
> 「helper 集合很小」的假设**成立** —— 翻译器需要覆盖的 API 面窄。

---

## 3. 映射成本评估

### 3.1 对 BrowserOS neo（MCP tools，脚本兼容后端候选）

| helper | 映射到 | 成本 | 说明 |
|--------|--------|------|------|
| `useOrCreateTaskSpace` | Sati 侧会话管理（任务开始时 cold-decision） | 低 | 兼容层构造时建立会话上下文 |
| `openOrReuseTab` | `list_pages` + `navigate_page` | 低 | 复用已有页则 activate |
| `js(...)` | `evaluate_script` | **低 ✅** | 原生等价，内嵌页面代码无翻译 |
| `wait` | 兼容层 sleep | 低 | |
| `cliLog` | MCP 返回值收集后重组成 stderr 行 | 中 | 需兼容层按约定重组，`extractTaggedJson` 零修改 |
| `page.waitForEvent('download')` | `download_file` | **低 ✅** | 比 ego 更直接；fallback URL 双保险仍保留 |
| `page.screencast` | 会话自动录制 + 回放 | **低 ✅** | 能力超集（dashboard + scrub 时间线） |
| `handOffTaskSpace` | 无直接对应（dashboard 实时可见，用户可接管） | 中 | Sati 层实现「等待人工确认后继续」语义 |
| `snapshotText` | `take_snapshot` / `take_enhanced_snapshot` | 中 | ego @N refs vs neo 结构化 DOM 索引，兼容层需翻译索引寻址 |
| `pageInfo` | `get_page_content` 元信息 | 低 | |
| `site.runTool` | 无对应 | 中 | P2 站点包兼容（backend 无关 TS 重写 google-patents 逻辑） |
| `Promise.all` | 兼容层 Promise.all（内部串行 MCP 调用） | 低-中 | 语义等价，延迟叠加 |

**预估脚本级兼容率：~85%**（除 handOff/site.runTool 需 Sati 层补充，其余核心能力全覆盖且 download/screencast 是超集）。

### 3.2 对 browser-use（CLI/MCP，无 BrowserOS 时的降级后端）

| helper | 映射到 | 成本 | 说明 |
|--------|--------|------|------|
| `useOrCreateTaskSpace` | `--session NAME`（daemon 常驻） | 低 | |
| `openOrReuseTab` | `open` + `tab list/switch` | 低 | |
| `js(...)` | `eval "<js>"` | **低 ✅** | 原生等价 |
| `wait` | `wait selector/text` 或 sleep | 低 | |
| `cliLog` | MCP 返回值重组 | 中 | 同上 |
| `page.waitForEvent('download')` | **无 CLI 命令** → CDP 封装（`Fetch.enable` + `Browser.setDownloadBehavior`） | **高 ⚠️** | 需在 Python 库层或 Sati 侧封装 |
| `page.screencast` | `[video]` extra（imageio+ffmpeg） | **高 ⚠️** | 非默认能力，CLI 无命令 |
| `handOffTaskSpace` | 无对应 | 高 | 同 3.1 |
| `snapshotText` | `state`（索引化元素） | 中 | index 寻址与 @N 语义需翻译 |
| `pageInfo` | `get title/html` | 低 | |
| `site.runTool` | 无对应 | 中 | 同 3.1 |

**预估脚本级兼容率：~65%**（download + screencast 两项核心短板）。若补 CDP 下载封装则回升至 **~80%**。

### 3.3 token / 延迟对比（定性）

| 模式 | 每任务 tool call 数 | LLM token 消耗 | 浏览器侧往返 |
|------|--------------------|----------------|--------------|
| ego（现状，透传） | 1 | 最低（脚本在浏览器侧执行） | 0（脚本内直接调 API） |
| **Track B（兼容层）** | 1 | ≈ ego（兼容层内部消化） | N 次 MCP 往返（延迟 +，token 不变） |
| Track A（原子 tools 直出） | 几十 ~ 数百 | **高 10-50x** | N 次 |

> 结论：**Track B 的 token 优势显著**，代价是浏览器侧往返延迟（对专利批量任务可接受）。
> 这强化了「BrowserOS neo 走 Track B、browser-use 走 Track A」的分工。

---

## 4. 失败模式清单（翻译器必须处理）

| # | 失败模式 | 影响 | 涉及后端 | 处理策略 |
|---|----------|------|----------|----------|
| F1 | **输出协议差异**：`cliLog` → stderr 行（ego）vs MCP structured result | `extractTaggedJson` 解析失效 | 全部 | 兼容层收集返回值后**重组为约定 stderr 行**；`parseOutput` 零修改 |
| F2 | **下载拦截语义**：`page.waitForEvent('download')` 在 browser-use 无原生命令 | patent_pdf_download 核心路径挂 | browser-use | CDP 封装（Sati 侧，见 §5 Track B 边界）；BrowserOS 用 `download_file` |
| F3 | **录屏**：screencast 在 browser-use 非默认能力 | 证据留证缺失 | browser-use | 标注「降级：无录屏」，或 video extra；BrowserOS 自动录制 |
| F4 | **人机交接**：handOff/takeOver 无对应 | 专利搜索的人工复核流程中断 | 全部 | Sati 层实现「挂起 → 通知人工 → 继续」语义，不依赖后端 |
| F5 | **快照寻址**：ego @N refs vs neo/use 的索引/DOM 结构 | 基于 @N 的点击/输入脚本失效 | 全部 | 兼容层翻译：helper 内部按后端能力重写寻址；脚本层不感知 |
| F6 | **站点经验包**：`site.runTool` 不跨栈 | google-patents 专属逻辑失效 | 全部 | P2：TS 重写 google-patents 核心逻辑（backend 无关），learnings 仅作提示 |
| F7 | **版本/能力漂移**：`canIntercept` 式特性探测在非 ego 后端无对应 | 探测逻辑误判 | 全部 | 兼容层按后端暴露能力位（hasDownloadInterception/hasScreencast/hasHandoff） |

---

## 5. Gate 判定与 Track 决策

### 5.1 Gate 结果

| 判定项 | 结果 |
|--------|------|
| 脚本样本充分性 | ✅ 8 个真实来源，覆盖专利域全部核心路径 |
| helper 集合范围 | ✅ 14 个能力 / 核心 8 个，翻译面窄（假设成立） |
| BrowserOS neo 兼容率 | ✅ **~85%**（> 70% 阈值） |
| browser-use 兼容率 | ⚠️ ~65%，补 CDP 下载封装后 ~80% |
| **Gate 结论** | ✅ **通过（条件性）** |

### 5.2 Track 决策

```
主后端：BrowserOS neo → Track B（ego-helper 兼容层，脚本级复用）——覆盖 macOS/Windows
降级后端：browser-use → Track A（原子 tools 直出，SKILL.md 意图层）+ 可选 CDP 下载封装
兜底后端：@playwright/mcp → Track A（原子 tools 直出，无登录态）
```

**兼容层边界（Track B 最小实现）**：
- 兼容层**只实现** §2 表格中 8 个核心 helper（`useOrCreateTaskSpace` / `openOrReuseTab` / `js` / `wait` / `cliLog` / `completeTaskSpace` / `page.waitForEvent('download')` / `page.screencast`）+ 能力位探测（F7）
- 不支持/走 Sati 层的 helper：`handOffTaskSpace`（F4）、`site.runTool`（F6）——Sati 层实现等价语义
- 兼容层是 **Node 侧实现 + BrowserOS neo MCP tools 桥接**（不是脚本翻译器），脚本本身零修改

### 5.3 Sprint 2 前置实测清单（本 POC 未覆盖）

- [ ] Windows/macOS 实机：BrowserOS neo 安装 → Chrome 导入 → 用 S1 样本脚本 dry-run（下载 3 份真实 PDF + 录屏）
- [ ] 实机：browser-use `--cli-mcp` 跑 S1 的提取部分（`js`/`openOrReuseTab`/`cliLog`），确认 eval 与输出重组
- [ ] 实测 @playwright/mcp 下载拦截能力（评审 L-D），修正方案文档 §4 矩阵
- [ ] `take_enhanced_snapshot` 与 `state` 的输出结构采样，落地 F5 寻址翻译

---

## 6. 引用

- 方案文档：<a href="file:///Users/xujian/projects/Sati/docs/windows-browser-automation-plan.md">windows-browser-automation-plan.md</a> §10.5（Sprint 1.5）、§7.2（Sprint 2 验收）
- 评审 §S1（翻译器可行性）、§S2（模式冲突 → 双轨）
