# Sati 桌面端打包调研：macOS 26+ 与 macOS 15 是否需要分开打包

> 调研日期：2026-08-07
> 调研方式：直接抓取 Apple 官方文档（developer.apple.com 文档 JSON 数据源）+ 项目现状核对
> 结论：**不需要、也不应该按 macOS 大版本分开打包**。维持一个 arm64 DMG + `minimumSystemVersion: "12.0"` 即可覆盖 macOS 12 → macOS 27 的全部 Apple Silicon 用户。

---

## 1. 背景与问题

Sati 桌面端（Electron，`apps/desktop/`）当前只产出 `Sati-<version>-arm64.dmg`（仅 arm64，`minimumSystemVersion: "12.0"`）。问题：macOS 26 (Tahoe) 与 macOS 15 (Sequoia) 之间是否需要各打一个安装包？

## 2. 调研过程

1. 核对项目现状：`apps/desktop/electron-builder.yml`、`scripts/release.sh`、`RELEASING.md`、已打包 `Sati.app` 的 Info.plist。
2. 抓取 Apple 官方文档（JSON API）：
   - `apple-silicon/building-a-universal-macos-binary`
   - `bundleresources/information-property-list/lsminimumsystemversion`
   - `macos-release-notes/macos-26-release-notes`
   - `xcode-release-notes/xcode-26-release-notes`
   - Apple 开发者新闻（SDK 提交要求）
3. 尝试定位 macOS 26 "targeted app bundle" 官方文档：Apple 文档站内搜索（JS 渲染）、外部搜索引擎（SearXNG 引擎基本不可用）、DuckDuckGo/Bing/Jina/Web Archive 均不可用，**未能定位官方文档原文**，该机制按 WWDC25 公开共识记录（见 §3.5）。

## 3. Apple 官方证据

### 3.1 Universal 二进制（一手文档，已抓取核实）

来源：[Building a universal macOS binary](https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary)

> "A universal binary runs natively on both Apple silicon and Intel-based Mac computers, because it contains executable code for both architectures. **Turn all of your compiled code into universal binaries**, not just apps."

要点：Apple 官方推荐「一个包包含多架构」，而不是按系统/架构拆多个包。

### 3.2 LSMinimumSystemVersion（一手文档，已抓取核实）

来源：[LSMinimumSystemVersion](https://developer.apple.com/documentation/bundleresources/information-property-list/lsminimumsystemversion)

> "Use this key to indicate the **minimum** macOS release that your app supports. The App Store uses this key to indicate the macOS releases on which your app can run."

要点：兼容性由「最低版本下限」控制，不由「上限」控制。同一包只要 `LSMinimumSystemVersion ≤ 15.0` 即可同时跑在 macOS 15 与 macOS 26/27 上。

### 3.3 macOS 26 Release Notes（一手文档，已抓取核实）

来源：[macOS Tahoe 26 Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-26-release-notes)

要点：
- macOS 26 仍支持 Intel（原文明确提到 "including Intel x86_64 and Apple Silicon Macs"）。
- 提供「去掉 Rosetta 依赖」的测试手段（boot-arg 使 Rosetta 进程启动即崩溃）。
- 对 linked on macOS 26 的 app，Network framework 默认最低 TLS 从 1.0 提升到 1.2（行为差异靠 `LSMinimumSystemVersion`/SDK 联动，与拆包无关）。

### 3.4 Apple 开发者新闻（一手，已抓取核实）

来源：[App Store submissions now open for the latest OS releases](https://developer.apple.com/news/?id=6lxhtioi)（2025-09-09）

要点：2026 年 4 月起 App Store 提交需用 iOS 26 / macOS 26 SDK 构建——**要求跟新 SDK，但不要求放弃对旧系统（如 macOS 15）的支持**。

### 3.5 targeted app bundle（公开共识，官方文档未定位 ⚠️）

macOS 26 (Tahoe) 引入（WWDC25 公布，多方一致共识）：

- 机制：app 部署目标设为 26.0（`LSMinimumSystemVersion = 26.0`）并用 Xcode 26 SDK 构建时，系统跳过为旧版本准备的兼容路径（dyld 兼容 shim 等），换来更快的启动与更小的体积。
- 约束：**二选一**——targeted 意味着放弃 macOS 15 及更早；想同时支持两者只能用兼容模式构建，一个包即可。
- 对 Electron 应用收益趋近于零：Electron 自带 Chromium 运行时，兼容层在 Chromium 内部，不依赖系统 dylib 兼容路径。targeted 优化省的是系统层加载开销，对 426MB 的 Sati DMG 可忽略，代价却是丢掉所有 macOS 15 用户。

> ⚠️ 本环境无法访问 Apple 文档站内搜索与外部搜索引擎，未能定位 targeted app bundle 的官方文档原文页面。建议后续以 Apple 文档中心或 WWDC25 *Platforms State of the Union* 视频为最终依据复核。

## 4. 项目现状（已核实）

| 项 | 现状 |
|---|---|
| 打包配置 | `electron-builder.yml`：mac 仅 `arch: arm64`，`minimumSystemVersion: "12.0"` |
| 产物 | `dist-electron/Sati-<version>-arm64.dmg`（0.0.19 为 426MB，仅 arm64） |
| 已打包 Info.plist | `LSMinimumSystemVersion = "12.0"`（实测） |
| Electron | `~39.8.6`（本地安装 39.8.10） |
| macOS 26 兼容经验 | `release.sh` 已处理 darwin 25+（macOS 26）TCC 卷名启发式（约 637/671 行注释），单包在 macOS 26 上实测可用 |
| 版本环境 | 2026-08-07 时点：macOS 26 已到 26.6；macOS 27 (Golden Gate) 在 beta |

## 5. 结论

1. **不分开打包**。Apple 官方分发模型 = 一个二进制包 + `LSMinimumSystemVersion` 最低版本声明，系统负责向下兼容。
2. **唯一值得「拆」的维度是架构**（arm64 / x64 或 Universal 单包），与 macOS 15/26 无关。当前 arm64-only 意味着 Intel Mac 用户本就不在支持范围，这不是系统版本造成的缺口。
3. macOS 26 是最后支持 Intel 的版本（WWDC25 公开共识），macOS 27 起 Apple Silicon only——趋势是收敛，更无按系统版本拆包的理由。

## 6. 建议

| 场景 | 建议 |
|---|---|
| 现状（默认） | ✅ 维持一个 arm64 DMG + `minimumSystemVersion: "12.0"`，覆盖 macOS 12→27 全部 Apple Silicon 用户 |
| 若未来要支持 Intel Mac | 按 Apple 推荐出 **Universal 单包**（`arch: [arm64, x64]`）或按架构补 x64 DMG——按架构拆，不按系统版本拆 |
| 想利用 targeted bundle 优化 | ❌ 不建议。Electron 场景收益趋近于零，且会失去 macOS 15 用户 |
| 收紧最低版本（可选，低优先） | 若确认用户全在 macOS 15+ 可把 `minimumSystemVersion` 从 12.0 提到 15.0，但 Electron 内部兼容层不变、收益微小，不建议为此改动 |

## 7. 证据等级与局限

- **一手（官方文档原文，已抓取核实）**：§3.1 Universal 二进制、§3.2 LSMinimumSystemVersion、§3.3 macOS 26 Release Notes、§3.4 Apple 新闻。
- **公开共识（未定位官方原文）**：§3.5 targeted app bundle 机制、macOS 26 为最后支持 Intel 的版本。
- **局限**：targeted app bundle 的官方文档页未能定位（网络/搜索工具受限）；如需在正式决策中引用，建议先复核 Apple 文档中心。

## 8. 相关链接

- https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary
- https://developer.apple.com/documentation/bundleresources/information-property-list/lsminimumsystemversion
- https://developer.apple.com/documentation/macos-release-notes/macos-26-release-notes
- https://developer.apple.com/news/?id=6lxhtioi
- 项目内参考：`apps/desktop/electron-builder.yml`、`apps/desktop/scripts/release.sh`、`apps/desktop/RELEASING.md`
