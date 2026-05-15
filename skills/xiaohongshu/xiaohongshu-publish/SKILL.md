---
name: xiaohongshu-publish
description: "小红书最简图文发布技能。读取用户指定路径的图片上传到小红书，填入标题和正文，停在发布按钮前等待用户确认。所有浏览器操作通过 browser-use MCP 完成。"
---

# 小红书最简图文发布

读取本地图片 → 上传到小红书 → 填入配文 → 停在发布按钮前。**绝不自动点击发布。**

## 输入

| 参数 | 必填 | 说明 |
|------|------|------|
| 图片路径 | 是 | 本地图片文件或目录路径，支持多张（首张为封面） |
| 标题 | 是 | ≤20 字 |
| 正文 | 是 | 含话题标签（如 `#话题`） |

### 编排模式下的图片路径

当你作为编排子 agent 被委派执行发布任务时，图片路径由委派 prompt 给出。
**信任 prompt 中的路径，直接使用，不要用 bash 搜索或验证文件是否存在。**

常见路径：
- `/tmp/xhs-workspace/header/output.png` — 编排模式下的头图输出
- `/tmp/xhs-workspace/header/output-1.png` 等 — 多图集

## 核心规则

- **所有浏览器操作通过 browser-use MCP（Playwright）完成。**
- **绝对不点击「发布」按钮。**
- 每步最多重试 1 次，仍失败则 `browser_take_screenshot` 截图汇报用户。
- **如果 prompt 已给出图片路径，不要用 bash 验证，直接上传。**

## 执行约束（极其重要）

**你必须通过调用 tool 来完成每一步操作。禁止在文本中"假装"已经完成了操作。**

- 每一步都必须产生真实的 tool call（browser-use MCP 等）。
- 在收到 tool 返回结果之前，不要声称该步骤已完成。
- 如果你发现自己在文字中描述"已上传"、"已填写"等，但没有先调用对应的 tool，那你做错了。
- **每次只执行一步操作**，等待结果后再执行下一步。不要在单次回复中规划所有步骤。

## Browser-use MCP 工具速查

本 skill 使用 Playwright MCP server（`browser-use`）提供的浏览器工具。
PilotDeck 中实际的工具名称带 `mcp__browser-use__` 前缀，请从可用工具列表中确认具体名称。常用工具：

- `mcp__browser-use__browser_navigate` — 打开页面（参数 `url`）
- `mcp__browser-use__browser_take_screenshot` — 页面截图
- `mcp__browser-use__browser_snapshot` — 获取页面无障碍快照（轻量替代截图）
- `mcp__browser-use__browser_click` — 点击元素（参数 `element`, `ref`）
- `mcp__browser-use__browser_type` — 输入文本（参数 `element`, `ref`, `text`）
- `mcp__browser-use__browser_evaluate` — 执行 JS（参数 `expression`）
- `mcp__browser-use__browser_file_upload` — 上传文件（参数 `paths`）。**必须先 click 触发文件选择对话框！**
- `mcp__browser-use__browser_wait_for` — 等待指定秒数（参数 `time`）

注意：下方步骤中使用简写（如 `browser_navigate`），实际调用时请使用可用工具列表中的完整名称（如 `mcp__browser-use__browser_navigate`）。

## 流程

### Step 1: 打开发布页并切换到"上传图文"

直接打开发布页（会自动跳转到登录页如果未登录）：

```
browser_navigate → url: "https://creator.xiaohongshu.com/publish/publish"
```

然后 `browser_snapshot` 确认页面状态。

如果页面 URL 中包含 "login" 或快照中看到二维码/登录表单 → 未登录，终止。

**切换到"上传图文"标签**：页面默认在"上传视频"标签。`browser_click` 直接点击标签 ref 会超时（已知问题），**必须用 `browser_evaluate` 点击**：

```
browser_evaluate → expression: "document.querySelectorAll('span.title').forEach(el => { if (el.textContent.trim() === '上传图文') el.click(); }); 'switched'"
```

然后 `browser_snapshot` 确认已切换到"上传图文"界面（应看到"拖拽或点击上传"区域）。

### Step 2: 上传图片

Playwright MCP 的文件上传**必须按以下顺序**，否则会报 "no modal state" 错误：

**2a.** 用 `browser_snapshot` 找到上传区域的 ref。通常是包含 "拖拽或点击上传" 或 "Choose File" 的区域。

**2b.** 用 `browser_click` 点击该上传区域。这会触发浏览器的**文件选择对话框**（file chooser）。
Playwright 会自动拦截此对话框并设置 modal state。响应中会出现类似 `"[File chooser]: can be handled by browser_file_upload"` 的提示。

**2c.** 此时调用 `browser_file_upload`，传入图片路径：

```
browser_file_upload → paths: ["<图片绝对路径>"]
```

**2d.** 用 `browser_wait_for` 等待 3 秒让上传完成，然后 `browser_snapshot` 确认缩略图出现。

**常见错误**：
- `"The tool browser_file_upload can only be used when there is related modal state present"` → 你没有先 click 触发文件选择器。回到 2b。
- `"ref does not match"` → ref 已过期，重新 `browser_snapshot` 获取新 ref。

### Step 3: 填写标题和正文

E2E 测试已验证 `browser_click` + `browser_type` 可直接生效，无需 JS 注入。

**3a.** 用 `browser_snapshot` 找到标题输入框和正文区域的 ref。
- 标题框通常是 placeholder 为 "填写标题会有更多赞哦" 的 textbox
- 正文区域通常是第二个 textbox

**3b.** 填写标题：
```
browser_click → target: "<标题ref>", element: "标题输入框"
browser_type  → target: "<标题ref>", text: "<标题内容>"
```

**3c.** 填写正文：
```
browser_click → target: "<正文ref>", element: "正文输入区域"
browser_type  → target: "<正文ref>", text: "<正文内容>"
```

**备用方案**（如果 `browser_type` 不生效）：
用 `browser_evaluate` + `document.execCommand('insertText', false, '...')` 替代。

### Step 4: 校验并停手

1. 做最终 `browser_take_screenshot` 截图。

2. 确认：
   - 图片缩略图可见
   - 标题已填
   - 正文已填
   - "发布"按钮可见

3. 告知用户：
   ```
   图文准备完成，已停在发布按钮前
   - 封面: [已上传 N 张图片]
   - 标题: [标题内容]
   - 正文: [前30字...]

   未点击发布。请在浏览器中确认内容无误后手动点击「发布」按钮。
   ```

## 故障处理

| 故障 | 处理 |
|------|------|
| upload 报 "no modal state" | 需要先 `browser_click` 上传区域触发文件选择对话框，再调 `browser_file_upload` |
| upload 失败 | 重试 1 次；仍失败 `browser_take_screenshot` 截图汇报 |
| ref 不匹配 | 重新 `browser_snapshot` 获取最新 ref |
| 标题超 20 字 | 提示用户缩短，不截断 |
| 未登录 | 终止，引导用户先用 xiaohongshu-login 登录 |
| `browser_type` 不生效 | 改用 `browser_evaluate` + `execCommand` 或 React native setter |
| 操作超时 | 重做 `browser_snapshot` 确认页面状态，重试 1 次 |

## 运行经验

### 文件上传关键点

- Playwright MCP 的 `browser_file_upload` **不能直接调用**，必须先点击触发 file chooser
- 正确序列：`browser_click`（上传区域）→ `browser_file_upload`（传入路径）
- 不要用 `browser_evaluate` 让 `<input type="file">` 可见再上传——这不会触发 file chooser modal

### 标题正文填写

- E2E 测试验证：`browser_click` + `browser_type` 可以直接填写标题和正文
- 标题输入框是标准 `<input>`，`browser_type` 使用 Playwright 的 `fill()` 方法
- 正文区域也支持 `browser_type`，Playwright 会自动处理 contenteditable

### 模型行为注意

- 不要浪费轮次用 bash 搜索文件——如果 prompt 给了路径就直接用
- 每步之后做 `browser_snapshot` 验证——确认操作确实已完成
