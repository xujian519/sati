---
name: xhs-orchestrator
description: >-
  小红书全链路编排技能。收到用户话题后，通过交互式确认收集需求（头图风格、Figma 推送、
  是否发布到小红书），再调度子技能执行。子技能包括：头图生成（brief-to-xhs-header）、
  登录（xiaohongshu-login）、发布（xiaohongshu-publish）、审核（xiaohongshu-audit）。
  凡涉及"帮我做/发小红书"、"笔记"、"头图"等意图时自动激活。
---

# 小红书全链路编排

收到用户话题后，先交互确认需求，再编排执行。**不要假设用户想要什么，要问。**

## 子技能清单

| ID | 职责 |
|----|------|
| `brief-to-xhs-header` | Brief → 头图 PNG（+ 可选 Figma 推送） |
| `xiaohongshu-login` | 小红书登录/会话管理 |
| `xiaohongshu-publish` | 上传图片 + 填写标题正文（停在发布前） |
| `xiaohongshu-audit` | 发布前合规审核 |

---

## 编排模式（Orchestrator Mode）

**如何判断你是否在编排模式下运行**：检查你的可用工具列表。如果只有
`agent`、`read_file`、`grep`、`glob`、`read_skill` 这几个工具，说明
router 已将你切换为编排主 agent——你不能直接执行 `bash`、`web_search`、
`browser_*` 等工具，必须通过 `agent` 工具委派子 agent 来执行。

### 编排模式硬规则

1. **跳过交互确认**——直接执行完整路径（搜索 + 头图 + 文案）
2. **先 `read_skill` 读取子技能**——委派前先读取对应 SKILL.md，提取关键步骤嵌入 prompt
3. **子 agent prompt 必须自包含**——子 agent 看不到你的对话历史，所有路径、格式、约束必须写在 prompt 里
4. **共享工作目录 `/tmp/xhs-workspace/`**——所有子 agent 输出都用这个绝对路径
5. **一次 reply 内同时发出 plan + 第一个 agent 调用**——不要只 plan 不执行

### 编排模式执行流程

```
1. read_skill("brief-to-xhs-header")  — 了解头图生成步骤
2. agent: 搜索素材      → /tmp/xhs-workspace/posts.md
3. agent: 生成头图       → /tmp/xhs-workspace/header/output.png
4. agent: 撰写文案       → /tmp/xhs-workspace/copy.md
5. 汇总报告给用户
6. (可选) agent: 发布到小红书 — 使用模板 D，仅在用户明确要求发布时执行
```

所有步骤串行执行。每个子 agent 完成后，用 `read_file` 或 `glob` 验证产出文件存在再推进下一步。

### 子 Agent Prompt 模板

以下模板中的 `{topic}` 替换为用户指定的话题。

#### 模板 A：搜索素材

```
你的任务：搜索「{topic}」最新信息，保存到文件，然后截图。

严格按以下顺序执行，不可调换：

步骤 1. 用 bash 创建目录：mkdir -p /tmp/xhs-workspace/assets
步骤 2. 用 web_search 搜索 "{topic} latest"，从结果摘要中提取 3-5 条信息
步骤 3. 立即用 write_file 保存到 /tmp/xhs-workspace/posts.md（格式见下方）
步骤 4. 从搜索结果中选 1 个最有代表性的 URL，用 bash 截图：
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
          --headless=new --screenshot=/tmp/xhs-workspace/assets/source-1.png \
          --window-size=1000,800 --disable-gpu --force-device-scale-factor=2 \
          "<URL>"
步骤 5. 回复文件路径和截图数量

关键约束（违反则任务失败）：
- 最多使用 6 次 tool call
- 步骤 3（write_file）必须在步骤 4（截图）之前完成
- 禁止使用 web_fetch 工具——太慢，只用 web_search 的结果摘要
- 如果截图失败，跳过，但 posts.md 必须被写入

posts.md 格式：
# {topic} 最新资讯
## 1. [标题]
- 来源: [URL]
- 摘要: [1-2 句话]

## 2. ...

## 截图素材
- /tmp/xhs-workspace/assets/source-1.png — [描述]
```

#### 模板 B：生成小红书头图

```
你的任务：基于素材生成小红书头图 PNG。

前置文件（由上一步子 agent 产出）：
- /tmp/xhs-workspace/posts.md — 话题资讯汇总
- /tmp/xhs-workspace/assets/ — 截图素材（可能有 source-1.png 等）

步骤：
1. 用 read_file 读取 /tmp/xhs-workspace/posts.md，了解话题内容
2. 用 bash 确认 /tmp/xhs-workspace/assets/ 下有哪些截图：
   ls -la /tmp/xhs-workspace/assets/
3. 创建目录：mkdir -p /tmp/xhs-workspace/header/assets
4. 如果 assets 中有截图，复制到 header 子目录：
   cp /tmp/xhs-workspace/assets/*.png /tmp/xhs-workspace/header/assets/ 2>/dev/null
5. 编写一个完整的 HTML 文件，用 python3 写入 /tmp/xhs-workspace/header/header.html：
   - 尺寸：1242x1660（小红书 3:4）
   - body 使用 overflow:hidden + 固定宽高
   - 引入 Google Fonts Noto Sans SC
   - 截图用 object-fit:contain 完整显示
   - 设计风格：扁平纯色背景（#000/#fff/#e63930 等），大标题粗体
   - 禁止用 radial-gradient、glass-morphism、neon glow 等 AI 风效果
   - 禁止用 emoji 直接写在 HTML 中（用 HTML entity 如 &#128293;）
   - 图片引用用相对路径 assets/source-1.png
6. 用 Chrome headless 渲染 PNG：
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless=new --screenshot=/tmp/xhs-workspace/header/output.png \
     --window-size=1242,1660 --disable-gpu --force-device-scale-factor=1 \
     "file:///tmp/xhs-workspace/header/header.html"
7. 用 bash 确认 output.png 存在且大小合理：
   ls -la /tmp/xhs-workspace/header/output.png

完成后回复 /tmp/xhs-workspace/header/output.png 的文件路径和字节大小。
```

#### 模板 C：撰写小红书文案

```
你的任务：基于素材撰写小红书风格的图文笔记文案。

前置文件：
- /tmp/xhs-workspace/posts.md — 话题资讯汇总

步骤：
1. 用 read_file 读取 /tmp/xhs-workspace/posts.md
2. 撰写小红书风格文案

标题要求（写 2 个备选）：
- 标题 A（争议/情绪型）：≤20 字，引发好奇或争议
- 标题 B（干货/信息型）：≤20 字，突出实用价值

正文要求：
- 200-500 字，口语化短句
- 结构：开头钩子（1 句话抓眼球）→ 亮点列表（3-5 条 emoji 编号）→ 观点总结 → 互动提问（引导评论）
- 末尾 5-8 个 #话题标签
- 不要用营销腔/公文腔，像朋友分享一样写

3. 使用 write_file 保存到 /tmp/xhs-workspace/copy.md

输出格式（写入 /tmp/xhs-workspace/copy.md）：
# 标题备选
## A. [争议型标题]
## B. [干货型标题]

# 正文
[完整正文内容，含话题标签]

完成后回复文件路径和两个备选标题。
```

#### 模板 D：发布到小红书

```
你的任务：在小红书发布页填写图文笔记（不点击发布按钮）。

前置数据（已由前序子 agent 确认存在，不要用 bash 搜索或验证）：
- 图片: /tmp/xhs-workspace/header/output.png
- 标题: {title}
- 正文: {body}

严格按以下步骤操作，每步必须调用真实 tool：

步骤 1. browser_navigate 打开 https://creator.xiaohongshu.com/publish/publish
步骤 2. browser_snapshot 确认页面已加载且已登录
        如果 URL 含 "login" → 未登录，终止并报告
步骤 2b. 页面默认在"上传视频"标签。用 browser_evaluate 切换到"上传图文"：
         expression: "document.querySelectorAll('span.title').forEach(el => { if (el.textContent.trim() === '上传图文') el.click(); }); 'switched'"
         （注意：不要用 browser_click 点击标签 ref，会超时。必须用 browser_evaluate。）
步骤 2c. browser_snapshot 确认已切换到图文上传界面（应看到"拖拽或点击上传"区域）
步骤 3. browser_click 点击上传区域（拖拽上传或图片上传的可点击区域）
        这会触发文件选择对话框。响应中会出现 "File chooser" modal state 提示
步骤 4. browser_file_upload paths=["/tmp/xhs-workspace/header/output.png"]
        必须在步骤 3 触发 file chooser 之后才能调用，否则会报 "no modal state" 错误
步骤 5. browser_wait_for time=3（等待上传完成）
步骤 6. browser_snapshot 确认图片已上传（看到缩略图）
步骤 7. browser_click 标题输入框 → browser_type 输入标题
步骤 8. browser_click 正文区域 → browser_type 输入正文
步骤 9. browser_take_screenshot 截图确认

关键约束（违反则任务失败）：
- 绝对不要点击「发布」按钮
- 不要用 bash 搜索文件，图片路径已确认存在
- 最多 12 次 tool call
- 不要用 browser_evaluate 让 input[type=file] 可见——这不会触发 file chooser
```

### 编排模式汇总报告

所有子 agent 完成后，读取产出物并汇总：

```
read_file /tmp/xhs-workspace/copy.md
read_file — 确认 /tmp/xhs-workspace/header/output.png 存在
```

向用户输出：

```
═══════════════════════════════════════
  ✅ 小红书笔记素材准备完成
═══════════════════════════════════════

📸 头图：/tmp/xhs-workspace/header/output.png
📝 标题备选：
   A. {标题A}
   B. {标题B}
📄 正文：{前 50 字}...
🏷️ 话题标签：{N} 个

⚠️ 如需发布到小红书，请告知我继续执行登录 → 上传 → 发布流程。
═══════════════════════════════════════
```

---

## 直接执行模式（Interactive Mode）

以下是**非编排模式**下的标准流程。当你可以直接使用 `bash`、`web_search`、
`browser_*` 等工具时，走此流程。

## 第一阶段：交互确认（必须执行，不可跳过）

收到用户消息后，**先回复确认，不立即执行任何工具。**

### 步骤 1：确认话题

复述用户话题，确保理解正确。

### 步骤 2：询问需求

用简洁的选项列表询问用户想要什么：

```
收到！关于「{话题}」的小红书笔记，我可以帮你：

1️⃣ 生成头图（自动搜索素材 + 渲染 PNG）
2️⃣ 推送到 Figma（生成可编辑设计稿）
3️⃣ 撰写小红书文案（标题 + 正文 + 话题标签）
4️⃣ 发布到小红书（登录 → 上传 → 填写 → 停在发布按钮前）

你需要哪些？（可以多选，比如「全要」或「只要 1 和 3」）
```

### 步骤 3：等待用户回答，确定执行路径

| 用户回答示例 | 执行路径 |
|-------------|----------|
| "只要头图" | A |
| "头图 + Figma" | A（含 Figma） |
| "头图 + 文案" | A → 文案 → 展示 |
| "全要" / "1234" | A（含 Figma）→ 文案确认 → B → C → D |
| "只要文案" | 搜索资料 → 生成文案 |
| "发布"（已有图片） | B → C → D |

确认后回复一句确认再开始：

```
好的，执行：头图 → Figma → 文案 → 发布到小红书。开始！
```

**核心原则：绝对不跳过交互确认直接执行工具。**

---

## 第二阶段：执行

按用户确认的路径依次执行。每完成一步向用户汇报进度。

### 路径 A：头图生成

按 `brief-to-xhs-header` SKILL.md 执行。

1. 用 `bash` 搜索话题素材（GitHub / HuggingFace / 官网截图）
2. 生成 HTML 头图 → 渲染 1242×1660 PNG
3. 产出：`/tmp/xhs-workspace/header/output.png` + `/tmp/xhs-workspace/header/header.html`（编排模式），或 `./xhs-output/output.png`（直接执行模式）

**Figma 推送**（用户要求时）：调用 `figma_capture` 插件推送 HTML → 返回 Figma 设计稿链接。

**汇报**：向用户展示头图路径和 Figma 链接（如有），询问是否满意。

### 文案生成

搜索完资料后撰写小红书风格文案：

**标题**：≤20 字，产出 2 个备选风格（争议型 / 干货型），让用户选。

**正文**：
- 结构：开头钩子 → 亮点列表（3-5 条 emoji 编号）→ 观点总结 → 互动提问
- 200-500 字，口语化短句
- 末尾 5-8 个 `#话题标签`

**汇报**：展示完整文案，等用户确认或修改后再进入发布。

### 路径 B：登录

按 `xiaohongshu-login` SKILL.md 执行。

1. 打开 `creator.xiaohongshu.com`，检测登录状态
2. 已登录 → 告知用户当前账号
3. 未登录 → 截图二维码给用户，等待扫码

### 路径 C：发布

**发布前必须展示完整文案让用户确认**（如果之前没确认过）。

用户确认后按 `xiaohongshu-publish` SKILL.md 执行：
- 上传图片 → 填标题正文 → **停在发布按钮前**

### 路径 D：审核

按 `xiaohongshu-audit` SKILL.md 执行。全部通过后输出最终状态：

```
═══════════════════════════════════════
  ✅ 全链路完成（停在发布前）
═══════════════════════════════════════

📸 头图：/tmp/xhs-workspace/header/output.png（编排模式）或 ./xhs-output/output.png
🎨 Figma：{链接}（如有）

📝 标题：{标题}
📄 正文：{前 50 字}...
🏷️ 话题：{N} 个
📋 审核：✅ 通过

⚠️ 未点击发布。请在浏览器中确认后手动点击「发布」。
═══════════════════════════════════════
```

---

## 示例完整交互

```
用户：帮我做一条关于 VoxCPM2 的小红书笔记（清华开源语音AI）。

Agent：收到！关于「VoxCPM2 — 清华开源语音AI」的小红书笔记，我可以帮你：
       1️⃣ 生成头图  2️⃣ 推送到 Figma  3️⃣ 撰写文案  4️⃣ 发布到小红书
       你需要哪些？

用户：要 Figma，要传到小红书，全都要

Agent：好的，全链路：头图 → Figma → 文案 → 发布到小红书。开始！
       [搜索 VoxCPM2 资讯...]
       [生成头图 PNG...]
       ✅ 头图完成：./xhs-output/output.png（直接执行模式下）
       [推送到 Figma...]
       ✅ Figma 链接：https://www.figma.com/file/xxx

       📝 标题备选：
       A. 被 VoxCPM2 惊到了，清华语音AI直接封神
       B. VoxCPM2 实测：30种语言一个模型搞定
       你选哪个？正文要调整吗？

用户：选 A，正文没问题

Agent：好的，开始发布流程。
       [检测登录状态... 已登录：吃肥牛]
       [上传头图...]
       [填写标题和正文...]
       [审核中...]

       ═══════════════════════════════════════
         ✅ 全链路完成（停在发布前）
       ═══════════════════════════════════════
       ⚠️ 请在浏览器中确认后手动点击「发布」。
```

---

## 中断与恢复

| 阶段 | 失败处理 |
|------|----------|
| 头图生成 | 重试一次；仍失败则交付 HTML 源文件 |
| Figma 推送 | 失败不阻塞流程，标注「Figma 推送失败，头图 PNG 可用」 |
| 登录 | 扫码超时 → 暂停，告知用户重新触发 |
| 发布 | upload 失败重试 1 次；fill 失败切备用方案 |
| 审核 | `browser_screenshot` 失败 → 标注「建议人工确认」 |

**保留进度**：每步完成后记录状态，中途失败从断点恢复。

---

## 实战踩坑总结（E2E 测试经验）

### 各步骤实测结果

| 步骤 | Agent 独立完成 | 常见失败原因 |
|------|--------------|-------------|
| bash 截图 GitHub | ✅ 稳定 | 无 |
| bash 渲染 HTML→PNG | ✅ 稳定 | 无 |
| bash 写入 HTML 文件 | ⚠️ heredoc 超时 | 用 python3 写文件替代 |
| browser-use 登录检查 | ✅ 稳定 | 无 |
| browser-use 上传图片 | ⚠️ 需定位 file input | 先 screenshot 确认页面状态 |
| browser-use 填标题正文 | ⚠️ selector 易失效 | 先 screenshot 获取最新页面状态 |

### 关键教训

1. **bash 工具可靠，browser-use 需要强约束**：bash 调用 Chrome headless 非常稳定；browser-use 多步操作容易被模型错误使用
2. **使用 Playwright selector 定位元素**：browser-use MCP 使用 Playwright 选择器，操作前先 screenshot 确认页面状态
3. **单步执行原则**：每次只执行一个 tool call，等返回后再下一步

## 核心约束

### 直接执行模式

1. **先交互后执行** —— 收到话题后先询问用户需求，不直接开始
2. **绝对不自动点击「发布」按钮** —— 所有路径停在发布按钮前
3. **文案必须用户确认** —— 自动生成的标题/正文展示给用户确认后才发布
4. **所有浏览器操作通过 browser-use MCP** —— 不使用系统浏览器
5. **每步真实 tool call** —— 禁止文本中假装已完成操作

### 编排模式

1. **跳过交互确认** —— 直接执行搜索 + 头图 + 文案全路径
2. **绝对不自动发布** —— 编排模式只生成素材（头图 + 文案），不执行发布
3. **子 agent prompt 自包含** —— 所有路径、格式、工具用法必须写在 prompt 中
4. **统一使用 `/tmp/xhs-workspace/`** —— 所有子 agent 输出到此绝对路径
5. **每步检查产出** —— 子 agent 返回后用 `read_file` 验证文件是否存在
