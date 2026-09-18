# Agent Note: `useChatComposerState` 拆成六层 hook（#159 N01）

Status: implemented

## Problem

`TD-UI-CHAT-N01` 记的是「`useChatComposerState` 为巨型 God hook（函数体 ~1430 行）」，建议拆 `useComposerInput` / `useAttachmentUpload` / `useSlashCommandExecute` / `useSessionSubmit`。

实测口径照旧需要更正：**1430 是 hook 本体的函数跨度**，文件本身 **1837 行**；内部 11 个 `useState`、14 个 `useRef`、15 个 effect、29 个 `useCallback`、0 个 `useMemo`；消费者只有 `ChatInterfaceV2.tsx:260` 一处（外加 3 个测试文件直接 `renderHook` 它）。

拆之前先做了**接缝盘点**（写进 #159 评论），把依赖方向摸清——这一步决定了后面的顺序，因为四条缝里只有两条是**无环**的。

## Decision

按「有环先绕、绕不开就把状态留在父级」推进，拆成六层（六个提交，各带逐 token 证明与负控制）：

| 新 hook | 行数 | 内容 |
|---|---|---|
| `useSlashCommandExecute` | 410 | 三个命令回调 + `skipSlashDetectionOnceRef` + `CommandExecutionResult` 契约（另抽出 `composerSubmit.ts` 共享伪提交事件） |
| `useAttachmentUpload` | 172 | 四个附件 state + 加入/粘贴/复位 + 附件常量与纯函数 |
| `useComposerInput` | 247 | textarea 交互：受控读写、光标插入、键位路由、滚动同步、展开/聚焦 |
| `useSessionPermissions` | 303 | 中止会话、单次/本会话授权、权限决策、输出门禁审批 + 两个 effect |
| `useSessionSubmit` | 705 | `handleSubmit` 本体、ref 回填、空闲 flush、插话、编辑/重发 |
| `useComposerDraft` | 131 | 草稿防抖落盘、切会话换档/恢复、三条同步落盘兜底 |

**父 hook 1837 → 558 行（−70%）**，其 god function **1608 → 467（−71%）**。

### 三条贯穿全过程的判断

**1. 有环的缝先绕开；绕不开就"状态留父级、逻辑进 hook"。**
缝 1 的环：`handleImageFiles` 要通知父级的"忙碌队列快照"，而 `syncQueuedBusySendSnapshot` **反过来要读附件状态**——用 **ref 后绑定**解开（父级定义完真正的同步器后用 effect 填 ref；事件处理器都在渲染提交后执行，读到的就是当前值）。
缝 3/4b 的环同理：`input`/`setInput`/`inputValueRef` 是斜杠命令层与文件提及层的**入参**（必须先在），而 `handleKeyDown` 又要用它们的返回值；排队状态（`queuedBusySend*`）被更早的权限层与更晚的输入层共用，而提交层必须等在斜杠层之后。这类情况一律按"状态在父级、逻辑在 hook"处理，宁可多几个入参也不造第二、第三个后绑定。

**2. effect 的相对顺序是有语义的，能不搬就不搬。**
缝 3 的两条 autosize effect 留在父级（搬动无法用 token 比对证明等价）；缝 4b 中"先回填 `handleSubmitRef`、后 flush"这一对整对一起进 hook，**内部顺序保持不变**——那正是"空闲补发能拿到最新 handleSubmit"的前提；缝 4a 更幸运，它的两个 effect 依赖都在原位置之前就绪，于是**调用点就选在 effect 原处**，顺序零变化；缝 4c 独立成一层也正是为了这一条。

**3. 代价写清楚。** 为让被搬代码逐字不变，新增了一处后绑定与若干"入参身份稳定、列入只为满足 exhaustive-deps"的依赖项。缝 4b 唯一变化的相邻顺序是"ref 回填 + flush"现在排在父级 `inputValueRef` 同步 effect 之前——而 flush 路径读的是排队快照里的 `input`，不读那个 ref。

## Alternatives considered

- **一次性大爆炸（一个 PR 把所有层搬完）** —— 落选。1600 行的 hook 里四层彼此纠缠，一次搬完的 diff 无法审阅、回归无法定位；分六次提交后每一步都有独立证明与负控制，任一提交出问题都能单独回退。
- **每层各开一个 PR** —— 落选。六层共享同一组约束（effect 顺序、状态归属）与同一套验证工具，拆成六个 PR 只会让 CI 与 rebase 成本翻六倍；改为一个 PR、六个提交（本仓库 PR 本来也是 squash 合入）。
- **把 `useComposerDraft` 塞进 `useComposerInput`（保持"四层"的原计划）** —— 落选。草稿的四个 effect 必须留在原位置（塞进输入层会整体后移到 autosize 之后），而它还同时写附件层的四个 state（切会话清空引用/附件/上传态/错误），塞进输入层会平白多一条跨层依赖。**多一层比多两条说不清的顺序与依赖更划算。**
- **把输入 state 搬进 `useComposerInput`** —— 落选，理由同上：它是斜杠层与文件提及层的入参，搬进去就得再造后绑定。
- **顺手把 `handleSubmit` 里那段 `referenceOnlyPrompt` 的默认值也搬进新 hook** —— 落选。父级已有默认值（`useChatComposerState` 的入参解构），新 hook 里再写一份会变成两处真相；改为在类型上显式声明为必填。

## Consequences

- **换来**：父 hook 从 1837 行降到 558 行、god function 从 1608 降到 467，六层各自有明确边界与名字；三处此前**完全没有测试**的层（斜杠命令、附件、权限/审批）现在有 41 条用例。
- **证明**：六个证明脚本（`/tmp/n01a`…`n01f-move-proof.mjs`）共 **59 项逐 token 比对**，基线统一取 N01 起点 `f3ab6678`——**不是 HEAD**：分批提交后 HEAD 会前移、被搬代码从 HEAD 消失，守卫会"基线漂移"（这一点在缝 2 提交后立刻暴露过）。唯一的三处改写（接口 `+export`、两个常量的语句级 `export`、两行写操作→一次 `forceRenderPage` 调用）都做了**精确重建**校验。
- **负控制 10 处**，每处都触发**预期的那几条**用例。其中两次特别值得记：「只改一句命令文案」与「只改一处 className」都让守卫变红而**全部用例仍绿**——守卫与测试覆盖的是两类不同失效。
- **浏览器验证**（在真实本地栈上，桌面 1440×900 + 移动 390×844，另做 `main`↔分支 **A/B 行为等价**）见 PR #457 的评论。其中"`/cost` 输入被清空但没有命令请求"一度像是回归，A/B 复核证明 `main` 上完全一致，根因是既有的 `executeCommand` 早退（该视图 `selectedProject` 为空）。**截图在本环境不可得**（CDP `Page.captureScreenshot` 超时），视觉证据以布局断言替代。真实发送消息**有意未验证**（会在本机真实项目上跑 agent），该路径由测试与负控制承担。
- **过程代价（值得记）**：行区间手术踩了三次同类坑——缝 1、缝 3 各一次 off-by-one（切片右界含/不含），缝 4b 一次"按行号切片段（中途 `biome format` 让行号漂移）＋ 用字符串去重误删依赖数组里 3 处合法条目"。三次都被 `tsc`/`eslint` 立刻抓出、父文件回退到 HEAD 重做。**从缝 4b 起改用 AST 定位区间 + TS parser 校验零解析错误**，并把组装/打补丁固化成可重复执行的脚本。
- **仍未处理**（#159 的 L 级窗口剩余）：N03（`MessagesPaneV2` 手写虚拟化）与 UI-APP-N01（`SkillsV2` 的 `ImportFromFolder`）。
