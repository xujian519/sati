# Sati Desktop —— 安装指南

## 推荐渠道（按可靠性排序）

| 渠道 | 是否需要修复脚本 | 备注 |
|---|---|---|
| 浏览器（Safari/Chrome） + HTTPS 直链 | 否 | **首选**。浏览器投放的文件 Gatekeeper 信任度高 |
| AirDrop | 否 | 设备间直传，无 sandbox provenance |
| `scp` / `rsync` 命令行传输 | 否 | 命令行进程不带 sandbox identity |
| GitHub Releases / 公司内网 nginx | 否 | 等同于直链 |
| **飞书 / 微信 / QQ / 钉钉 / WhatsApp 文件传输** | **必须** | macOS 14+ 会拒绝执行,见下文根因 |
| 邮件附件 | 视邮件客户端 | Mail.app OK；网页版邮箱通过浏览器下载 OK |

## 标准安装流程

1. 从上表渠道下载 `Sati-<version>-arm64.dmg`
2. 双击 DMG 挂载
3. 把 `Sati.app` 拖到 `Applications`
4. 在 Launchpad / Finder / Dock 双击启动

如果第 4 步**报"无法启动 Sati 应用程序"且窗口一闪消失** → 你大概率是通过沙盒 IM 收到的 DMG，跳到下面"修复"流程。

## 修复流程（DMG 来自飞书等沙盒 IM）

把 `install-sati.sh` 也下载下来（和 DMG 同一渠道发出），跑：

```bash
bash install-sati.sh
```

脚本会：
1. 自动找到已经安装的 `Sati.app`
2. 清掉 macOS 添加的隔离 / provenance 扩展属性（不会动签名 / staple ticket）
3. 验证代码签名 + Apple notarize ticket + Gatekeeper 评估
4. 报告每一步结果，告诉你接下来该做什么

成功跑完后再次双击 Sati 即可正常启动。

如果手边没有脚本，最小修复手动版：

```bash
xattr -cr /Applications/Sati.app
open /Applications/Sati.app
```

## 根因（macOS 14+ Gatekeeper 行为）

macOS Sonoma (14) 引入了一个叫 `com.apple.provenance` 的扩展属性。当任何**沙盒应用**（飞书/微信/QQ/钉钉等）在系统上落盘一个文件,macOS 自动把"投放者 App 的 sandbox identity"写进这个属性。Gatekeeper 对带 provenance 的可执行文件做**额外严格**的执行策略评估,沙盒 IM 类应用的信任级别低于浏览器/AirDrop —— 即使代码签名 + Apple 公证 100% 合法,Gatekeeper 仍会拒绝执行,触发"无法启动 ... 应用程序"对话框,且对话框因为 main process 在 launch 阶段被 kill 而**一闪消失**,看起来像是 App 自己崩溃。

技术细节:
- `codesign --verify` **会报告 valid**,因为签名本身没问题（rejection 发生在执行策略层而非签名层）
- 单独 `xattr -d com.apple.quarantine` **不够**,provenance 是独立属性
- `xattr -cr` 清除所有扩展属性是安全的 —— stapled notarize ticket 实际上存在 `Contents/CodeResources` 这个**文件**里,而非 xattr,不会被误删

## 长期方案路线图

当前（0.0.x，与仓库根 `package.json` 版本 lockstep）:
- ✅ DMG 已 codesign + notarize + staple,通过浏览器/AirDrop 渠道无任何摩擦
- ✅ `install-sati.sh` 兜底,服务通过 IM 渠道收到 DMG 的同事

下一步(规划中):
- 申请 **Developer ID Installer 证书**,改造 `release.sh` 同时产出 `Sati-<version>-arm64.pkg`
- PKG 由 macOS 内置 Installer.app 安装,**绕开** sandboxed-IM provenance 标记
- 用户体验:双击 PKG → 装好 → 直接启动,无任何额外步骤,不论通过什么渠道收到

---

## Windows 安装

Windows 安装包为 NSIS 安装器（`Sati-<version>-win-x64.exe`，arm64 构建见
`apps/desktop/RELEASING.md`）。

### 标准安装流程

1. 下载 `Sati-<version>-win-x64.exe`
2. 双击运行 → 选择安装目录（默认按用户安装，无需管理员权限）
3. 安装完成后从开始菜单 / 桌面快捷方式启动 Sati
4. 首次启动进入初始化窗口，填入模型 API 凭据后进入主界面

### SmartScreen 提示（未签名包）

未签名的安装包（`build-win.bat` 未配置证书时产出）在双击时会弹出
"Windows 已保护你的电脑"：

1. 点击 **更多信息**
2. 点击 **仍要运行**

已签名的官方包不会出现此提示。如不确定来源，可校验文件哈希后再安装：

1. 把 `verify-signature-win.bat` 和安装包放在一起（随包发布）
2. 双击运行，传入安装包路径（或让它自动找 `dist-electron\Sati-*.exe`）
3. 脚本输出 **SHA256**、**Authenticode 签名状态** 与 **签发者**——
   - `Valid` 且签发者是 Sati / 官方 OV/EV 证书 → 放心安装
   - `NotSigned` → 未签名包，按上面"仍要运行"安装
   - `HashMismatch` / `UnknownError` → 文件可能损坏或被篡改，重新下载

macOS 需要 `install-sati.sh` 修复 Gatekeeper/provenance；Windows 没有这个机制，
只需验证签名与哈希，`verify-signature-win.bat` 就是它的对应物。

### 常驻行为

Windows 版关闭主窗口会**最小化到系统托盘**而非退出（本地服务继续常驻）。
要完全退出：右键托盘图标 → **退出**；或从托盘菜单退出。

### 卸载

通过 Windows 设置 → 应用 → 已安装的应用 → Sati → 卸载；或从控制面板
"程序和功能"卸载。
