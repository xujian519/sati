# 源码安装指南

本文档适合希望直接从源码运行 PilotDeck 的开发者。如果只是想快速体验，建议优先使用一键安装脚本或 Docker。

## 环境要求

PilotDeck 需要：

- Node.js v22.13.0 或更新版本，并且支持内置 `node:sqlite` 运行时。
- Git。
- Git LFS 对源码安装是可选项。只有需要下载大型演示媒体文件时，才需要通过 `git lfs pull` 获取。
- npm 原生依赖（如 `node-pty`、`better-sqlite3`、`bcrypt`、`sharp`）所需的编译工具：Python 3、`make` 和 C/C++ 编译器。
- `ripgrep` (`rg`)，内置文件/搜索工具会用到。

## 安装系统依赖

### 中国大陆网络建议

如果访问 GitHub、npm 或 Node.js 官方下载源较慢，可以先配置国内镜像。下面配置只影响当前用户的 npm 包下载：

```bash
npm config set registry https://registry.npmmirror.com
```

如需恢复 npm 官方源：

```bash
npm config delete registry
```

使用 `fnm` 安装 Node.js 时，可临时指定 Node.js 下载镜像：

```bash
FNM_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node fnm install 22
```

Linux 系统包安装较慢时，建议先按发行版文档切换 apt/dnf/pacman 软件源镜像。克隆 GitHub 仓库或下载 Git LFS 文件较慢、出现 `fetch-pack: unexpected disconnect` 等网络错误时，请重试或优先使用稳定的网络代理。下面的源码安装流程默认跳过 Git LFS 管理的大型演示媒体文件。

### macOS

源码安装推荐准备 Xcode Command Line Tools。如果本机还没有原生编译工具，或 `npm install` 在编译原生依赖时报错，请安装：

```bash
xcode-select --install
```

如果使用 Homebrew，可安装 Git LFS、ripgrep 和 Node.js：

```bash
brew install git-lfs ripgrep node
```

确认 Node.js 版本足够新：

```bash
node --version
```

如果 Homebrew 安装的 Node.js 低于 v22.13.0，请使用你偏好的 Node 版本管理器安装更新版本。

### Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y git git-lfs ripgrep build-essential python3
```

安装 Node.js v22.13.0 或更新版本。常见方式之一是使用 `fnm`：

```bash
curl -fsSL https://fnm.vercel.app/install | bash
# 重启 shell 后执行：
FNM_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node fnm install 22
fnm use 22
node --version
```

### Fedora / RHEL

```bash
sudo dnf install -y git git-lfs ripgrep gcc gcc-c++ make python3
```

然后通过你偏好的软件源或 Node 版本管理器安装 Node.js v22.13.0 或更新版本。

### Arch Linux

```bash
sudo pacman -Sy --needed git git-lfs ripgrep base-devel python nodejs npm
```

确认 `node --version` 显示 v22.13.0 或更新版本。

### Windows

Windows 源码安装推荐使用 WSL2，并在 WSL 中安装 Ubuntu 等 Linux 发行版。进入 WSL 后，按上面的 Debian / Ubuntu 步骤安装依赖：

```powershell
wsl --install -d Ubuntu
```

WSL 启动后，在 WSL 终端中执行 Debian / Ubuntu 小节里的 Linux 依赖安装命令。不建议直接在 PowerShell 或 Git Bash 中走源码安装路径，因为终端能力、原生 npm 模块以及浏览器/工具集成主要在 macOS、Linux 和 WSL 环境中验证。

## 克隆仓库

克隆源码，默认不下载 Git LFS 管理的大型演示媒体文件：

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck
```

如果之后需要演示视频/GIF，可在克隆后下载：

```bash
git lfs pull
```

## 安装 Node 依赖

```bash
node --version          # 必须为 v22.13.0 或更新版本
npm install              # 安装根目录依赖 (Gateway 运行时)
cd ui && npm install     # 安装 UI 依赖
cd ..
```

## 首次 Onboarding

PilotDeck 读取 `~/.pilotdeck/pilotdeck.yaml`。如果本机还没有配置文件，生产模式启动前请先准备 Web UI 的首次 onboarding 流程：

```bash
node scripts/bootstrap-pilotdeck-config.mjs
```

该命令会初始化 `~/.pilotdeck/pilotdeck.yaml`，让 Gateway 可以启动并进入首次 onboarding。随后打开 Web UI，在 onboarding/设置面板中完成 Provider 和 API Key 配置。

## 启动 PilotDeck

开发模式，支持 HMR：

```bash
cd ui
npm run dev
```

打开 <http://localhost:5173>。

生产模式：

```bash
cd ui
npm run start
```

打开 <http://localhost:3001>。

## 常见问题

- 出现 `Node.js >=22.13.0 is required`：切换到更新版本 Node.js，并重新安装依赖。
- 原生 npm 包编译失败：确认已安装 Python 3、`make` 和 C/C++ 编译器，然后重新运行 `npm install`。
- 缺少演示图片/视频：安装 Git LFS 后，在仓库根目录运行 `git lfs pull`。
- 提示找不到 `rg`：安装 ripgrep 以启用完整的文件/搜索工具能力。
