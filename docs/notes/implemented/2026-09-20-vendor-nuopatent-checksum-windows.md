# Agent Note: nuo-patent checksum 校验在 Windows 下的路径与行尾失配

Status: implemented

## Problem

`vendor/nuo-patent` 的 postinstall 校验（`scripts/verify-checksums.mjs`）用 `relative(pkgRoot, file)` 生成清单路径，而 `checksums.sha256` 在上游 POSIX 环境以正斜杠存储。Windows 上 `relative()` 返回反斜杠，于是每个文件被同时判为 MISSING（正斜杠在 actual 里找不到）与 EXTRA（反斜杠在 expected 里找不到）。

此外仓库启用 `core.autocrlf=true`，`dist/` 下被 Git 识别为文本的产物（`*.js` / `*.mjs` / `*.d.ts` / `*.d.mts`）检出时被改写为 CRLF，SHA-256 与按 LF 提交内容生成的清单失配；单行的 `.map` 文件不受影响。二者叠加导致 Windows 开发者 `pnpm install` 在 postinstall 阶段必然失败。

## Decision

- `verify-checksums.mjs` 新增 `toManifestPath()`，把 `relative()` 结果统一规范化为正斜杠后再进入 generate / verify 两侧比较。
- 新增 `vendor/nuo-patent/.gitattributes`：`dist/** -text`，把预构建产物按二进制检出，禁止行尾改写，使 SHA-256 跨平台稳定。

## Alternatives considered

- **仅在 Windows 本地跑 `verify-checksums.mjs generate` 重生成清单** — 落选：清单会按 CRLF 内容生成，与 POSIX/CI 检出的 LF 内容互相失配，等于把一个平台问题换成另一个平台问题。
- **全局关掉 `core.autocrlf`** — 落选：影响整个仓库所有文本文件的检出策略，副作用不可控，且无法约束协作者的本地配置。
- **改用 `git -c core.autocrlf=false checkout` 之类的一次性命令** — 落选：治标不治本，每个新克隆/重装依赖都会复发，且无法写进仓库让所有协作者受益。
- **在 verify 里对文件内容做 CRLF→LF 归一化后再哈希** — 落选：校验的目的是比对"仓库里存的字节"，归一化会让真正被篡改的产物也通过校验，削弱审计意义。

## Consequences

- Windows（autocrlf=true）下 `pnpm install` 的 postinstall 校验恢复正常，`nuo-patent checksum OK (12 files)`。
- 代价：`dist/` 从此被视为二进制（无 diff 语义），但该目录本就是"不可手改、checksum 审计"的预构建产物，可读 diff 无价值。
- 未处理：脚本仍假定清单路径分隔符为正斜杠（而非改用 `path.posix`），若未来在清单里写入其他平台特有路径仍需留意。
