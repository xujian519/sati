# 概览：桌面端 UI 美化实施 + Logo 文字添加 + 代码质量审阅 + 全量修复

> **文档定位**：本文档是 2026-08-03 ~ 08-04 的一次性 UI 美化实施记录（含两轮代码质量修复的完整清单与验证结果），作为 `ui-beautification-plan.md` 的落地验收报告保留。项目整体概览见 `README.md` 与 `CLAUDE.md`；后续 UI 演进（品牌色体系即由此确立，技术栈已升级至 Vite 8）见 `CHANGELOG.md`。

## 完成内容

### 1. 桌面端 Logo 旁添加"正念智能体"文字

在桌面端所有用户可见的位置将品牌名称从 "Sati" 更新为"正念智能体"：

| 文件 | 改动 |
|---|---|
| `ui/src/components/app-shell/SidebarV2.tsx` | Logo 从 wordmark 切换为图标 + "正念智能体"文字 |
| `apps/desktop/splash/splash.html` | 启动页 logo 改为"正念智能体 Sati" |
| `apps/desktop/onboarding/onboarding.html` | 引导页标题改为"初始化正念智能体" |
| `apps/desktop/src/main.ts` | 所有 Electron 窗口 title + macOS 菜单标签更新 |
| `apps/desktop/src/onboarding-window.ts` | 引导窗口 title 更新 |
| `apps/desktop/src/splash-window.ts` | 启动窗口 title 更新 |
| `apps/desktop/src/server-manager.ts` | Gateway 启动进度消息更新 |
| `ui/index.html` | 页面 title 更新 |
| `ui/public/manifest.json` | PWA name/short_name 更新 |

### 2. UI 美化计划 + 全部 6 阶段实施完成

#### 阶段 1: 设计令牌基建
- 注入 `--brand-50` 到 `--brand-900` HSL 品牌色阶（正念蓝 #4f9cff）
- 建立四层高程阴影系统 `--elevation-1` 到 `--elevation-4`（含暗色模式）
- 暗色模式层次提升：`--card` 从 4% → 7%，`--popover` 从 9% → 11%，`--border` 从 15% → 18%
- Tailwind 配置映射 `brand-*` 色系 + `shadow-elevation-*` 工具类
- 全局滚动条从 8px → 6px

#### 阶段 2: 侧边栏美化
- 项目选中态：品牌色背景 + 左侧 2px 品牌色高亮条
- 会话选中态：品牌色淡背景
- Section toggle 选中态品牌色文字
- 未读消息指示器品牌色
- 设置按钮悬停品牌色
- 空状态优化：图标 + 引导文案 + 品牌色"新建项目"按钮
- Logo 下方添加渐变分隔线
- 拖拽手柄品牌色

#### 阶段 3: 主内容区美化
- `ACTIVE_TOOL_BUTTON_CLASS` 从 `blue-*` → `brand-*`
- 面包屑项目名 + Box 图标品牌色
- Dashboard 菜单悬停品牌色
- 未读 badge 品牌色
- 头部分隔线可见度提升

#### 阶段 4: 聊天界面美化
- Composer 聚焦环：`ring-2 ring-brand-500/20 border-brand-400`
- 发送按钮：`bg-brand-500 hover:bg-brand-600`
- AgentTimeline spinner 品牌色
- MessageRowV2 thinking summary/border 品牌色
- DocumentReferenceChip 品牌色
- MessageFileCards 品牌色
- 所有 `focus-visible:ring-blue-500` → `ring-brand-500`

#### 阶段 5: 启动页 & 引导页对齐
- Splash：品牌色径向渐变背景晕染 + logo 微光 text-shadow
- Onboarding：输入框聚焦 `box-shadow: 0 0 0 3px rgba(79,156,255,0.12)`
- Onboarding：预设按钮选中态 `.preset-btn.active`

#### 阶段 6: 全局润色
- `::selection` 品牌色背景
- `button:active` 微缩放 `scale(0.98)`
- 统一 `focus-visible` 品牌色 outline
- `.card` hover 过渡动画

### 3. 代码质量审阅 — 第一轮修复（7 个问题）

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| 1 | P1 | `VersionBadge.tsx` 8 处 `blue-*` 未迁移 | 全部替换为 `brand-*` |
| 2 | P1 | `splash.html` title 仍为 "Sati" | → "正念智能体" |
| 3 | P1 | `onboarding.html` 保存成功消息仍引用 "Sati" | → "正念智能体" |
| 4 | P2 | `index.css` `accent-blue-600` 未迁移 | → `accent-brand-600` |
| 5 | P2 | `index.css` 暗色模式 checkbox/radio 硬编码 blue RGB | → `hsl(var(--brand-*))` |
| 6 | P2 | `focus-visible` outline 0.40 透明度偏低 | → 0.50 增强可见性 |
| 7 | P3 | `::selection` 0.20 透明度偏淡 | → 0.25 |

### 4. 全量修复 — 第二轮（69 个文件，341 处改动）

#### 4a. blue-* → brand-* 全量迁移（50 个文件，339 处替换）

将之前仅覆盖 `app-shell` + `chat-v2` 的品牌色迁移扩展到**整个 UI 代码库**：

| 模块 | 文件数 | 替换数 | 典型改动 |
|---|---|---|---|
| chat/tools | 10 | 96 | OneLineDisplay、ExitPlanModePanel、QuestionAnswerContent 等 |
| main-content-v2 | 11 | 102 | CronV2、RunDetail、DashboardV2、FilesV2 等 |
| code-editor | 8 | 40 | RegionSelectionOverlay、PdfDocumentPreview、CodeEditorTabBar 等 |
| auth | 4 | 8 | LoginForm、SetupForm、AuthInputField、AuthLoadingScreen |
| shell | 4 | 13 | Shell、ShellHeader、ShellMinimalView、TerminalShortcutsPanel |
| onboarding | 3 | 16 | AgentConnectionsStep、GitConfigurationStep、OnboardingStepProgress |
| provider-auth | 1 | 16 | ProviderLoginModal |
| settings | 1 | 12 | About 页面 |
| chat (v1) | 5 | 14 | MessageComponent、Markdown、ImageAttachment 等 |
| chat/hooks+constants | 2 | 3 | useFileMentions、thinkingModes |

**保留 blue-* 的语义色（不迁移）**：
- `fileIcons.ts`：文件类型图标颜色（TypeScript=蓝、CSS=蓝等）— 已回退
- `MessageComponent.tsx` doc/docx 徽章：文件类型色（与 pdf=红、xls=绿、ppt=橙一致）— 已回退

#### 4b. "Sati" → "正念智能体" 品牌名统一（9 个文件）

| 文件 | 位置 | 原文 | 新文 |
|---|---|---|---|
| `zh-CN/sidebar.json` | app.title | "Sati" | "正念智能体" |
| `en/sidebar.json` | app.title | "Sati" | "正念智能体" |
| `zh-CN/chat.json` | readyPrompt.claude | "...的 Sati。..." | "...的正念智能体。..." |
| `zh-CN/chat.json` | readyPrompt.sati | "...的 Sati。..." | "...的正念智能体。..." |
| `zh-CN/chat.json` | startCli | "启动 Sati CLI" | "启动正念智能体 CLI" |
| `AgentConnectionsStep.tsx` | provider title | "Sati" | "正念智能体" |
| `AuthLoadingScreen.tsx` | h1 标题 | "Sati" | "正念智能体" |
| `AuthScreenLayout.tsx` | 开源链接文字 | "Sati is open source" | "正念智能体 is open source" |
| `SetupForm.tsx` | 欢迎标题 | "Welcome to Sati" | "Welcome to 正念智能体" |
| `server-manager.ts` | Gateway 进度 | "启动 Sati Gateway…" | "启动正念智能体 Gateway…" |
| `main.ts` | macOS 菜单 (4处) | "Sati"/"关于 Sati"/"隐藏 Sati"/"退出 Sati" | "正念智能体"/"关于正念智能体"/"隐藏正念智能体"/"退出正念智能体" |
| `main.ts` | 错误消息 | "请重新安装 Sati。" | "请重新安装正念智能体。" |

**保留 "Sati" 的场景（不更改）**：
- `app.setName("Sati")` — Electron 内部应用名，影响文件系统路径
- `Application Support/Sati/` — 文件系统路径
- `chat.json` `"sati": "Sati"` — Agent 提供者标识符
- `alt="Sati"` — 图片 alt 属性（描述 logo 图标）
- 测试数据中的 `displayName: "Sati"` — 测试夹具

## 修改文件统计

**总计 69 个文件，341 处插入，217 处删除**

## 验证结果

- 全部 UI 测试: **445/445 通过** (77 个测试文件)
- TypeScript 类型检查: **零错误**
- Tailwind CSS 构建: **成功** (214 条 brand 规则生成)
- `blue-*` 残留: **仅 2 个文件**（fileIcons.ts + MessageComponent.tsx doc徽章）— 均为语义色
- 硬编码 blue RGB 值: **零残留**
- "Sati" 品牌名残留: **零用户可见残留**（仅保留 Agent 标识符、文件系统路径、测试数据）
