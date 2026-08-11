# 正念智能体 (Sati) 桌面端 UI 美化计划

> **编制人**: UI Designer  
> **日期**: 2026-08-03  
> **范围**: Electron 桌面端 + Web UI (React + Tailwind CSS 3 + shadcn/ui)  
> **状态**: ✅ 已实施（2026-08-04 落地，验收报告见 `overview.md`）｜本文档为历史计划快照，其中技术栈描述（React 18 / Vite 7 / Tailwind 3）为编制时状态，现行技术栈（React 19 / Vite 8 / Tailwind 4 / Express 5）见 `CLAUDE.md`

---

## 一、现状分析

### 1.1 技术栈
| 层 | 技术 |
|---|---|
| 桌面壳 | Electron (apps/desktop/) |
| Web UI | React 18 + Vite 7 + Tailwind CSS 3 |
| 组件库 | shadcn/ui 风格自定义组件 |
| 图标 | Lucide React |
| 主题 | CSS 变量 + `.dark` class 暗色模式 |
| 字体 | InterVariable / system-ui |

### 1.2 当前视觉问题诊断

| 编号 | 问题 | 严重度 | 影响范围 |
|---|---|---|---|
| P1 | 主应用完全无品牌色 — 整个色板为 zinc/neutral 灰阶，启动页的蓝色 `#4f9cff` 未延伸到主界面，品牌感断裂 | 高 | 全局 |
| P2 | 侧边栏视觉层次扁平 — 选中态仅靠 `bg-neutral-200/70` 区分，无左侧高亮条、无品牌色注入 | 中 | Sidebar |
| P3 | 聊天消息缺乏视觉容器感 — 消息行无气泡/卡片包裹，长对话难以快速扫读 | 中 | Chat |
| P4 | 输入框 (Composer) 缺乏聚焦态视觉反馈 — 无品牌色聚焦环，仅依赖默认 border 变化 | 中 | Composer |
| P5 | 暗色模式对比度偏低 — `--background: 0 0% 4%` 纯黑背景与 `--card: 0 0% 4%` 相同，卡片与背景无分离 | 中 | 全局暗色 |
| P6 | 滚动条过粗 — 全局 8px 滚动条在窄容器中视觉噪音过大 | 低 | 全局 |
| P7 | 空状态缺乏引导 — 项目列表/会话列表为空时仅一行灰色文字 | 低 | Sidebar |
| P8 | 启动页与主应用风格割裂 — 启动页用深蓝面板+蓝色进度条，主应用纯灰阶 | 低 | Splash → Main |

### 1.3 现有设计令牌 (已建立的优点，需保留)
- HSL 色彩变量体系 (`--background`, `--foreground`, `--primary` 等)
- 完整的暗色模式覆盖
- Nav glass 毛玻璃效果令牌 (`--nav-glass-bg`, `--nav-glass-blur`)
- 统一的 transition 系统 (150ms / 200ms / 300ms)
- Lucide 图标一致性
- 良好的无障碍基础 (focus-visible, ARIA, keyboard nav)
- `prefers-reduced-motion` 支持

---

## 二、设计方向

### 2.1 核心理念
> **「静水深流」** — 正念 (Sati) 意为"觉察"，UI 应如静水般清澈、沉稳，在需要时泛起微光。

- **克制而有辨识度**: 引入一个品牌主色作为"微光"，不喧宾夺主
- **层次清晰**: 通过微妙的高程 (elevation) 和间距创造视觉节奏
- **一致性优先**: 启动页 → 引导页 → 主应用共享同一视觉语言

### 2.2 品牌色方案

采用启动页已有的 `#4f9cff` 作为品牌主色，延伸到主应用：

```css
:root {
  /* 品牌色 — 正念蓝 */
  --brand-50:  214 100% 97%;
  --brand-100: 214 95%  93%;
  --brand-200: 213 97%  87%;
  --brand-300: 212 96%  78%;
  --brand-400: 213 94%  68%;
  --brand-500: 213 94%  60%;  /* #4f9cff — 主色 */
  --brand-600: 215 82%  51%;  /* 悬停态 */
  --brand-700: 216 72%  43%;  /* 按下态 */
  --brand-800: 217 78%  35%;
  --brand-900: 218 80%  28%;
}

.dark {
  --brand-500: 213 94%  64%;  /* 暗色模式提亮 */
  --brand-600: 213 94%  60%;
}
```

**使用规则**:
- 选中态指示 (侧边栏、Tab)
- 聚焦环 (input focus ring)
- 主操作按钮
- 进度条 / 加载动画
- 未读消息圆点
- 链接文本

---

## 三、分阶段实施计划

### 阶段 1: 设计令牌基建 (Token Foundation)

**目标**: 建立品牌色体系、优化暗色模式层次、统一高程系统

| 任务 | 文件 | 改动 |
|---|---|---|
| 1.1 注入品牌色变量 | `ui/src/index.css` `:root` 和 `.dark` | 添加 `--brand-*` HSL 变量族 |
| 1.2 扩展 Tailwind 配置 | `ui/tailwind.config.js` `colors.brand` | 映射 `brand-50` 到 `brand-900` |
| 1.3 提升暗色模式层次 | `ui/src/index.css` `.dark` | `--card: 0 0% 7%` (从 4% 提升到 7%)，`--popover: 0 0% 9%` |
| 1.4 建立高程令牌 | `ui/src/index.css` | `--elevation-1` 到 `--elevation-4` 阴影变量 |
| 1.5 优化全局滚动条 | `ui/src/index.css` | 全局滚动条从 8px → 6px，添加 `hover` 变细效果 |
| 1.6 统一圆角体系 | `ui/src/index.css` | 确认 `--radius: 0.625rem` (10px) 作为主圆角 |

**高程系统**:
```css
:root {
  --elevation-1: 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --elevation-2: 0 2px 8px -2px rgb(0 0 0 / 0.08), 0 1px 3px 0 rgb(0 0 0 / 0.04);
  --elevation-3: 0 8px 24px -4px rgb(0 0 0 / 0.10), 0 2px 6px -2px rgb(0 0 0 / 0.06);
  --elevation-4: 0 16px 48px -8px rgb(0 0 0 / 0.14), 0 4px 12px -4px rgb(0 0 0 / 0.08);
}
```

---

### 阶段 2: 侧边栏 (Sidebar) 美化

**目标**: 增加品牌色注入、提升选中态辨识度、优化空状态

| 任务 | 组件 | 改动 |
|---|---|---|
| 2.1 选中态品牌色注入 | `SidebarV2.tsx` `renderProjectGroup` | 选中项目行添加 `border-l-2 border-brand-500` 左侧高亮条 |
| 2.2 会话选中态优化 | `SidebarV2.tsx` `renderSessionTreeNode` | 选中会话用 `bg-brand-50 dark:bg-brand-950/30` 替代 `bg-neutral-200/70` |
| 2.3 Section toggle 品牌色 | `SidebarV2.tsx` section toggle | 选中 tab 用 `bg-white text-brand-600 dark:bg-neutral-700 dark:text-brand-400` |
| 2.4 未读消息指示器 | `SidebarV2.tsx` `SessionStatusIndicator` | 保持 `bg-blue-500` → 改为 `bg-brand-500` 统一 |
| 2.5 设置按钮悬停态 | `SidebarV2.tsx` 底部 Settings 按钮 | 悬停时 `text-brand-600 dark:text-brand-400` |
| 2.6 空状态优化 | `SidebarV2.tsx` "No projects found" | 替换为带图标 + 引导文案的空状态组件 |
| 2.7 Logo 区域微调 | `SidebarV2.tsx` logo header | 添加底部 1px 渐变分隔线 (已有 `.nav-divider` 工具类) |
| 2.8 拖拽手柄品牌色 | `SidebarV2.tsx` resize handle | 拖拽中 `bg-brand-500/60` 保持，悬停态加 `bg-brand-400/40` |

---

### 阶段 3: 主内容区 (MainArea) 美化

**目标**: 提升面包屑导航质感、优化 Tab 选中态

| 任务 | 组件 | 改动 |
|---|---|---|
| 3.1 面包屑品牌色 | `MainAreaV2.tsx` header | 项目名用 `text-brand-600 dark:text-brand-400`，分隔符保持 muted |
| 3.2 Tab 选中态统一 | `MainAreaV2.tsx` Files/Search/Dashboard | 选中态用 `ACTIVE_TOOL_BUTTON_CLASS` 中的 blue → 统一到 `brand` 色系 |
| 3.3 头部底部分隔线 | `MainAreaV2.tsx` header | 添加 `border-b border-neutral-200/60 dark:border-neutral-800/60` |
| 3.4 面板阴影优化 | `MainAreaV2.tsx` 右侧面板 | 使用 `--elevation-3` 阴影替代当前 `shadow-lg` |

---

### 阶段 4: 聊天界面 (Chat) 美化

**目标**: 提升消息可读性、优化 Composer 视觉反馈

| 任务 | 组件 | 改动 |
|---|---|---|
| 4.1 消息行间距优化 | `MessagesPaneV2.tsx` | 消息组间增加 `gap-3`，组内消息 `gap-1` |
| 4.2 Agent 消息卡片化 | `MessageRowV2.tsx` | Agent 回复用 `bg-neutral-50 dark:bg-neutral-900/50 rounded-lg p-4` 轻卡片包裹 |
| 4.3 Composer 聚焦环 | `ComposerV2.tsx` | 聚焦时 `ring-2 ring-brand-500/20 border-brand-400` |
| 4.4 发送按钮品牌色 | `ComposerV2.tsx` 发送按钮 | `bg-brand-500 hover:bg-brand-600 text-white` |
| 4.5 代码块优化 | `MessagesPaneV2.tsx` code blocks | 添加 `ring-1 ring-neutral-200 dark:ring-neutral-800` 替代纯 border |
| 4.6 打字机光标品牌色 | `useTypewriter.ts` | 光标颜色 `text-brand-500` |
| 4.7 处理中状态指示 | `ProcessTrace.tsx` | 进度条用 `bg-brand-500` |

---

### 阶段 5: 启动页 & 引导页 (Splash & Onboarding) 对齐

**目标**: 统一启动体验与主应用的视觉语言

| 任务 | 文件 | 改动 |
|---|---|---|
| 5.1 启动页品牌色对齐 | `apps/desktop/splash/splash.html` | `--accent: #4f9cff` 保持，添加 `--accent-subtle: rgba(79,156,255,0.08)` 背景晕染 |
| 5.2 启动页 logo 优化 | `splash.html` | logo 区域添加微光动画 (`box-shadow: 0 0 24px rgba(79,156,255,0.15)`) |
| 5.3 引导页按钮品牌色 | `onboarding.html` | 主按钮已有 `--accent`，确认与主应用 `brand-500` 一致 |
| 5.4 引导页输入框聚焦 | `onboarding.html` | 聚焦时添加 `box-shadow: 0 0 0 3px rgba(79,156,255,0.12)` |
| 5.5 引导页预设按钮选中态 | `onboarding.html` | 选中预设添加 `border-color: var(--accent); background: rgba(79,156,255,0.06)` |

---

### 阶段 6: 全局润色 (Polish)

**目标**: 统一细节、提升微交互品质

| 任务 | 文件 | 改动 |
|---|---|---|
| 6.1 选中态过渡动画 | `index.css` | 添加 `transition: background-color 200ms, border-color 200ms` 到选中元素 |
| 6.2 按钮微交互 | `index.css` | `button:active` 添加 `transform: scale(0.98)` 微缩放 |
| 6.3 链接悬停态 | `index.css` | `a:hover` 添加 `text-decoration: underline` 统一 |
| 6.4 滚动条隐藏 (侧边栏) | `SidebarV2.tsx` | 已有 `scrollbar-thin`，确认 6px 宽度 |
| 6.5 选中文本颜色 | `index.css` | `::selection { background: hsl(var(--brand-500) / 0.2); }` |
| 6.6 暗色模式边框微调 | `index.css` `.dark` | `--border: 0 0% 18%` (从 15% 提亮，增加分离感) |
| 6.7 焦点可见性增强 | `index.css` | `focus-visible` 统一用 `ring-2 ring-brand-500/40 ring-offset-2` |
| 6.8 卡片悬停高程 | `index.css` | `.card:hover` 使用 `--elevation-2` 过渡 |

---

## 四、验收标准

### 4.1 设计一致性
- [ ] 品牌色 `#4f9cff` 在主应用所有交互态中一致出现
- [ ] 启动页 → 引导页 → 主应用的视觉过渡无割裂
- [ ] 暗色模式卡片与背景有可感知的层次分离

### 4.2 无障碍 (WCAG AA)
- [ ] 品牌色文本与背景对比度 ≥ 4.5:1 (brand-600/700 在浅色背景上)
- [ ] 焦点环在所有交互元素上可见
- [ ] 键盘导航不受影响
- [ ] `prefers-reduced-motion` 继续生效

### 4.3 性能
- [ ] 不引入新的大体积资源 (使用 CSS 变量和 Tailwind utility)
- [ ] 不增加 runtime 包体积 (纯样式变更)
- [ ] 过渡动画 60fps (仅 transform/opacity/background-color)

### 4.4 测试
- [ ] 现有 UI 测试全部通过 (`vitest`)
- [ ] 生产构建成功 (`pnpm build`)
- [ ] 暗色/浅色模式切换无闪烁
- [ ] 桌面端 + Web 端表现一致

---

## 五、实施顺序与依赖

```
阶段 1 (令牌基建)
  ├── 阶段 2 (侧边栏) — 依赖 1.1, 1.2
  ├── 阶段 3 (主内容区) — 依赖 1.1, 1.2
  ├── 阶段 4 (聊天界面) — 依赖 1.1, 1.2, 1.4
  └── 阶段 5 (启动/引导页) — 独立
阶段 6 (全局润色) — 依赖 1~5 完成
```

阶段 2-5 之间无依赖，可并行实施。阶段 6 为收尾，需在 1-5 完成后进行全局回归。

---

## 六、风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| 品牌色注入后与现有 blue-* 类名冲突 | 中 | Tailwind 的 `blue-500` 与自定义 `brand-500` 独立命名空间，不冲突 |
| 暗色模式层次调整影响现有组件 | 低 | 仅调整 `--card` 和 `--border` 令牌值，所有引用自动跟随 |
| 消息卡片化改变聊天布局密度 | 中 | 先在 `MessageRowV2` 做 A/B 对比，确认不影响信息密度 |
| 启动页 CSS 变更无法热重载 | 低 | 启动页为静态 HTML，需重启 Electron 验证 |

---

## 七、已完成项

> **实施状态：6 个阶段全部完成**（2026-08-03 ~ 08-04，落地记录见 `overview.md`）。以下为原始计划验收项，均已达成并通过 QA（445/445 UI 测试、TypeScript 零错误、品牌色全量迁移 blue-* → brand-* 339 处、用户可见 "Sati" 残留清零）。

- [x] 桌面端 logo 旁添加"正念智能体"文字 (SidebarV2.tsx, splash.html, onboarding.html, main.ts, splash-window.ts, onboarding-window.ts, manifest.json, index.html)
- [x] 阶段 1 设计令牌基建：品牌色阶 `--brand-50`~`--brand-900`、四层高程阴影、暗色模式层次提升（card 4%→7%）、Tailwind brand-* 映射、滚动条 8px→6px
- [x] 阶段 2 侧边栏美化：项目/会话选中态品牌色 + 左侧高亮条、未读指示器、空状态引导、拖拽手柄品牌色
- [x] 阶段 3 主内容区美化：面包屑、Tab 选中态、头部分隔线、面板高程
- [x] 阶段 4 聊天界面美化：Composer 聚焦环、发送按钮、MessageRowV2、代码块、打字机光标品牌色
- [x] 阶段 5 启动页 & 引导页对齐：splash 径向渐变晕染 + logo 微光、onboarding 聚焦态与预设按钮
- [x] 阶段 6 全局润色：`::selection`、`button:active` 微缩放、focus-visible 品牌色、卡片 hover 高程
- [x] 全量修复：blue-* → brand-* 迁移（50 文件 339 处，保留 fileIcons/MessageComponent 语义色）、"Sati" → "正念智能体" 品牌名统一（9 文件，保留 Agent 标识符/文件系统路径/测试数据）

> 注：本计划基于 Vite 7 编写；UI 已随依赖升级到 **Vite 8**（vite ^8.2.0），样式与构建链路不受影响。
