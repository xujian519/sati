# Sati Desktop — 发版指南

> 简短规则：**版本号必须和 git tag 一一对应**。`apps/desktop/package.json#version` 是
> 所有版本号的 source of truth；git tag `vX.Y.Z` 把它钉到具体 commit。release.sh
> 会校验这两件事，避免发出"找不到对应代码"的 DMG。
>
> **版本号 lockstep（全仓库）**：仓库根 `package.json` 与 `ui/package.json` 的 `version`
> 必须与 `apps/desktop/package.json` **完全一致**（release.sh 预检强制根版本 == 桌面版本）。
> 后端 gateway hello 帧、MCP 客户端标识、TUI 头部显示都从根 `package.json` 读取
> （见 `src/version.ts`，浏览器侧经 `ui/vite.config.js` 注入），保证「用户安装的桌面版本」
> 与「内部上报的版本」永远一致——bump 桌面版本时请同步改根 `package.json`。

---

## TL;DR — 90% 的发版流程

> **注意**：`bump-version.mjs`（以及 pnpm 10 workspace 内的 `pnpm version`）**只改
> `package.json`，不会自动 git commit / git tag**。因此 git 部分需手动补，见下方
> 完整命令。commit-msg hook 已支持 `release` type（见 `scripts/check-commit-msg.mjs`）。

```bash
# 1. 从仓库根 bump 版本号——根 / apps/desktop / ui 三处同步（lockstep，一次完成）
node scripts/bump-version.mjs patch   # 0.0.16 → 0.0.17（仅修 bug）
# 或：
node scripts/bump-version.mjs minor   # 0.0.16 → 0.1.0（加新功能）
node scripts/bump-version.mjs major   # 0.0.x → 1.0.0（破坏性更新）

# 2. 写一行 CHANGELOG（顶部追加），然后手动补 git commit + tag（脚本不做这两步）
$EDITOR CHANGELOG.md
git add package.json apps/desktop/package.json ui/package.json CHANGELOG.md
git commit -m "release(desktop): v0.0.17"        # %s 需手动替换成实际版本号
git tag -a v0.0.17 -m "release(desktop): v0.0.17"

# 3. 推 commit + tag 到 origin
git push --follow-tags

# 4. 打包 + 上传 GitHub Release（脚本会校验 tag = HEAD = package.json#version）
bash scripts/release.sh --signed
# 脚本完成后会自动创建 GitHub Release 并上传 DMG + install helper
# 跳过上传：bash scripts/release.sh --signed --skip-publish
```

---

## 本地产物路径

所有桌面安装包默认输出到 **`apps/desktop/dist-electron/`**（由 `electron-builder.yml` 的 `directories.output` 决定）。

| 平台 | 构建命令 | 产物 |
|---|---|---|
| macOS (arm64) | `bash apps/desktop/scripts/release.sh` | `Sati-<version>-arm64.dmg`、未打包的 `mac-arm64/Sati.app` |
| Windows (x64) | `apps/desktop/scripts/build-win.bat` | `Sati-<version>-win-x64.exe`（`--arm64` 可打 `Sati-<version>-win-arm64.exe`） |

发版脚本还会在同一目录生成 README 永久链接用的副本：`Sati-latest-arm64.dmg`、`Sati-latest-win-*.exe`（与带版本号文件字节级一致，上传前会校验大小与 SHA256，上传后会用 GitHub API 核对远端大小）。

同目录常见辅助文件：`install-sati.sh`、`INSTALL.md`（macOS 沙盒 IM 安装修复用）。

---

## Windows 发版

Windows 端没有 macOS 的 `release.sh` 流水线（签名/公证/验证/发布一体），由
`build-win.bat` → `verify-installer.bat` → `release-l2-win.mjs` → `publish-win.mjs`
四步独立执行，在 **Windows 机器/虚拟机**上运行：

```bat
REM 1. 构建（从仓库根运行，默认 x64；--arm64 打 arm64 包）
apps\desktop\scripts\build-win.bat

REM 2. L1 制品冒烟（结构 / 运行时 / FTS5 / native 模块 / gateway 健康）
REM    ——2026-08 起 4b/4c/5 段真实执行（此前被 bat 解析缺陷静默跳过；gateway
REM     检查含 pnpm vstore 重链 + 运行时同款接线，冷缓存启动需 ~1-2 分钟）
verify-installer.bat

REM 3. L2 冒烟（UI tab / onboarding / Electron 冷启动；需交互式桌面会话）
node scripts\release-l2-win.mjs dist-electron\win-unpacked

REM 3b.（可选）L3 真模型 E2E（需要 API key；无 key 自动 skip）
node scripts\release-l3-win.mjs            REM 或 --force 无 key 时失败

REM 4. 发布到 GitHub Releases（需 gh CLI 且已 auth）
node scripts\publish-win.mjs dist-electron
```

> **发布门禁**：`publish-win.mjs` 现在与 `release.sh` 的 pre-flight 对齐——校验
> 版本 lockstep（根 / ui / desktop 三处一致）、git tag `vX.Y.Z` 必须指向 HEAD、
> 且仅在 main/master/release 分支发布。紧急/本地发布可用环境变量绕过：
> `ALLOW_UNTAGGED=1`（跳过 tag 校验）、`ALLOW_NON_MAIN_SIGNED=1`（允许非
> main 分支），语义与 `release.sh` 完全一致。

### build-win.bat 参数

| 参数 | 说明 |
|---|---|
| `--skip-install` | 跳过 pnpm install（复用已装依赖） |
| `--skip-build` | 跳过构建（复用已有 `ui/dist` + `dist/src`） |
| `--skip-tests` | 跳过测试门禁（紧急本地构建用，**正式发版不要用**） |
| `--skip-sign` | 强制跳过 Authenticode 签名 |
| `--arm64` | 构建 arm64 安装包（自动下载 arm64 运行时并只打 arm64） |
| `--pull` | 构建前 `git pull origin main`（默认不拉取，避免覆盖本地未提交改动） |

### 与 macOS release.sh 的对齐与差异

`build-win.bat` 已对齐 `release.sh` 的关键门禁：版本 lockstep 校验、`pnpm test`
测试门禁、Node **v22.23.2**（bundled SQLite 带 FTS5，`law_fts` 全文检索依赖；
v22.14.0 无 FTS5 会降级为 LIKE）、Node/Bun 下载 SHA256 校验、bundle 排除列表
（`node_modules/.pnpm/node_modules` hoist 根整体排除——Windows bsdtar 会把它
的 junction 物化成完整副本，实测占 sati-main tar 44%：1.45GB → ~745MB）、
native 依赖 **preflight**（better-sqlite3 / sharp / node-pty / mupdf 全部自带
ABI 正确的预编译产物，`check-native-win.mjs` 用 bundled node 秒级验证加载；
旧流程每次构建都 node-gyp rebuild 5-15 分钟且无 MSVC 时静默降级）。

差异：

- **无公证**：Windows 没有 Apple 公证对应的机制，靠 Authenticode 签名兜底
- **L3 封装脚本**：Windows 用 `release-l3-win.mjs` 镜像 `release-l3.sh`（真模型
  E2E，需 API key）。注意：`release-l3.sh` 引用的真模型 harness
  （`framework-wcb-smoke` / `run-real-agent-lifecycle-hooks`）已从仓库移除，
  Windows 脚本会自动检测并明确报告"无 harness 可跑"，两个平台在 harness 恢复
  前都无法真正执行 L3
- **签名需自备证书**：设置环境变量后 electron-builder 自动签名，见下
- **托盘常驻**：Windows 桌面端关窗最小化到托盘而非退出（`main.ts`），与
  macOS 的"关闭即隐藏"行为对齐 always-on 定位
- **关于面板**：macOS 用原生 About 面板（`app.setAboutPanelOptions`）；Windows
  上该 API 是 no-op，`main.ts` 在帮助菜单里补了一个原生"关于 Sati"对话框，
  显示同样的 version + git-sha + build-date 三段信息

### 签名（Authenticode）

未签名的安装包在用户机器上触发 SmartScreen"未知发布者"警告。要签名：

```bat
set CSC_LINK=C:\certs\sati.pfx        REM 证书文件路径（或 base64 内容）
set CSC_KEY_PASSWORD=你的私钥密码
build-win.bat
```

脚本检测到 `CSC_LINK` 即走 electron-builder 签名路径，`build-info.json` 的
`mode` 字段标记为 `win-signed`（未签名时为 `win-unsigned`）。证书需为 OV/EV
代码签名证书——个人证书签出的包仍会触发 SmartScreen。

### SmartScreen 提示（未签名时的用户指引）

首次运行未签名安装包：双击 exe → 弹出"Windows 已保护你的电脑" →
点"更多信息" → "仍要运行"。

发给用户前可用 `verify-signature-win.bat` 校验产物：它输出 SHA256、Authenticode
签名状态（Valid / NotSigned / 错误）与签发者，帮助确认安装包完整且来源可信
（Windows 版 install-sati.sh 的对应物——macOS 有 Gatekeeper/provenance 需要修复，
Windows 没有，只需验证签名与哈希）。

### arm64 说明

默认只打 x64。此前默认双架构但 arm64 包内嵌 x64 运行时（坏包），已修正为：
`build-win.bat --arm64` 会下载 arm64 的 Node/Bun 运行时并只打 arm64 安装包。
arm64 构建同样需在 Windows 机器上执行。

### 发布（publish-win.mjs）

`publish-win.mjs` 是 `release.sh` 发布段的 Windows 镜像：收集 exe → 最小体积
校验（100MB）→ CHANGELOG.md 提取 release notes → `gh release view/create` →
上传 exe + `Sati-latest-win-*.exe` permalink 副本（字节级 + SHA256 校验）→
GitHub API 远端大小核对。前置条件：`gh` CLI 已安装且 `gh auth login` 完成。

---

## 发布前测试（分层，按最佳实践）

原则：**快且确定性的进自动化门禁；慢、要密钥、易抖动的不要塞进每次 DMG 构建。**

```
                    ┌─────────────────────────────────────┐
  每次 PR / 合并前   │ L0  pnpm test（仓库根目录）            │  ← release.sh 默认也会跑
                    │     Gateway / config / bridge 单测   │
                    └─────────────────────────────────────┘
                                      ↓
                    ┌─────────────────────────────────────┐
  每次打出 DMG 后    │ L1  verify-dmg.sh（制品冒烟）         │  ← release.sh 默认调用
                    │     签名 / bundle / 沙箱起双进程       │
                    │     V2 sati.yaml + bridge 连通   │
                    │     onboarding → loadPilotConfig      │
                    └─────────────────────────────────────┘
                                      ↓
                    ┌─────────────────────────────────────┐
  发 rc / 正式版前   │ L2  人工或半自动（可选清单）          │  ← 不进脚本，见下表
                    │     真机安装 DMG、Gatekeeper、About   │
                    │     Electron 首次启动 + 桌面 onboarding│
                    └─────────────────────────────────────┘
                                      ↓
                    ┌─────────────────────────────────────┐
  nightly / 发版前   │ L3  真模型 E2E（opt-in）              │  ← 绝不默认进 release.sh
                    │     SATI_RUN_FRAMEWORK_E2E=1     │
                    │     SATI_RUN_REAL_AGENT_…=1      │
                    └─────────────────────────────────────┘
```

### L0 — 源码门禁（`pnpm test`）

- **何时跑**：`release.sh` 在打包前默认执行；日常开发、PR 也应跑同一命令。
- **覆盖**：`dist/tests/**`（含 `tests/desktop/onboarding-config-compat`）、Gateway、配置加载等。
- **跳过**：`bash scripts/release.sh --skip-tests`（仅本地救急，**正式 signed 发版不要用**）。

### L1 — DMG 制品冒烟（`verify-dmg.sh`）

- **何时跑**：`release.sh` 打出 DMG 后自动调用（`--skip-verify` 可跳过）。
- **覆盖**：挂载 DMG、codesign、tar 内 `server` / `sati` CLI、沙箱里用 **打包进去的 node** 起 Gateway(19789) + UI(18790)、`sati-bridge` 连通、V2 stub 配置、onboarding YAML 与 `loadPilotConfig` 兼容。
- **故意不做**：不启动真实 Electron 窗口、不调 LLM API、不跑 Playwright 点 UI。

### L2 — UI / onboarding / Electron（Playwright，可自动化）

2026 年实践：**确定性脚本**（Playwright）负责可重复门禁；人工只补 L2 里脚本覆盖不到的项（另一台 Mac 冷启动、真用户拖拽安装）。

```bash
# DMG 或 .app 路径
bash apps/desktop/scripts/release-l2.sh dist-electron/Sati-0.0.5-arm64.dmg

# 无 GUI / CI：跳过 Electron 窗口测试
PD_SKIP_ELECTRON=1 bash apps/desktop/scripts/release-l2.sh <DMG>

# 子项（release-l2.sh 内部顺序）：
#   L2a  Playwright → 打包 UI 的 Agent/Files/Skills/Routing/Memory Tab
#   L2b  onboarding.html + mock IPC → buildConfigYaml V2
#   L2c  Playwright Electron → 已有 V2 配置时主窗口加载（隔离 HOME，不测 onboarding）
#   L2d  冷启动 Electron → 无 sati.yaml，走真实 onboarding 并校验 V2 写入（隔离 HOME）
#   默认不修改本机 ~/.sati；无需备份/复原。若必须用真机目录，见 scripts/lib/sati-user-config.sh
```

与 `release.sh` 集成：

```bash
bash scripts/release.sh --signed --with-l2          # L1 + L2
bash scripts/release.sh --signed --full-verify      # L1 + L2 + L3（无 key 时 L3 自动 skip）
bash apps/desktop/scripts/release-verify-all.sh <DMG>   # 同上，独立跑
```

**L2 仍建议人工抽查（脚本不替代）**

| 项 | 说明 |
|---|---|
| 安装 | 从 DMG 拖到 `/Applications`，首次打开无「已损坏」 |
| About | 菜单 **Sati → 关于**，version / git-sha / date 与 tag 一致 |
| 签名版 | `spctl -a -vv` / 另一台 Mac 冷启动（已公证时） |

### L3 — 真模型 E2E（脚本化，opt-in）

```bash
export ANTHROPIC_API_KEY=sk-...   # 或 OPENAI_API_KEY / SATI_API_KEY
bash apps/desktop/scripts/release-l3.sh

# 额外跑 lifecycle hooks：
SATI_RUN_REAL_AGENT_LIFECYCLE_E2E=1 bash apps/desktop/scripts/release-l3.sh
```

Windows 用 Node 镜像：

```bat
set ANTHROPIC_API_KEY=sk-...
node apps\desktop\scripts\release-l3-win.mjs          REM 无 key 自动 skip
node apps\desktop\scripts\release-l3-win.mjs --force  REM 无 key 时失败
set SATI_RUN_REAL_AGENT_LIFECYCLE_E2E=1
node apps\desktop\scripts\release-l3-win.mjs          REM 额外跑 lifecycle hooks
```

无 API key 时 `release-l3.sh` / `release-l3-win.mjs` **退出 0 并 skip**（不挡发版）；
`--force` 则在缺 key 时失败。

> **当前状态**：两平台脚本引用的真模型 harness（`dist/tests/e2e/framework-wcb-smoke`
> 与 `dist/tests/agent/e2e/run-real-agent-lifecycle-hooks`）已从仓库移除，脚本会
> 自动检测并报告"无 harness 可跑"。恢复 harness 后两平台即可执行真模型 E2E。

**为什么 L3 不进默认 DMG 构建？** 需要密钥、外网、配额；失败常是环境而非制品——默认只在 `--full-verify` / nightly / 发 rc 前显式开启。

### 「AI 帮忙跑」指什么？

- **已落地**：Playwright 自动点 Tab、走 onboarding 表单、可选启动 Electron——这是 L2/L3 的**可重复自动化**，适合每次发版。
- **不放进 release 脚本**：在 Cursor 里让 Agent 用 browse 技能「探索式 QA」——适合发现偶发 UI 问题，但慢、非确定性，适合发版前人工触发一次，而不是 `release.sh` 默认步骤。

### 和「新用户配置」Bug 的关系

- **预防**：L0 的 `onboarding-config-compat` + L1 的 V2 stub / Step 9，保证桌面 onboarding 写的 YAML 能被 Gateway 加载。
- **回归**：改 `onboarding-window.ts` / `onboarding-config.ts` 后必须 `pnpm test`；改打包路径后必须过完整 `verify-dmg`。

---

## 何时 bump 哪段？SemVer 速记

| 改动类型 | bump 哪段 | 例子 |
|---|---|---|
| 仅修 bug，用户行为不变 | **patch** | 0.0.16 → 0.0.17（修了 provider test 误报 400） |
| 加新功能，向后兼容 | **minor** | 0.0.16 → 0.1.0（加了 provider test 弹窗） |
| 用户必须重装/重配，配置文件不兼容 | **major** | 0.x → 1.0.0；1.x → 2.0.0 |

**0.x 阶段（当前）**：所有破坏性改动都走 **minor** 即可，不必动 major——这是 SemVer 对
0.x 的"宽容期"约定。等到产品稳定再 `node scripts/bump-version.mjs major` 跳到 1.0.0。

---

## Pre-release（rc / beta）

发给少量用户验证、不公开宣传时用。`bump-version.mjs` 只支持 patch/minor/major，
rc 流程仍用 `pnpm version prerelease`（在 apps/desktop/ 下），**完成后需手动把
根 `package.json` 与 `ui/package.json` 的 version 同步为同一值**（lockstep）：

```bash
pnpm version prerelease --preid=rc -m "release(desktop): v%s"  # 0.0.17 → 0.0.18-rc.0
# 反复迭代：
pnpm version prerelease --preid=rc -m "release(desktop): v%s"  # → 0.0.18-rc.1
# 转正：
pnpm version 0.0.18 -m "release(desktop): v%s"
```

---

## tag 应该打在哪个分支？

| 场景 | tag 在哪 | 是否强制 |
|---|---|---|
| 本地测试（`--ad-hoc`） | 任意分支 | ❌ 不强制（可设 `ALLOW_UNTAGGED=1` 跳过） |
| Pre-release（`-rc.*`） | release 分支 / feature 分支 | 建议但不强制 |
| 正式 release（`--signed`） | **必须 main / master / release** | ✅ release.sh 在非允许分支会拒绝 |

**为什么正式 release 要打在 main / release**：feature 分支被 squash merge 后，原 commit
不在主线历史里——tag 没丢，但 `git log main` 找不到，给人"我装的版本对应的代码消失了"
的错觉。打在 main 或 release 分支才能保证 tag 在可追溯的发版线上。

---

## CHANGELOG 维护

`CHANGELOG.md` 在仓库根目录。每次 bump 之前在顶部追加一段：

```markdown
## v0.0.17 - 2026-08-05
### Added
- Settings → Models 加入 Provider/Entry "测试连接"功能
### Fixed
- 修复 provider-only 测试默认使用 gpt-4o-mini 导致 MiniMax/DeepSeek 等兼容网关误报 400
```

写不出 "Added" 段就只 bump patch，"Added" 多就 bump minor——这是个非常实用的判断器。

---

## 如果忘了打 tag 就跑了 release.sh

```
✗ No git tag 'v0.0.17' for version 0.0.17.
    Run 'node scripts/bump-version.mjs' from the repo root first, then tag the release commit.
    本地测试可加: ALLOW_UNTAGGED=1 bash scripts/release.sh --ad-hoc
```

按提示来即可。**不要**手动改 package.json 后漏掉 commit/tag —— 版本号修改用
`node scripts/bump-version.mjs`（一次同步根 / desktop / ui 三处），git commit / tag
手动补（见 TL;DR）。两件事都要做：release.sh 会校验
`tag^{commit} == HEAD`，tag 必须指向 release commit。

---

## 如果在 feature 分支上跑了 `--signed`

```
✗ release(--signed) requires main/master branch (current: feat/merged-0428-ui-v2)
    内部测试请用: bash scripts/release.sh --ad-hoc
    正式发版请: git checkout main && git merge --ff-only <branch>
```

签名构建对外发，必须从 main 出。如果硬要在 feature 分支签名（极少数 hotfix 场景），
设环境变量 `ALLOW_NON_MAIN_SIGNED=1` 强制。

---

## Apple Notarization 钥匙串问题（已知坑）

### 症状

`xcrun notarytool submit` 报 **"No Keychain password item found for profile: Sati"**，
但凭证确实存过。有时重试能过，有时连续失败几小时。

### 根因

`notarytool store-credentials` 默认将凭证存入 **Data Protection Keychain**
（即 iCloud 钥匙串 / Local Items），而非 `login.keychain-db`。
Data Protection Keychain 有自己的锁定超时机制——macOS 在一段时间不活跃、屏幕锁定、
或某些 codesign 操作后会静默锁定，导致 `notarytool` 读不到凭证。

verbose 日志中的关键行：
```
[KEYCHAIN] Couldn't find keychain item matching [..., "sync": "syna", ...]
```
`"sync": "syna"` 表示它在查询可同步（iCloud）钥匙串中的条目。

### 永久解决方案（推荐）

将凭证重新存入 **文件钥匙串** `login.keychain-db`，避免 Data Protection Keychain：

```bash
# 1. 存凭证到 login.keychain-db（只需做一次）
xcrun notarytool store-credentials "Sati" \
  --apple-id <your-apple-id> \
  --team-id 77Y5JFSH6H \
  --password <app-specific-password> \
  --keychain ~/Library/Keychains/login.keychain-db

# 2. 之后所有 submit/history 命令都加 --keychain
xcrun notarytool submit app.zip \
  --keychain-profile Sati \
  --keychain ~/Library/Keychains/login.keychain-db \
  --wait
```

`release.sh` 已内置此参数，无需手动传。

### 临时 Workaround

如果还没重新存凭证，可以在 submit 前跑一次 `--verbose` 的 `history` 调用
来"唤醒" Data Protection Keychain（不保证 100% 有效）：

```bash
xcrun notarytool history --keychain-profile Sati --verbose >/dev/null 2>&1
xcrun notarytool submit ...
```

### 替代方案：App Store Connect API Key

完全避开钥匙串，改用 API Key 认证（适合 CI/CD）：

```bash
xcrun notarytool submit app.zip \
  --key ~/private_keys/AuthKey_XXXXXXXXXX.p8 \
  --key-id XXXXXXXXXX \
  --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  --wait
```

---

## 一些常见陷阱

1. **不要在 release.sh 里自动 bump**——同一份代码在我电脑/你电脑会被打成两个版本号；
   rebase / 分支地狱直接送命。版本号必须由人在准备发版时显式 `pnpm version`。
2. **不要手动改 package.json 后忘了打 tag**——release.sh 会拦下，但养成 `pnpm version`
   的习惯就再也不会犯。
3. **不要把 tag 推到错的 remote**——`git push --follow-tags` 默认推 origin；如果你有
   多个 remote 要清楚自己在推谁。
4. **electron-builder 自动从 package.json 读 version**——这是 single source of truth，
   不要在 electron-builder.yml 里硬编码 version。

---

## 历史记录与版本溯源

- `apps/desktop/package.json#version`  ← single source of truth
- `git tag vX.Y.Z` 指向那个 commit
- DMG 文件名 `Sati-X.Y.Z-arm64.dmg` 来自 package.json
- macOS 顶部菜单栏 → **Sati → 关于 Sati** 显示：
  ```
  Sati
  Version 0.0.17
  build a2f682b · 2026-08-05
  Copyright © 2026 徐健  xujian519@gmail.com. AGPL-3.0-or-later.
  ```
  （macOS 原生 About 面板，由 `app.setAboutPanelOptions()` 注入；不需要进 Settings）
- release.sh 末尾的 `Build` 行同样的三段信息，方便发包前核对

任何用户报 bug，让他打开"关于 Sati"截图，三个数字（version、git-sha、date）就能精确定位代码。

**Dev 模式**（`pnpm run dev`）下 `build-info.json` 不存在，About 面板会显示
`build` 那行为 `dev build`，与正式包视觉上一眼可分辨。
