# Agent Note: `SkillsV2` 的 `ImportFromFolder` 拆成 `skills/` feature-folder（#159 UI-APP-N01）

Status: implemented

## Problem

`TD-UI-APP-N01` 记的是「`SkillsV2.tsx` 全仓最大组件且内嵌 854 行 `ImportFromFolder`」，建议「按 `skills/import/` feature-folder 拆出（picked/typed/batch 三模式）」。现状核对：`SkillsV2.tsx` 动手前 **2525 行**，`ImportFromFolder` 一个函数 **852 行**，同时承担 picked（浏览器给的 `File` 对象 → multipart）/ typed（绝对路径 → JSON `/import`，支持 copy/symlink）/ batch（扫描父目录下多个技能）三套模型，外加校验面板与 slug 自动填充。

另有一处**覆盖面事实**必须先说清楚：整条导入链路此前**零测试**——切片 A 的负控制里，把 `/api/skills/validate` 改成错误端点后**全量 850 条用例仍然全绿**。所以这次不只是搬家，还要把"搬完行为不变"钉在测试上。

## Decision

一个 PR、三次提交，每一片都以**上一个提交**为基线做逐 token 证明（不用 HEAD：分批提交后 HEAD 前移，被搬的代码会从 HEAD 消失，基线漂移过一次就再也对不上）。

### 切片 A（`97aa0566`）：整块搬出 `SkillsV2.tsx`

`ImportFromFolder` + `ValidationPanel`（853 行）搬进 `skills/import/ImportFromFolder.tsx`；面板与子组件共用的六件（`Skill` 等类型、`api<T>()`、`formatBytes`、`Field`、`ScopeSelector`）落到 `skills/shared/`。`SkillsV2.tsx` **2525 → 1440 行**。证明 19 项（基线 `e2bf9d1f`）。

### 切片 B-1（`7bfa06b0`）：两个纯函数外置

`parseFrontmatterFields` / `stripRootPrefix` → `skills/import/frontmatter.ts`（23 行），`ImportFromFolder.tsx` 1002 → 987 行。**这片的重点不是搬，而是可测**：两个函数此前没有任何直接测试，外置后补 `frontmatter.spec.ts` 9 例（引号、CRLF、缺字段、值里带冒号、根前缀边界）。

### 切片 B-2（`184c4e2c`）：批量模式卡片 → `BatchImportPanel.tsx`（237 行）

183 行的批量卡片 JSX（候选目录行 + 进度/结果图标 + scope/覆盖开关）搬进独立组件，`ImportFromFolder.tsx` 987 → 824 行，god function **852 → 688**。闭包变量换成 15 个 props；两处刻意的字节差都记在证明里：`batchCandidates!` 的断言删除（prop 类型已是非空 `BatchCandidate[]`），`skillCandidates`/`selectedCount` 改为组件内本地推导（父级的 `?.` 与 `?? []` 在 `batchMode === true` 的调用点上是死分支）。

同提交补 `ImportFromFolder.spec.tsx` 4 例，覆盖扫描 → 勾选 → 提交 → 清空的批量链路，断言全部落在 **props 边界**上（父目录名、候选计数、勾选回调、`scope`/`force` 是否真的进了请求体、失败项的后端错误文案）。

## Alternatives considered

- **把卡片再拆成三个组件（候选列表 / 结果列表 / 控件）** —— 落选。卡片是一个整体 `<div>`（边框与圆角属于它），拆成兄弟节点会改变 DOM 结构；而"逐 token 可证"依赖 JSX 原样搬家。三个兄弟 `<div>` 的等价性证明会立刻退化成"看起来一样"。
- **让面板自持 `scope` / `force` 状态** —— 落选。这两个是**导入选项**，单模式与批模式共用，`submitBatch` 读的是父级的值；面板自持会形成两份真源。所以面板只做受控组件（值 + 回调成对传入）。
- **15 个 props 收敛成一个 `options` 对象** —— 落选。平铺 props 看起来长，但证明脚本能逐一断言"哪个 prop 接的是哪个闭包变量"；对象化会把接线变成解构，边界反而模糊。
- **传 `selectedCount` 而不是 `selectedFolders`** —— 落选。组件要按 `selectedFolders.has(folderName)` 决定每行勾选态，传集合更贴合用途；计数在组件内一行推导，并在证明里按**精确重构**验证与父级定义等价。
- **保留 `batchCandidates!`（props 类型写成 `BatchCandidate[] | null`）** —— 落选。调用点已由 `batchMode`（`batchCandidates !== null`）守卫，`!` 成了多余断言，lint 也会报；改成非空 props 后删掉 2 处。
- **顺手给清空按钮补 `aria-label`** —— 落选（本轮）。会给"逐字搬迁"引入额外 diff、稀释证明；测试改用结构定位（标题行里唯一的 button）。留作后续 a11y 项。
- **把零覆盖的导入测试放独立 PR** —— 落选。搬迁与测试同一 PR 才能证明行为不变；PR 内分三次提交已经足够可读。

## Consequences

- **换来**：`SkillsV2.tsx` 2525 → 1440 行；`ImportFromFolder` god function 852 → 688；批量卡片与两个纯函数各有了名字与文件；**13 条新测试**（9 条纯函数 + 4 条批量链路）打在一条原本零覆盖的路径上。metrics：ui/src 文件 499 → 503、行数 85762 → 86125，`ImportFromFolder` 从 god-function 榜首（852）降到 688。**双重断言计数未增加**（测试初稿用了 `as unknown as`，改成单重 `as` 后回到 29）。
- **证明**：切片 A 19 项 + B-1 4 项（`/tmp/uiappn01b1-move-proof.mjs`）+ B-2 6 项（`/tmp/uiappn01b2-move-proof.mjs`）。B-1 的强证据是**整文件差集**：基线剔除两个函数定义、新侧剔除那行 import 后，6202 个叶子 token 完全相同；B-2 同样做了整文件差集（5167 tokens）外加 15 个 prop 的逐一接线断言。
- **负控制 6 处**：B-1 改函数体内正则 / 改父文件文案；B-2 改组件里一个 class / 把父级 `onClear` 接到别的 handler；行为测试把面板 `total` 换成 `skillCandidates.length` / 把父级 `force` 写死 `false`——每处都让**对应用例**变红、其余保持绿（可定位性）。
- **行为测试的第一次负控制没抓到**（值得记）：把父级 `force={force}` 写成 `force={false}`，4 条用例仍全绿——因为面板的 `force` prop 只负责**回显勾选态**，提交请求里的 `force` 取自父级 state。补上"点击前后勾选态"的断言后才变红。结论：**"值到达请求体"不等于"prop 接线正确"，两者必须各自断言**。
- **一次作业事故（已固化为脚本）**：B-1 的改动当时还在工作区未提交，我用 `git checkout -- <file>` 回滚 B-2 的试验时把它一起冲掉了；随后按 `frontmatter.ts` 的正文做精确子串定位、连删两处定义 + 补 import，把这一步写成 `/tmp/n04b-frontmatter-redo.py` 重放回来（`export` 前缀是唯一字面差）。教训与"禁止行号手术"同源：**未提交的改动不要用 git 回滚，改动本身要能脚本重放**。
- **双视口浏览器验证（A/B）**：真实 `pnpm dev`（Vite 5173 / server 3001）+ 真实数据（仓库自带 `skills/` 下 95 个含 `SKILL.md` 的子目录）下，同一段脚本分别在 **main 与合并分支**上打开 Skills 面板 → New Skill → Import folder → 扫该目录，取批量卡片 DOM 指纹（卡片 class、header 整段 HTML、候选行数 95、勾选框 97、列表 `scrollHeight` 6839 / `clientHeight` 240、卡片矩形）。**桌面 1280×800 与移动 390×844（dpr 2）两个视口、四份指纹两两逐字节相同**（5249 / 5247 字节）。全程只做只读动作（扫描），不点任何导入按钮。截图仍不可用（`Page.captureScreenshot` CDP 超时，与前几轮一致），故证据以 DOM 指纹为准。
- **仍未处理**：`ImportFromFolder.tsx` 本体还有 824 行（picked/typed 两模式 + 校验面板 + 提交逻辑），god function 688 行；台账里另有同族的 `TD-UI-CHAT-N08`（`CodeEditorBinaryFile` 1523 行）与 `TD-UI-APP-N02`（`useSessionStore` ~1440 行），已在 #159 登记。
