# Agent Note: Git 面板的变更分桶口径——重命名计入 modified，且不许有条目掉队

Status: implemented

## Problem

`GET /api/git/status`（`ui/server/routes/git.js`）只按 `M`/`A`/`D`/`??` 四种状态分桶，
`git status --porcelain` 里的 **rename（`R `）与 copy（`C `）条目落不进任何分支**，
被整条丢弃（issue #415）。丢掉的不是一个分类，而是「这个文件变了」这个事实本身：

- 前端 `FILE_STATUS_GROUPS` 就是这四个键，`getAllChangedFiles()` 用它展平「变更列表」，
  `getChangedFileCount()` 用它算角标 ⇒ `git mv` / 重构改名后，面板既不显示该文件，
  计数也与 `git status` 对不上；
- 用户依据面板判断「有没有要提交的改动」，漏项直接导致误判；
- 更糟的是**同文件已经有正确实现**：`parseStatusFilePaths()` 解析 `--porcelain` 时会取
  `" -> "` 的后半段。这不是「不会写」，而是两处口径分叉——后来者会照抄错的那份。

## Decision

抽出唯一的 `--porcelain` 解析入口 `parseStatusBuckets()`（导出、可直测），
`GET /status` 与 `parseStatusFilePaths()` 都走它，并确立两条口径：

1. **重命名/复制计入 `modified`，取「新路径」。** 面板列的是**现在存在**的文件；
   `old -> new` 里 `old` 已不存在，把两条路径都塞进列表会让变更计数虚高，
   而新增 `renamed` 桶要动响应结构 + `FILE_STATUS_GROUPS`/`FILE_STATUS_LABELS`/i18n +
   视觉验证，为一次改名付出的契约面远大于收益。取新路径这条规则 `parseStatusFilePaths()`
   早已在用。
2. **不变式：每个非忽略条目恰好落进一个桶。** 映射为
   `??` → untracked；任一侧 `D` → deleted；任一侧 `A` → added；
   `R`/`C` → modified；**其余（`M*`、`T`、`UU` 等）→ modified（兜底，永不丢弃）**。
   兜底而非继续 `else` 掉队，是因为这类缺陷的判据只能是「条目总数守恒」——
   每漏一个状态码就是一次静默丢失。

判据同时用**真实 `git mv`** 产出的 porcelain 行与字面样本两层：
前者防止手写样本与真实格式漂移，后者覆盖 `R`/`C`/`T`/`UU`/`MM`/`??`/未跟踪目录。

## Alternatives considered

- **新增 `renamed` 桶（响应体加键）** —— 落选：契约面扩大（响应结构 + 前端分组常量 +
  i18n + 双主题/双语言视觉验证）而信息量几乎不变——面板需要的仍是「这个文件变了」。
  真要分类展示，应作为一次独立的 UI 提案，而不是修存储桶时的顺手选择。
- **同时输出旧路径（deleted）与新路径（modified）** —— 落选：一次改名会被计成两处变更，
  变更计数与 `git status` 的条目数对不上——正是本 issue 要修的那种「对不上」。
- **只补 `R` 分支，其余状态码维持原样** —— 落选：`T`（类型变化）与 `UU`（冲突未解决）
  同样会静默掉队。冲突文件恰恰是用户最需要在面板上看到的那一类。
- **顺手把 `parseStatusFilePaths()` 保留为第二份实现** —— 落选：本 issue 的成因就是
  「两处口径分叉」。它改为调用 `parseStatusBuckets()` 后，`--porcelain` 只有一种解读。
- **为 `status` 路由单开一个纯函数文件** —— 落选：解析器与其唯一消费者同文件更易读到
  上下文；导出面只加一个函数，不引入新模块。

## Consequences

- **行为变化（仅响应内容，结构不变）**：`modified`/`deleted`/`added`/`untracked` 四个数组
  现在覆盖全部条目——`git mv` 后的文件出现在 `modified`（新路径），类型变化与冲突文件也
  出现在 `modified`。
- **判据 5 例**（`ui/server/routes/git.test.js`）：真实 `git mv` 的 porcelain 断言、
  改名 + 未跟踪文件并存、13 种状态码逐桶断言 + **条目总数守恒**、
  空/CRLF 输入、`GET /api/git/status` 端到端（真实临时仓库）。
  **负控制 2 条逐条命中**：N1 关掉 rename/copy 识别 → 4 例转红；
  N2 去掉兜底桶（回到静默丢弃）→ 4 例转红；还原后复绿。
- **测试用真实 git 仓库而非 mock**：`git mv` 的 porcelain 形状是外部事实，
  mock 掉 git 等于把「真实格式」这一被断言对象换成自己的假设。
- **未覆盖**：面板仍只有四个分组（无冲突/类型变化的独立展示），
  本次只保证「不漏」，不改变分类粒度。
