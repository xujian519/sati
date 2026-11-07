# Agent Note: 会话标识命名规范（sessionKey / sessionId）与贫血模型边界（#812）

Status: implemented

## Problem

同一「会话唯一标识」在仓库里有两套名字：`sessionKey`（924 处）与 `sessionId`（793 处）。跨层传参时靠约定记忆，`session.sessionKey ?? session.sessionId` 这类兼容读取在 TUI/侧边栏已经出现——说明边界没有被写下来，后来者无法判断该用哪个名字。

另一部分是 248 个 `export interface` 全部零方法（贫血模型）。这不是一次重命名能解决的：把领域方法硬塞进 DTO 会破坏序列化与跨进程契约。

## Decision

**命名以层为界，不以“哪个更常用”为界。**

| 层 | 规范名 | 说明 |
| --- | --- | --- |
| gateway 协议 / WS frame / 远程客户端 | `sessionKey` | wire 字段，**不改名**（改名是协议破坏性变更） |
| agent 协议（`AgentEvent`、`AgentLoopInput`、`ToolContext`） | `sessionId` | run 内标识 |
| session / transcript / 磁盘文件名 | `sessionId` | 与转录文件命名一致 |
| web server / web UI API | `sessionKey` | 对外 API 沿用 gateway 口径 |
| adapters（IM/TUI 宿主） | 按宿主 DTO 原名 | 映射层负责显式改名为 `sessionKey` 或 `sessionId` |

规则：

1. **同一函数内不得同时出现两个名字指代同一值。** 跨层时在边界函数第一行显式赋值改名（`const sessionId = input.sessionKey;`），并注明层。
2. **兼容读取（`a ?? b`）只允许出现在 adapter/DTO 归一化处**，且必须收敛到一个本地变量后再向下传，不得继续把两个名传进核心层。
3. 新代码：gateway/协议层写 `sessionKey`，agent/session 层写 `sessionId`。禁止新增第三种叫法（如 `conversationId`）。
4. 全局批量重命名**不做**：wire 字段改名会破坏旧客户端与 llm-replay fixture；按本表在改动到的模块内 scoped 收敛。

**贫血模型边界**：`src/*/protocol/**`、`src/gateway/protocol/**`、`src/**/types.ts` 里的纯数据 interface 保持零方法（它们是跨进程 DTO）。不变量属于 `session/`、`agent/`、`patent/` 等运行时层：新增状态转换时，把校验/转换函数放在同模块的领域函数里，而不是散落在 handler。

## Alternatives considered

- **全局把 `sessionKey` 重命名为 `sessionId`（或反向）。** 落选。gateway wire 字段与 UI 客户端、llm-replay fixture、外部 IM 适配器耦合；一次性改名需要协议升版 + 全量重录，收益只是搜索时少一个词。
- **给 248 个 interface 加方法，做成富领域模型。** 落选。DTO 需要 JSON 往返与跨进程序列化，方法不可传输；强行加方法会让序列化层与领域层纠缠。贫血模型在这里是刻意选择。
- **引入 `SessionIdentity` 值对象统一两个名字。** 落选。会新增一层包装，且现有协议字段仍要映射；在边界注释 + 本表约束下，显式改名足够。
- **加 ESLint 规则禁止同一文件混用。** 暂缓。现存量太大，规则会立刻全红；先把规范写下来，等 scoped 迁移到一定比例再上规则。

## Consequences

- 新代码有明确归属；review 时可引用本表判断命名。
- 已在 `GatewaySubmitTurnInput.sessionKey` 上落下边界注释（协议字段单点说明）。
- 存量混用不一次性清理；TUI 的 `sessionKey ?? sessionId` 兼容读取保留，但被限定在 adapter 层。
- 全局重命名与富领域模型改造不再作为还债项——本 note 即关闭口径。
