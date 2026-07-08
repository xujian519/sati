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

Xcode Command Line Tools are recommended for source installs. Install them if you do not already have native build tools, or if `npm install` fails while building native packages:

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

For source installs on Windows, use WSL2 with a Linux distribution such as Ubuntu. Then follow the Debian / Ubuntu instructions inside WSL:

```powershell
wsl --install -d Ubuntu
```

After WSL starts, run the Linux dependency commands from the Debian / Ubuntu section. Native Windows shells such as PowerShell or Git Bash are not the recommended source-install path because terminal, native npm modules, and browser/tool integrations are primarily tested on macOS, Linux, and WSL.

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
- Missing demo images/videos: install Git LFS and run `git lfs pull` from the repo root.
- `rg` not found: install ripgrep for full file/search tool support.
