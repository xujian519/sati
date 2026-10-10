# Agent Note: 写路径按真实落点授权（符号链接逃逸修复）

Status: implemented

## Problem

写操作由 OS 跟随符号链接落盘，但授权只看**词法路径**。因此工作区里只要存在一个指向外部的符号链接，`write_file` / `edit_file` 写 `link/...` 就能写到工作区外——且因为词法上仍在工作区内，`matchPermissionRule` 的 workspace 级 allow 规则还会**主动授权**它。

先写探针取证（`tests/tool/` 下一支临时 spec，验证后删除），在未修复代码上三条全部成立：

| 探针场景 | 未修复行为 |
|---|---|
| 目录软链指向工作区外，写 `escape/created.txt` | 权限判为 `passthrough`，文件**确实在**工作区外落地 |
| 目录软链指向 `.git`（`repo-internals -> .git`） | 权限 `passthrough`，`.git/HEAD` 被改写 |
| workspace 级 allow 规则 + `escape/new.txt` | 规则命中（`true`），即被显式授权 |

`.git`/`node_modules`/`dist` 的保护目录判定（`isWriteDenied`）是纯词法的首段比较，换名软链即可绕过；悬空软链（目标尚不存在）同样成立。

## Decision

移植上游 PilotDeck 的修法（commit `6afe9c6d`，AGPL-3.0；本项目与其同源），落到 **两道防线**：

- **`src/tool/builtin/filesystem/pathSafety.ts`**：新增导出 `resolveRealWritePath()`——逐组件解析软链（`readlinkSync` + `realpathSync.native`，`MAX_SYMLINK_HOPS=40`），处理悬空链、链内 `..`、大小写别名，超跳数返回 `undefined`；写路径（`forWrite`）一律先算真实落点，解析失败即 `path_not_allowed`。新增 `isRealWriteDenied()`（用同一逐组件逻辑解析保护目录，含悬空保护目录软链）与 `findRealRoot()`，接到**所有写分支**：`bypassPermissions`、`allowOutsideWorkspace`、root 内，以及返回成功前的无条件检查「真实落点必须落在某个 root 内（除非显式 allowOutsideWorkspace）」。`safeRealpath` 由 `realpathSync` 改为 `realpathSync.native`。
- **`src/permission/policy/matchPermissionRule.ts`**：`isFileInputInsideWorkspace()` 增 `resolveSymlinks` 参数，`behavior === "allow"` 时要求真实落点也在 root 内；deny/ask 规则不参与真实路径判定（本就是「命中即生效」，否则显式规则会被逃逸路径绕过）。本项目特有的 `text:` 前缀匹配逻辑保持原样。

**2026-10-10 追加（判据先行，再补）**：上面两道防线漏了**带 `pattern` 的 allow 规则**——真实落点判定只挂在「无 pattern」分支，而 pattern 命中后执行层那道闸又被 `allowOutsideWorkspace` 短路，于是「允许这个文件夹」审批铸造的会话规则（`writePermissions.ts` 的 `buildRecursiveFileWriteRule`，pattern 取自**词法**路径）仍能放行越界写入。已补齐：`matchPermissionRule` 对该形态要求「词法在 root 内 ⇒ 真实落点也在 root 内」（新增 `isRealLandingInsideRoots()`，根侧用同一逐组件解析，使根不存在/根本身是软链时两侧可比）；词法本就在 root 外的授予（用户显式批准的外部目录）与 `text:` 规则不参与该判定，deny/ask 照旧。判据：`tests/tool/write-symlink-escape.spec.ts` 的 "a folder-scoped write_file allow rule (with pattern) does not cover symlinks that escape the workspace"——先行落红，补完后转绿。

判据：移植上游 `tests/tool/write-symlink-escape.spec.ts` 全套（`tests/tool/write-symlink-escape.spec.ts`，101 例：目录/文件/悬空/循环软链、`..` 组合、三个保护目录、大小写别名、跨 root、allow 不覆盖逃逸、deny/ask 仍生效）；`tests/permission/match-permission-rule.spec.ts` 增一条直接针对新参数的用例。

## Alternatives considered

- **只修 `pathSafety`（不动权限规则）** —— 工具调用前的授权决策来自 `PermissionRuntime`，allow 规则命中即放行；工具自身的 pathSafety 只在「显式放行」后的落盘前兜底。只修一层会让 allow 规则继续把逃逸路径判成合法授权，是「授权层放行、执行层拒绝」的分裂语义。
- **只修 `matchPermissionRule`** —— 无规则命中（默认模式走 ask/passthrough、bypass 模式直通）的路径仍会逃逸；`.git` 保护判定也仍是词法的。
- **只做词法归一（解析 `..` 但不跟随软链）** —— 完全不解决软链，探针三条依旧成立。
- **凡祖先含软链一律拒绝** —— 连「软链指向工作区内」这种合法用法也拒绝（上游有专门用例守这条），会误伤 `alias-dir` 类正常工作流。
- **保留 `realpathSync`（JS 实现）** —— 它可能在遍历前就把软链目标里的 `..` 折叠掉，得到与 OS 实际落点不符的路径；必须用 `.native`。
- **让写工具各自 realpath** —— 六处写工具（write/edit/notebook/figure/chemical/writePermissions）各写一份，判定必然漂移；收在 pathSafety 单点。

## Consequences

- **换来**：写权限与 OS 实际落点一致——工作区内软链（含悬空/循环/换名）不再能逃逸，allow 规则不再覆盖逃逸路径；`.git`/`node_modules`/`dist` 保护不再可被换名软链绕过。
- **付出 / 行为变化**：
  - 循环软链目标（跳数 > 40）由「词法放行」变为显式拒绝 `path_not_allowed`（含 "too many symbolic links"）——方向安全，但错误信息是新的。
  - **根不存在时**真实落点不可比：`roots` 侧的 `safeRealpath` 失败会退回词法根，此时 allow 规则可能**不**命中（fail-safe）。这在真实运行中不出现（工作区必然存在），但会命中「用假 cwd 写用例」的测试——`tests/permission/match-permission-rule.spec.ts` 里两条用例因此改用真实临时目录（`/home` 在本机是指向 `/System/Volumes/Data/home` 的软链，假 cwd 会与真实落点解析分叉）。这是夹具修正，不是语义放宽。
  - 读路径不受影响（`mustExist` 分支原本就有真实路径包含性校验）。
- **未覆盖（明示）**：`bash` 不消费 pathSafety（越权由 `PermissionRuntime` 与 bash 规则管），本次不在范围内；`ToolGuardRegistry` 的单调拒绝链未改动，但相关权限面测试（`PermissionRuntime` / `tool-guard` / `settings` / `policy-bridge`）已作为回归跑过。
- **未覆盖（明示）**：`text:` 前缀的 allow 规则（对序列化输入做包含匹配，无路径语义）不参与真实落点判定——`write_file` / `edit_file` 的输入里出现它命中的子串时，仍可放行越界写入。执行层那道闸在决策为 `allow` 时被 `allowOutsideWorkspace` 短路；该短路同时承载「用户显式批准写外部目录」这条合法路径（`checkFilesystemWritePermission` 的 `ask` → 批准 → 落盘依赖它），单独收紧会连合法外部写入一起拒掉，故未动。另有两项残余风险：解析与落盘之间软链可被重新指向（TOCTOU，只靠一次解析），硬链接不在任何 `realpath` 里体现。故上文「不再能逃逸」应读作「按词法路径授予的逃逸（含带路径 pattern 的 allow 规则）不再成立」。
