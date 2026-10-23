# Agent Note: 提交与斜杠命令三 hook 拆分（sweep B2.4）

Status: implemented

## Problem

sweep 基线（`a3c35684b`）的 chat 主链路上还有三个 ≥300 行的 hook 单函数：

- `useSessionSubmit` **528 行**：插话、编辑最后一条、重新生成、`handleSubmit` 四类职责同住一个闭包；其中 `handleSubmit` 的 337 行把排队、斜杠拦截、附件上传、乐观气泡与 `startSessionCommand` 串成一条长事务；
- `useSlashCommands` **395 行**：加载/排序/分组/查询/键盘导航/插入命令全部内联；
- `useSlashCommandExecute` **331 行**：往返请求之外，`handleBuiltInCommand` 的 180 行 action 分派（help/model/cost/status/memory/config/rewind/skillInstall/switchProject）也占用同一闭包。

`useSessionSubmit` 此前**零测试**；计划要求先补测再拆，并保持三 hook 各 ≤300 行。

## Decision

**逻辑外移为模块级普通函数，React 状态与 hook 顺序留在原处。** 不新增子 hook，避免改变 hook 调用顺序、ref 身份与返回对象键序。

| 文件 | 行数 | 内容 |
|---|---|---|
| `chat/hooks/sessionSubmitHandler.ts` | 534 | `submitSession`（222 行，排队/编辑/拦截编排）+ `dispatchSessionMessage`（218 行，上传/气泡/派发落地） |
| `chat/hooks/sessionSubmitUtils.ts` | 59 | `readToolsSettings` / `buildAttachmentPathNote` / `contentReferenceToAttachment` 与 `UploadedAttachmentFile` |
| `chat/hooks/slashCommandSources.ts` | 83 | 命令历史读写 + `loadSlashCommands`（请求/映射/置顶与使用次数排序） |
| `chat/hooks/slashCommandInteractions.ts` | 139 | `insertCommandIntoInput` 与 `handleCommandMenuKeyDown` |
| `chat/hooks/slashCommandBuiltins.ts` | 208 | `runBuiltInCommand`（189 行 action 分派） |

结果：`useSessionSubmit` 528 → **290**、`useSlashCommands` 395 → **273**、`useSlashCommandExecute` 331 → **147**；新函数最大 222 行，全部 <300，God function 表不再新增条目。

三条保持行为不变的取舍：

1. **父 hook 继续持有状态，函数只接收值/ref。** `sessionSubmitHandler` 的 context 是 46 个字段的显式对象，`slashCommand*` 的 deps 同样显式；没有子 hook 的 ref 重建风险，也保证 `useCallback` 的依赖集与拆分前逐项一致。
2. **`handleSubmit` 在“拦截之后、派发之前”切成两段。** `submitSession` 负责决定这一次提交走排队、编辑、斜杠还是普通消息；`dispatchSessionMessage` 只负责普通消息的附件上传与派发。切点选在 `const userVisibleInput`，两段各自可读，且上传失败仍由派发段早退并写错误气泡。
3. **斜杠命令加载保留原错误语义。** `loadSlashCommands` 只抛错，`useSlashCommands` 的 effect 负责 `logError` 与清空列表——日志仍只出现一次；无项目时清空 `slashCommands` 与 `filteredCommands` 的分支留在 hook 内。

## Alternatives considered

- **拆成 `useSessionQueue` / `useSlashCommandLoader` 等子 hook** —— 落选。子 hook 会改变调用顺序与 ref 生命周期；`queuedBusySend*` 被权限层、输入层与提交层共用，拆开后还得把 ref 再传回来，只增加边界。
- **用 `useMemo` 包一个 deps 对象再调用工厂** —— 落选。`useCallback` + 调用时构造 context 已能达到同样的引用稳定性，且依赖数组可与原实现逐项对齐，减少身份语义变化。
- **接受 `submitSession` 的 335 行，只保证“hook 本身 ≤300”** —— 落选。指标按函数统计，把 335 行函数搬进新文件只是换名字，God function 数量不会下降；B2.4 的判据应落在“没有新的 ≥300 行函数”。
- **把内置命令分派改成 action → renderer 注册表** —— 落选。九个 action 的负载形状互不相同（`any` 的 SAFETY 说明仍适用），注册表需要先建判别联合；本轮是搬移，不借机改契约。

## Verification

- **判据**：三 hook 528 → **290** / 395 → **273** / 331 → **147**；`metrics.md` 的 God function 三条目消失且未新增（`measure:update`）。
- **AST 逐 token 证明（12 项）**：以 `HEAD`（`d28c74d2e`）为基线，用 TypeScript AST 取节点文本后比较 leaf token。`handleSubmit` 前缀 → `submitSession` 685/685、尾段 → `dispatchSessionMessage` 735/735、`insertCommandIntoInput` 164/164、`handleCommandMenuKeyDown` 228/228、`handleBuiltInCommand` → `runBuiltInCommand` 1063/1063、两个历史函数 56/56 与 19/19、三个会话辅助函数 44/44、62/62、59/59、`loadSlashCommands` 请求+排序 354/354。预期改写仅三类：`loadSlashCommands` 形参 `selectedProject → project`（3 处）、末句 `setSlashCommands(sortedCommands)` → `return sortedCommands`、biome 把两处多行三元折成单行并增删 2 对括号 + 1 个尾逗号（归一化后 228/228）。
- **新增直测（33 例）**：`useSessionSubmit.test.ts` 13 例（空输入、正常提交、附件上传成功/失败、忙碌排队、二次提交 abort、斜杠拦截与 passthrough、编辑/重生成、插话与附件禁用、空闲补发）；`useSlashCommands.test.ts` 10 例（加载排序、分组、查询防抖、键鼠选择与光标、尾随文本、Escape 收起、无项目/请求失败、hover 无副作用）；`useSlashCommandExecute.test.ts` 10 例（请求体、model/cost 文案、config/rewind、memory 存在性、skillInstall 成功/可疑、switchProject、自定义命令延迟提交、bash 取消、错误兜底、空入参）。
- **负控制（4 组，均恢复后复跑）**：
  1. `submitSession` 的忙碌分支取反（`!isBusySendQueued → isBusySendQueued`）→ **3 红 / 10 绿**。
  2. `skipSlashDetectionOnceRef` 不再复位 → **1 红 / 12 绿**。
  3. `groupCommandsForDisplay` 的 `frequent` 排到 `builtin` 之后 → **1 红 / 9 绿**。
  4. `rewind` 的 `steps * 2` 改为 `steps` → **1 红 / 9 绿**。
- **类型 A（状态层重构，无渲染路径变更）**：按 checklist 不跑浏览器 A/B；jsdom 直测 + token 证明 + 负控制为验收面。
- **门禁**：`pnpm check`、`pnpm test`（5977 / 5972 pass / 0 fail / 5 skip）、`pnpm test:pr-tooling`（197/197）、`pnpm --filter sati-ui test`（203 文件 / 1575 例）全绿；首次全量 UI 跑出现 1 例未捕获名称的失败，随后连续 3 次全量与 5 次三文件定向跑均 33/33 绿（判定为既有偶发，未改行为）。
- **生成物**：`measure:update` 反映 ui/src 697 → **705** 文件、105574 → **106907** 行（5 个新源文件 + 3 个新测试文件；测试文件经 `git add -f` 入库后计入基线，以 `metrics.md` 为唯一事实源）；`as unknown as` 维持 **29**（新增测试未引入双重断言）；`check:architecture-boundaries` fresh（无 ≥800 行新文件，豁免维持 35 条）。

## Consequences

- **换来**：三个 hook 各自回到“装配 + 少量回调”的规模；提交事务的编排与派发有了明确切点，附件上传/错误气泡可单独定位；斜杠命令的历史、加载、交互、内置渲染各有落点。
- **代价**：`sessionSubmitHandler` 的 context 有 46 个字段，新增提交参数需要在 hook、context 类型与调用点三处同步；`dispatchSessionMessage` 的参数表同样显式。后续若继续增长，优先把“附件上传 + 错误气泡”再收成独立模块，而不是继续加字段。
