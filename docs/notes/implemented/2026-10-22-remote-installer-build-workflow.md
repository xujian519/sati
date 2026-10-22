# Agent Note: 远程构建 macOS/Windows 安装包工作流

Status: implemented

## Problem

v0.3.8 发布后需要在两个平台上产出可分发安装包：macOS arm64 DMG 与 Windows x64 EXE。本地开发机只能覆盖其中一个平台（Windows 打包依赖 `build-win.bat` 与 Windows 工具链），逐次借用机器既不可复现，也无法让外部维护者复跑。仓库同时没有配置 `CSC_LINK` / Apple 公证凭据，因此任何构建都只能给出未签名产物。

## Decision

新增 `.github/workflows/build-installers.yml`，在 GitHub 托管 runner（`macos-14` / `windows-latest`）上并行构建：

- 只调用既有发布脚本（`apps/desktop/scripts/release.sh --ad-hoc --skip-tests --skip-publish`、`build-win.bat --skip-sign --skip-tests --skip-install`），不复制打包配方；
- 构建前先 `pnpm --filter edgeclaw-memory-core build`，满足 `release.sh` 对 `lib/index.js` 的预检；
- 产物（DMG/EXE + SHA256SUMS + 安装说明）作为 Actions artifacts 保留 30 天，不创建 GitHub Release、不覆盖已发布资产；
- 触发面收窄为两条：向 `ci/remote-installers*` 分支推送，或合并后在默认分支 `workflow_dispatch` 指定 tag/commit。

## Alternatives considered

- **继续本地手工打包** — 单一开发机无法同时覆盖 macOS 与 Windows，产物不可由他人复跑，版本间差异无法归因。
- **在 CI 中重写 electron-builder 命令** — 会与 `release.sh` / `build-win.bat` 形成第二套配方，重演 TD-DESKTOP-N02 的配方分叉；直接调用脚本让发布流程只有一处事实源。
- **接入签名与公证** — 仓库当前没有 Developer ID / Authenticode 证书；引入密钥管理超出「先拿到可安装产物」的范围，留作后续独立决策。
- **构建后自动发布 GitHub Release** — 未签名产物直接对用户可见会放大 SmartScreen/右键打开的摩擦，且发布动作需要与版本策略绑定；当前只交付 artifacts。

## Consequences

- 两个平台的安装包可由 CI 一键复跑，构建参数与发布脚本保持一致。
- 产物未签名：macOS 需右键打开，Windows 会触发 SmartScreen「未知发布者」提示。
- 工作流与 `ci/remote-installers*` 分支名绑定；分支删除后仅剩手动触发入口。
