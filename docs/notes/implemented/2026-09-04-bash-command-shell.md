# Agent Note: bash 工具 shell 统一解析（bash 优先）

Status: implemented

## Problem

bash 工具与后台任务（`BackgroundTaskRuntime`）依赖 `spawn({ shell: true })`，Windows 落到 cmd.exe、Unix 落到 /bin/sh。模型生成的命令按 bash 语义书写（`&&`、`$(...)`、引号、glob），在 cmd 下失败率高，且跨平台行为不一致。Sati 用户群 Windows 占比高（专利行业），该不一致被放大。

移植自 PilotDeck `desktop-v2026.09.02` #537（`commandShell.ts`），按 Sati 结构适配（`SATI_SHELL_PATH` 环境变量名、src/runtime/ 新模块 + barrel）。

## Decision

新增 `src/runtime/commandShell.ts`（+ `index.ts` barrel）：

- `resolveDefaultCommandShell(options)` 纯解析：`SATI_SHELL_PATH` 显式覆盖（缺失 fail-loud）→ 非 Windows `/bin/bash`/PATH bash、兜底 `/bin/sh` → Windows Git Bash 四固定路径 → `ComSpec`(cmd) → `pwsh.exe` → 全部不可用抛错；
- 返回显式 spawn 形态 `{ shell, args(command), kind, windowsVerbatimArguments }`——不再用 `shell: true`，消除 Node 对各 shell 的默认参数差异（cmd 需 `/d /s /c` + verbatim，bash/sh 需 `-c`）；
- `getSatiCommandShell()` 进程级缓存（env/platform 进程内不变），测试经 `resolveDefaultCommandShell` 注入假 platform/env/existsSync。

接线两处 spawn 点：`NodeShellCommandRunner`（bash 工具前台，构造函数新增可注入 `resolveShell`）与 `BackgroundTaskRuntime.start`（后台任务）。超时击杀（taskkill/kill(-pid)）与输出解码逻辑不变。bash 工具顶层 description 更新为 bash 语义说明；`inputSchema` 未动，llm-replay fixture 不受影响。

行为变化：Windows 上 shell 从 cmd.exe 变为 Git Bash（未装则维持 cmd/pwsh 兜底），Unix 上 /bin/sh 变为 bash（语义超集）。回退路径：`SATI_SHELL_PATH` 指回原 shell。

## Alternatives considered

- **保持 `shell: true`，仅在 prompt 层引导模型写跨平台命令** — 落选：无法消除平台差异本身，且模型对 cmd/bash 分支的遵循率不可控；解析层统一一次到位。
- **cmd 下翻译命令（sh→cmd 语法转换）** — 落选：转换器复杂且必然有语义偏差；Git Bash 探测是上游已验证的更简单解。
- **Windows 直接拒绝非 bash 环境** — 落选：大量无 Git Bash 的 Windows 环境会被锁死工具；cmd/pwsh 兜底保留可用性。
- **每工具调用时解析（不缓存）** — 落选：PATH 探测有 fs 开销，env/platform 进程内不变，进程级缓存即可；需要动态性时清缓存重测的成本远大于收益。
