# Source Installation Guide

This guide is for developers who want to run PilotDeck directly from source instead of using the one-line installer or Docker.

## Prerequisites

PilotDeck requires:

- Node.js v22.13.0 or newer, with the built-in `node:sqlite` runtime.
- Git.
- Git LFS is optional for source installs. It is only needed if you want to download large demo media assets with `git lfs pull`.
- Native build tools for npm packages such as `node-pty`, `better-sqlite3`, `bcrypt`, and `sharp`: Python 3, `make`, and a C/C++ compiler.
- `ripgrep` (`rg`) for built-in file/search tools.

## Install System Dependencies

### macOS

Xcode Command Line Tools are required if native npm packages fall back to source builds. Install them if you do not already have a complete CLT/Xcode setup, or if `npm install` fails while building native packages:

```bash
xcode-select --install
```

If you use Homebrew, install Git LFS, ripgrep, and Node.js:

```bash
brew install git-lfs ripgrep node
```

Make sure Node.js is new enough:

```bash
node --version
```

If your Homebrew Node.js is older than v22.13.0, install a newer Node.js with your preferred Node version manager.

Some Python distributions, especially Python 3.12 installed through package managers, may not include `distutils`, which older `node-gyp` versions still need when native packages compile from source. If you see `ModuleNotFoundError: No module named 'distutils'`, use a Python that provides it, for example:

```bash
PYTHON=/usr/bin/python3 npm install
```

If `xcodebuild` or Command Line Tools receipts are broken, reinstall Xcode Command Line Tools or run `sudo xcode-select --reset` before retrying.

If cloning from GitHub or downloading Git LFS files is slow or fails with network errors such as `fetch-pack: unexpected disconnect`, retry or use a stable network proxy. The source install flow below skips large Git LFS demo media by default.

### Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y git git-lfs ripgrep build-essential python3
```

Install Node.js v22.13.0 or newer. One common option is `fnm`:

```bash
curl -fsSL https://fnm.vercel.app/install | bash
# Restart your shell, then:
fnm install 22
fnm use 22
node --version
```

### Fedora / RHEL

```bash
sudo dnf install -y git git-lfs ripgrep gcc gcc-c++ make python3
```

Then install Node.js v22.13.0 or newer using your preferred package source or Node version manager.

### Arch Linux

```bash
sudo pacman -Sy --needed git git-lfs ripgrep base-devel python nodejs npm
```

Make sure `node --version` reports v22.13.0 or newer.

### Windows

Windows supports several source-deployment paths. You do **not** need to install every tool for every path.

| Path | Install on Windows | Best for |
|---|---|---|
| WSL2 Ubuntu | WSL2, Ubuntu, then Linux build tools inside Ubuntu | Source deployment and development |
| Docker Desktop | Docker Desktop with WSL2 backend, Git for Windows | Running PilotDeck without local Node/native build setup |
| Native Windows | Node.js, Git LFS, Python, Visual Studio C++ Build Tools, ripgrep | PowerShell-only development |
| Portable Node | Official Node.js zip, Git for Windows, Git LFS, ripgrep | Verifying deployment without changing system Node settings |

Quick prerequisite check in PowerShell:

```powershell
node --version
npm --version
git --version
git lfs version
python --version
rg --version
docker --version
docker compose version
wsl --status
```

Missing commands mean the corresponding tool still needs to be installed or added to `PATH`. After installing tools, close and reopen PowerShell before checking again.

#### WSL2 Ubuntu (recommended)

Install WSL2 and Ubuntu from an elevated PowerShell window:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted, finish Ubuntu first-run setup, then follow the Debian / Ubuntu instructions inside the Ubuntu shell.

#### Docker Desktop

Install Docker Desktop and enable the WSL2 backend:

```powershell
winget install Docker.DockerDesktop
```

Start Docker Desktop once after installation, wait until the engine is running, then verify:

```powershell
docker --version
docker compose version
```

Use the Docker instructions in `README_DOCKER.md` if you choose this path.

#### Native Windows PowerShell

Native Windows is useful if you want to develop directly from PowerShell. It is more sensitive to native npm dependency compilation than WSL2.

Install prerequisites with `winget`:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.GitLFS
winget install Python.Python.3.12
winget install BurntSushi.ripgrep.MSVC
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Then open a new PowerShell window and run:

```powershell
git lfs install
node --version   # must be v22.13.0 or newer
npm --version
python --version
rg --version
```

Use separate PowerShell lines instead of Bash-style chained commands when following the clone/install/start steps below. If PowerShell blocks `npm.ps1`, call `npm.cmd` instead of `npm`.

#### Portable Node for verification

If you want to test PilotDeck before installing Node.js globally, use the official Windows Node.js zip for the current terminal session only:

```powershell
$NodeVersion = '22.23.1'
$WorkDir = Join-Path $PWD '.pilotdeck-node'
$ZipPath = Join-Path $WorkDir "node-v$NodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Invoke-WebRequest -Uri $NodeUrl -OutFile $ZipPath

$ExtractDir = Join-Path $WorkDir 'node'
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
tar -xf $ZipPath -C $ExtractDir
$NodeDir = Join-Path $ExtractDir "node-v$NodeVersion-win-x64"
$env:PATH = "$NodeDir;$env:PATH"

node --version
npm.cmd --version
```

With portable Node, use `npm.cmd install`, `npm.cmd run build`, and `npm.cmd --prefix ui run build`.

## Clone the Repository

Clone the source code without downloading large Git LFS demo media:

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck
```

If you need the demo videos/GIFs later, download them after cloning:

```bash
git lfs pull
```

## Install Node Dependencies

```bash
node --version          # must be v22.13.0 or newer
npm install              # root deps (Gateway runtime)
cd ui && npm install     # UI deps
cd ..
```

## First-Run Onboarding

PilotDeck reads `~/.pilotdeck/pilotdeck.yaml`. If you do not already have a config file, prepare the Web UI onboarding flow before starting in production mode:

```bash
node scripts/bootstrap-pilotdeck-config.mjs
```

This initializes `~/.pilotdeck/pilotdeck.yaml` for first-run onboarding so the Gateway can boot. Then open the Web UI and finish provider/API key setup in the onboarding/settings panel.

## Start PilotDeck

Development mode with HMR:

```bash
cd ui
npm run dev
```

Open <http://localhost:5173>.

Production mode:

```bash
cd ui
npm run start
```

Open <http://localhost:3001>.

## Troubleshooting

- `Node.js >=22.13.0 is required`: switch to a newer Node.js and reinstall dependencies.
- Native npm package build errors: make sure Python 3, `make`, and a C/C++ compiler are installed, then rerun `npm install`.
- `ModuleNotFoundError: No module named 'distutils'` on macOS: retry with `PYTHON=/usr/bin/python3 npm install`, or use another Python that includes `distutils`.
- `xcodebuild` or Command Line Tools receipt errors on macOS: reinstall Xcode Command Line Tools with `xcode-select --install`, or run `sudo xcode-select --reset` if CLT is already installed.
- Missing demo images/videos: install Git LFS and run `git lfs pull` from the repo root.
- `rg` not found: install ripgrep for full file/search tool support.
