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

判据：移植上游 `tests/tool/write-symlink-escape.spec.ts` 全套（`tests/tool/write-symlink-escape.spec.ts`，105 例：目录/文件/悬空/循环软链、`..` 组合、三个保护目录、大小写别名、跨 root、allow 不覆盖逃逸、deny/ask 仍生效）；`tests/permission/match-permission-rule.spec.ts` 增一条直接针对新参数的用例。

**2026-10-10 追加（残余面 1+2 收口）**：上一版明示的两项残余这次收口——(1) `text:` 前缀的 allow 规则改为「输入带路径时，词法与真实落点都必须在工作区内」（`matchPermissionRule` 走 `isFileInputInsideWorkspace(…, true)`；输入不带路径时维持纯内容匹配，写工具随后会以缺 `file_path` 拒绝该调用）；(2) 执行层那道「真实落点必须在 root 内」的闸去掉 `allowOutsideWorkspace` 短路、改为无条件生效，`pathSafety` 在拒绝时带出 `details.reason = "symlink_escape"`，`checkFilesystemWritePermission` 据此**不再为逃逸路径提供审批入口**（改判 `deny`：审批授予的是「某个文件夹」，这类路径的词法落点只是假象、真实落点不在任何 root 内，批准了执行层也不放行）。

上一版断言「该短路同时承载用户显式批准写外部目录这条合法路径，单独收紧会连合法外部写入一起拒掉」——**这个判断是错的**：词法本就在 root 外的目标走 `!root` 分支，根本不经过这道闸；能越过这道闸的只有「词法在 root 内、真实落点在 root 外」。判据已把这条钉住：`a session allow rule for an outside folder still authorizes writes there` 现在一路执行到落盘，断言文件确实写在工作区外。与上游的偏离也随之显式化：逃逸目标由上游的 `ask` 改为 `deny`（`tests/tool/write-symlink-escape.spec.ts` 三处 pin 与两条用例名同步改，文件内注明偏离原因）。

## Alternatives considered

- **只修 `pathSafety`（不动权限规则）** —— 工具调用前的授权决策来自 `PermissionRuntime`，allow 规则命中即放行；工具自身的 pathSafety 只在「显式放行」后的落盘前兜底。只修一层会让 allow 规则继续把逃逸路径判成合法授权，是「授权层放行、执行层拒绝」的分裂语义。
- **只修 `matchPermissionRule`** —— 无规则命中（默认模式走 ask/passthrough、bypass 模式直通）的路径仍会逃逸；`.git` 保护判定也仍是词法的。
- **只做词法归一（解析 `..` 但不跟随软链）** —— 完全不解决软链，探针三条依旧成立。
- **凡祖先含软链一律拒绝** —— 连「软链指向工作区内」这种合法用法也拒绝（上游有专门用例守这条），会误伤 `alias-dir` 类正常工作流。
- **保留 `realpathSync`（JS 实现）** —— 它可能在遍历前就把软链目标里的 `..` 折叠掉，得到与 OS 实际落点不符的路径；必须用 `.native`。
- **让写工具各自 realpath** —— 六处写工具（write/edit/notebook/figure/chemical/writePermissions）各写一份，判定必然漂移；收在 pathSafety 单点。
- **逃逸仍给审批，只把 prompt 里的目标换成真实落点** —— 要让它自洽，`matchPermissionRule` 的路径 pattern 得同时能对**真实落点**匹配（否则「允许这个文件夹」这条会话授予对软链路径永不生效，只是换了一种误导），授权面就从「词法位置」扩到「真实位置」，改动面比它要防的残余风险还大。而「直接写真实路径」已经提供同一能力（外部目录审批照旧、会话授予照旧），删掉这个假象入口没有能力损失。
- **保留 `ask`、只让执行层拒（接受「问一次再拒一次」）** —— 用户点「允许」后写入仍失败，不可兑现的提问本身即误导（不静默：要么能兑现，要么不提）。
- **把 TOCTOU 与硬链接一并收口** —— 本次未做：两者分别需要 fd 级复核（open 后比对 dev/ino，得先加测试缝）与「`nlink > 1` 该拒还是该问」的产品取舍，且可达性不同（都要求本地并发写入者或预先存在的硬链接），单独立项见 Issue #643。

## Consequences

- **换来**：写权限与 OS 实际落点一致——工作区内软链（含悬空/循环/换名）不再能逃逸，allow 规则不再覆盖逃逸路径；`.git`/`node_modules`/`dist` 保护不再可被换名软链绕过。
- **付出 / 行为变化**：
  - 循环软链目标（跳数 > 40）由「词法放行」变为显式拒绝 `path_not_allowed`（含 "too many symbolic links"）——方向安全，但错误信息是新的。
  - **根不存在时**真实落点不可比：`roots` 侧的 `safeRealpath` 失败会退回词法根，此时 allow 规则可能**不**命中（fail-safe）。这在真实运行中不出现（工作区必然存在），但会命中「用假 cwd 写用例」的测试——`tests/permission/match-permission-rule.spec.ts` 里两条用例因此改用真实临时目录（`/home` 在本机是指向 `/System/Volumes/Data/home` 的软链，假 cwd 会与真实落点解析分叉）。这是夹具修正，不是语义放宽。
  - 读路径不受影响（`mustExist` 分支原本就有真实路径包含性校验）。
- **未覆盖（明示）**：`bash` 不消费 pathSafety（越权由 `PermissionRuntime` 与 bash 规则管），本次不在范围内；`ToolGuardRegistry` 的单调拒绝链未改动，但相关权限面测试（`PermissionRuntime` / `tool-guard` / `settings` / `policy-bridge`）已作为回归跑过。
- **未覆盖（明示，Issue #643 保持打开的部分）**：解析与落盘之间软链可被重新指向（TOCTOU，只做了一次解析）、硬链接不在任何 `realpath` 里体现。两者都要求本地并发写入者或预先存在的硬链接（不是模型一次调用就能构成的），修复代价见上「Alternatives considered」末条。
- **未覆盖（明示）**：`bypassPermissions` 模式仍可绕过这道闸——该模式是用户显式选择「全都批准」，在 `pathSafety` 顶部即返回（只保留保护目录判定），保持原样。
