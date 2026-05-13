# Files 页 Markdown 编辑器滚动后布局跳变 Bug 复测记录

## 背景

- 复测时间：2026-05-13 16:39-16:50
- 复测地址：[http://localhost:5173/session/web:s_d1f72e26-7855-4505-91da-d41c8c02d7ae](http://localhost:5173/session/web:s_d1f72e26-7855-4505-91da-d41c8c02d7ae)
- 复测项目：`notes`
- 复测文件：`/Users/mamengru/notes/paper/worldagent_summary.md`
- 当前约束：本记录只复测、定位现象和初步怀疑点，不包含修复方案或代码改动。

## 用户描述的现象

1. 初始打开 Markdown 文件时，编辑器看起来占满右侧/主内容区，关闭按钮不可见。
2. 向下滚动一段后，Markdown 编辑器窗口变小，接近正常 split-pane 状态。
3. 再继续向下滚动后，Markdown 编辑器窗口又发生明显变化；用户没有手动拖拽或点击展开/收起按钮。

## 复测步骤

1. 打开指定会话 URL。
2. 进入 `Files` tab。
3. 在文件树中打开 `paper/worldagent_summary.md`。
4. 记录初始布局。
5. 在右侧 Markdown/CodeMirror 编辑器内部向下滚动一次。
6. 再继续向下滚动一次。
7. 对比三个阶段的编辑器宽度、文件树可见状态和关闭按钮位置。

## 实际复测结果

### 阶段 A：打开文件后的初始状态

- 右侧 Markdown 编辑器横向尺寸异常大，覆盖/挤出右侧可视区域。
- 编辑器 Header 中的 `Close` 按钮存在于 DOM/accessibility tree 中，但位置在视口外，因此用户看不到关闭按钮。
- 浏览器测量结果显示：
  - 文件树 `Close file tree` 按钮：`x=749, y=54, w=28, h=28`
  - 编辑器 `Close` 按钮：`x=1838, y=59, w=28, h=28`
- 结论：关闭按钮不是没渲染，而是被异常宽度推到了屏幕外。

截图证据：

- 用户截图：`/Users/mamengru/.cursor/projects/Users-mamengru-repo/assets/image-b77cf52a-0651-47ec-8be8-9a806787d023.png`
- 复测截图：`/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-stage-a-initial.png`

### 阶段 B：第一次向下滚动后

- 编辑器内容滚动到约 33-65 行。
- 在本次复测环境中，布局仍保持异常宽，编辑器 `Close` 按钮仍在视口外。
- 浏览器测量结果显示：
  - 编辑器 `Close` 按钮：`x=1838, y=59, w=28, h=28`
  - 文件树 `Close file tree` 按钮：`x=749, y=54, w=28, h=28`
- 说明：第一次滚动不一定每次都触发收缩，但编辑器仍处于不稳定布局状态。

截图证据：

- 用户截图：`/Users/mamengru/.cursor/projects/Users-mamengru-repo/assets/image-ff59d19d-b814-4836-a7bc-b8d6ca7f26bf.png`
- 复测截图：`/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-stage-b-after-scroll.png`

### 阶段 C：第二次继续向下滚动后

- 编辑器内容滚动到约 64-96 行。
- 布局发生跳变：文件树重新露出，Markdown 编辑器收缩到右侧 split-pane 区域。
- 编辑器 Header 中的关闭/下载/保存/展开按钮重新出现在可视区域内。
- 浏览器测量结果显示：
  - 编辑器 `Close` 按钮从阶段 A/B 的 `x=1838` 变为 `x=1084`
  - 文件树 `Close file tree` 按钮仍在 `x=749`
- 结论：仅滚动编辑器内容即可触发 editor pane 横向布局重算，复现了用户描述的“没拖拽但窗口自己变大/变小”。

截图证据：

- 用户截图：`/Users/mamengru/.cursor/projects/Users-mamengru-repo/assets/image-bbab1c72-438c-4b54-8638-af6dda966878.png`
- 复测截图：`/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-stage-c-after-second-scroll.png`

## 代码观察

当前 Files 页是一个横向 flex 布局：左侧 Chat、右侧 Files 文件树，以及打开文件后额外挂载的 `EditorSidebar`。

相关结构：

- `ui/src/components/main-content/view/MainContent.tsx`
  - `SplitBody` 在 `Files` tab 下渲染 Chat + 文件树。
  - `MainContent` 在 `SplitBody` 之后再渲染 `EditorSidebar`。
- `ui/src/components/code-editor/view/EditorSidebar.tsx`
  - 当 `fillSpace && !hasManualWidth` 时，内层 editor 使用 `flex-1` 自动填满剩余空间。
  - 外层容器仍带有 `flex-shrink-0`，且没有稳定的 `width` / `flex-basis` / `flex-1` 约束。
  - 非 flex 分支里还有一个疑似拼坏的 Tailwind class：`min-w-[ flex-shrink-0${MIN_EDITOR_WIDTH}px]`。
- `ui/src/components/code-editor/view/subcomponents/CodeEditorHeader.tsx`
  - `Close` 按钮始终渲染；本次问题是布局把按钮推出视口，而不是按钮缺失。

## 初步判断

这是一个布局稳定性 bug，核心表现是：编辑器宽度受内容渲染/虚拟滚动影响，在滚动过程中触发 flex item intrinsic width 重算。

可能触发因素：

- CodeMirror 只渲染当前附近可见行，不同滚动位置出现不同长度的行。
- `EditorSidebar` 自动填充模式下，外层 flex item 没有稳定的宽度约束。
- 打开的 Markdown 文件包含较长行、表格、链接或中英文混排内容，容易放大 intrinsic width 变化。
- Header 按钮组没有问题；按钮不可见是 pane 过宽导致其落在视口外。

## 复现结论

- 已复现。
- 现象不是用户误操作拖拽导致。
- 现象不是关闭按钮未渲染。
- 问题发生在 Files split-pane 与 EditorSidebar 的横向 flex 布局计算上。
- 下一步应先写修复 plan，再改代码。

## 修复后复测结果

复测时间：2026-05-13 16:52-17:05

修复重点：

- `EditorSidebar` 默认 Files 模式不再依赖内容驱动的自动 flex 宽度。
- 默认 Files 模式使用稳定 CSS 宽度约束：`min(editorWidth, 50%, calc(100% - 420px))`。
- 手动宽度模式保留 JS 测量和 `effectiveWidth`。
- 展开模式仍使用 `flex-1 basis-0` 显式占满主区域。
- 移除了无效 Tailwind class：`min-w-[ flex-shrink-0${MIN_EDITOR_WIDTH}px]`。

### 修复后阶段 A：初始打开文件

- Agent 聊天区、文件树、Markdown 编辑器均保持可见。
- 编辑器关闭按钮可见。
- 文件树关闭按钮可见。
- 浏览器测量结果：
  - 文件树 `Close file tree` 按钮：`x=749, y=54, w=28, h=28`
  - 编辑器 `Close` 按钮：`x=1084, y=59, w=28, h=28`

截图证据：

- `/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-fixed2-stage-a-initial.png`

### 修复后阶段 B：小幅滚动

- 编辑器内容滚动到约 14-45 行。
- 布局未跳变。
- 浏览器测量结果：
  - 文件树 `Close file tree` 按钮：`x=749, y=54, w=28, h=28`
  - 编辑器 `Close` 按钮：`x=1084, y=59, w=28, h=28`

截图证据：

- `/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-fixed2-stage-b-small-scroll.png`

### 修复后阶段 C：中幅滚动

- 编辑器内容滚动到约 47-79 行。
- 布局未跳变。
- 浏览器测量结果：
  - 文件树 `Close file tree` 按钮：`x=749, y=54, w=28, h=28`
  - 编辑器 `Close` 按钮：`x=1084, y=59, w=28, h=28`

截图证据：

- `/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-fixed2-stage-c-medium-scroll.png`

### 修复后阶段 D：大幅滚动

- 编辑器内容滚动到约 108-141 行，包含较长文本行。
- 布局未跳变。
- 浏览器测量结果：
  - 文件树 `Close file tree` 按钮：`x=749, y=54, w=28, h=28`
  - 编辑器 `Close` 按钮：`x=1084, y=59, w=28, h=28`

截图证据：

- `/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-fixed2-stage-d-large-scroll.png`

### 修复后阶段 E/F：显式布局变化

- 点击 `Expand to full width` 后，编辑器显式展开，左侧内容按预期隐藏。
- 点击 `Collapse to split view` 后，恢复三栏布局。
- 恢复后三栏仍稳定，关闭按钮保持可见：
  - 文件树 `Close file tree` 按钮：`x=749, y=54, w=28, h=28`
  - 编辑器 `Close` 按钮：`x=1084, y=59, w=28, h=28`

截图证据：

- `/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-fixed2-stage-f-expanded.png`
- `/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/cursor/screenshots/md-layout-fixed2-stage-f-collapsed.png`

备注：本轮浏览器自动化工具无法可靠定位无语义 ref 的拖拽分隔条，因此没有自动执行手动拖拽 resize；代码仍保留手动拖拽后的固定宽度分支，默认滚动路径和显式展开/收起路径已覆盖。