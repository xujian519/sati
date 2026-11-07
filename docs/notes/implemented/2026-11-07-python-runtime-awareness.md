# Agent Note: Python 运行时感知

Status: implemented

## Problem

`execute_code` 只在 PATH 上找 `python3`/`python`，提示词里没有任何 Python 环境信息。模型因此会：

- 假设某个第三方库已安装（实际没有）；
- 在 Python 不可用时声称执行成功；
- 无法知道用户配置的解释器或激活的 venv。

## Decision

- 新增 `src/runtime/pythonRuntime.ts`：
  - 解析顺序：`runtime.python.path` → 激活的 `VIRTUAL_ENV` → PATH 上的 `python3`/`python`；
  - 三态：`ready`（系统解释器）/ `external`（配置或 venv）/ `unavailable`；`enabled: false` 为 `disabled`；
  - 只读探测（单次 `-c` 取版本与 `sys.executable`），不安装、不改 `process.env`；
  - 进程内按 config/env 键缓存，避免每个会话重复 spawn。
- 配置：`runtime.python.enabled` / `runtime.python.path`，`classifyChanges` 归类为 `next-runtime`。
- 提示词：`PromptAssembler` 在 `<user-context>` 内注入 `<python-runtime>`（state/environment/executable/version + 保守指引）。不可用或禁用时明确要求不得声称执行成功。
- `execute_code`：禁用状态直接返回 `unsupported`；有解析解释器时只用该解释器（配置损坏不回退到 PATH），无配置时保留 PATH 回退。

## Alternatives considered

- **打包 Python 3.12 + 精选库。** 落选（本批）。安装器体积、签名、跨平台构建成本高；先让模型知道真实环境，再单独立项评估打包。
- **把解释器写进 `process.env` 供工具读取。** 落选。修改进程环境会影响所有子进程与并发会话，且难以回滚；改为显式传入工具上下文。
- **只做提示词、不改 `execute_code`。** 落选。提示说用配置解释器、执行却用另一个，属于自相矛盾。
- **配置路径失效时静默回退 PATH。** 落选。用户显式指定的解释器不可用时应当报错，而不是换成另一个 Python 执行。
- **每次工具调用都探测。** 落选。Python 启动有成本；进程内缓存 + 显式失效足够。
- **探测并列出已安装库。** 落选（本批）。库清单会随环境变化且容易过期；指引模型「使用前先 import 验证」更可靠。

## Consequences

- 每个进程最多一次 Python 探测（缓存键含 config/env）；配置重载后归入 `next-runtime`。
- `AgentRuntimeConfig` / `SatiToolRuntimeContext` 增加可选 `pythonRuntime` 字段；不改任何工具 `inputSchema`，不需要重录 llm-replay。
- `execute_code` 在被禁用时返回结构化 `unsupported`，不再尝试 PATH。
- 负控制：跳过 VIRTUAL_ENV → venv 用例转红；移除 prompt 块 → 2 条转红；移除禁用守卫 → 禁用用例转红；恢复后 24 条全绿。
