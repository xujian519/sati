#!/usr/bin/env bash
set -euo pipefail

# PilotDeck one-line installer for macOS and Linux.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OpenBMB/PilotDeck/main/install.sh | bash

REPO_URL="${PILOTDECK_REPO_URL:-https://github.com/OpenBMB/PilotDeck.git}"
BRANCH="${PILOTDECK_BRANCH:-main}"
INSTALL_DIR="${PILOTDECK_INSTALL_DIR:-$HOME/.pilotdeck/app}"
CONFIG_FILE="${PILOTDECK_CONFIG_PATH:-$HOME/.pilotdeck/pilotdeck.yaml}"
BIN_LINK="${PILOTDECK_BIN_LINK:-/usr/local/bin/pilotdeck}"
MAX_PORT_TRIES="${PILOTDECK_MAX_PORT_TRIES:-20}"
APT_UPDATED=0

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

ok() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}→${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; exit 1; }

run_as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Need root privileges to install system packages. Please install sudo or run as root."
  fi
}

install_linux_packages() {
  local requested=("$@")
  local apt_packages=()
  local dnf_packages=()
  local pacman_packages=()
  local zypper_packages=()
  local package

  for package in "${requested[@]}"; do
    case "$package" in
      build-tools)
        apt_packages+=(build-essential python3)
        dnf_packages+=(gcc gcc-c++ make python3)
        pacman_packages+=(base-devel python)
        zypper_packages+=(gcc gcc-c++ make python3)
        ;;
      *)
        apt_packages+=("$package")
        dnf_packages+=("$package")
        pacman_packages+=("$package")
        zypper_packages+=("$package")
        ;;
    esac
  done

  if command -v apt-get >/dev/null 2>&1; then
    if [[ "$APT_UPDATED" -eq 0 ]]; then
      run_as_root apt-get update
      APT_UPDATED=1
    fi
    run_as_root apt-get install -y "${apt_packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y "${dnf_packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y "${dnf_packages[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -Sy --needed --noconfirm "${pacman_packages[@]}"
  elif command -v zypper >/dev/null 2>&1; then
    run_as_root zypper --non-interactive install "${zypper_packages[@]}"
  else
    fail "Unsupported Linux package manager. Please install manually: ${requested[*]}"
  fi
}

install_git() {
  if [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages git
  else
    fail "git is not installed. Please install Xcode Command Line Tools: xcode-select --install"
  fi
}

install_ripgrep() {
  if [[ "$PLATFORM" == "macos" ]] && command -v brew >/dev/null 2>&1; then
    brew install ripgrep </dev/null
  elif [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages ripgrep
  else
    fail "ripgrep (rg) is required. On macOS, install Homebrew and run: brew install ripgrep"
  fi
}

install_lsof() {
  if [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages lsof
  else
    fail "lsof is required but missing. Please install Xcode Command Line Tools: xcode-select --install"
  fi
}

has_cxx_compiler() {
  command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1
}

ensure_native_build_tools() {
  if command -v python3 >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && has_cxx_compiler; then
    ok "native build tools found"
    return
  fi

  if [[ "$PLATFORM" == "linux" ]]; then
    warn "native build tools not found. Installing build tools for node-pty/better-sqlite3..."
    install_linux_packages build-tools
    ok "native build tools installed"
  else
    fail "native build tools are missing. Please install Xcode Command Line Tools: xcode-select --install"
  fi
}

is_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ! ss -tlnH "sport = :$port" 2>/dev/null | grep -q .
  else
    ! (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null
  fi
}

find_free_port() {
  local base="$1"
  local offset candidate
  for ((offset = 0; offset < MAX_PORT_TRIES; offset++)); do
    candidate=$((base + offset))
    if is_port_free "$candidate"; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_runtime_ports() {
  local server_base="${SERVER_PORT:-3001}"
  local gateway_base="${PILOTDECK_GATEWAY_PORT:-18789}"

  SERVER_PORT="$(find_free_port "$server_base")" || \
    fail "Could not find a free UI port within ${MAX_PORT_TRIES} ports from ${server_base}."
  PILOTDECK_GATEWAY_PORT="$(find_free_port "$gateway_base")" || \
    fail "Could not find a free gateway port within ${MAX_PORT_TRIES} ports from ${gateway_base}."
  PILOTDECK_GATEWAY_URL="ws://127.0.0.1:${PILOTDECK_GATEWAY_PORT}/ws"

  export SERVER_PORT PILOTDECK_GATEWAY_PORT PILOTDECK_GATEWAY_URL

  if [[ "$SERVER_PORT" != "$server_base" ]]; then
    warn "UI port ${server_base} is busy; using ${SERVER_PORT} instead."
  fi
  if [[ "$PILOTDECK_GATEWAY_PORT" != "$gateway_base" ]]; then
    warn "Gateway port ${gateway_base} is busy; using ${PILOTDECK_GATEWAY_PORT} instead."
  fi
}

github_repo_slug() {
  case "$REPO_URL" in
    https://github.com/*.git)
      local slug="${REPO_URL#https://github.com/}"
      printf "%s" "${slug%.git}"
      ;;
    git@github.com:*.git)
      local slug="${REPO_URL#git@github.com:}"
      printf "%s" "${slug%.git}"
      ;;
    *)
      return 1
      ;;
  esac
}

clone_repo() {
  local slug
  if slug="$(github_repo_slug)" && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "$slug" "$INSTALL_DIR" -- --branch "$BRANCH" --depth 1 --quiet
  else
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
  fi
}

echo ""
echo -e "${BOLD}PilotDeck Installer${RESET}"
echo "====================="
echo ""

echo "Checking system requirements..."
case "$(uname -s)" in
  Darwin)
    PLATFORM="macos"
    ok "macOS detected"
    ;;
  Linux)
    PLATFORM="linux"
    ok "Linux detected"
    ;;
  *)
    fail "Unsupported OS: $(uname -s). This installer supports macOS and Linux."
    ;;
esac
echo ""

echo "Checking Node.js..."
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    ok "Node.js ${NODE_VERSION} found"
  else
    warn "Node.js ${NODE_VERSION} is too old (need >=22). Installing Node.js 22..."
    if command -v fnm >/dev/null 2>&1; then
      fnm install 22
      fnm use 22
    elif command -v nvm >/dev/null 2>&1; then
      nvm install 22 </dev/null
      nvm use 22
    else
      warn "Installing fnm (Fast Node Manager)..."
      curl -fsSL https://fnm.vercel.app/install | bash
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$(fnm env)"
      fnm install 22 </dev/null
      fnm use 22
    fi
    ok "Node.js $(node --version) installed"
  fi
else
  warn "Node.js not found. Installing via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
  fnm install 22 </dev/null
  fnm use 22
  ok "Node.js $(node --version) installed"
fi
echo ""

echo "Checking git..."
if ! command -v git >/dev/null 2>&1; then
  warn "git not found. Installing..."
  install_git
fi
ok "git found"
echo ""

echo "Checking ripgrep..."
if command -v rg >/dev/null 2>&1; then
  ok "ripgrep $(rg --version | head -1) found"
else
  warn "ripgrep not found. Installing..."
  install_ripgrep
  ok "ripgrep installed"
fi
echo ""

echo "Checking lsof..."
if ! command -v lsof >/dev/null 2>&1; then
  warn "lsof not found. Installing..."
  install_lsof
fi
ok "lsof found"
echo ""

echo "Checking native build tools..."
ensure_native_build_tools
echo ""

echo "Installing PilotDeck to ${DIM}${INSTALL_DIR}${RESET} ..."
mkdir -p "$(dirname "$INSTALL_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "Existing installation found. Updating..."
  cd "$INSTALL_DIR"
  git fetch origin "$BRANCH" --quiet
  git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" --quiet
  git pull --ff-only origin "$BRANCH" --quiet
  ok "Updated to latest ${BRANCH}"
else
  if [[ -d "$INSTALL_DIR" ]]; then
    warn "Cleaning incomplete installation at $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi
  clone_repo
  ok "Repository cloned"
fi
echo ""

echo "Installing root dependencies..."
cd "$INSTALL_DIR"
HUSKY=0 npm install --no-audit --no-fund --loglevel=error </dev/null
ok "Root dependencies installed"
warn "Keeping root dev dependencies because runtime uses tsx from source."
echo ""

echo "Installing UI dependencies & building frontend..."
cd "$INSTALL_DIR/ui"
HUSKY=0 npm install --no-audit --no-fund --loglevel=error </dev/null
ok "UI dependencies installed"
npm run build
ok "Frontend built"
warn "Keeping UI dev dependencies because production start uses concurrently/vite build tooling."
echo ""

echo "Installing Playwright browser for browser-use plugin..."
cd "$INSTALL_DIR"
npx @playwright/mcp install-browser chrome-for-testing </dev/null 2>/dev/null && \
  ok "Chrome for Testing installed" || \
  warn "Chrome for Testing install failed (browser-use plugin may not work)"
echo ""

echo "Installing ClawHub CLI..."
if command -v clawhub >/dev/null 2>&1; then
  ok "ClawHub CLI already installed ($(clawhub --version 2>/dev/null || echo 'unknown version'))"
else
  npm install -g clawhub --loglevel=error </dev/null && \
    ok "ClawHub CLI installed" || \
    warn "ClawHub CLI install failed (skill marketplace features may not work)"
fi
echo ""

echo "Setting up CLI command..."
WRAPPER_DIR="$INSTALL_DIR/bin"
CLI_TARGET="$WRAPPER_DIR/pilotdeck"
mkdir -p "$WRAPPER_DIR"
cat > "$CLI_TARGET" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${PILOTDECK_CONFIG_PATH:-$HOME/.pilotdeck/pilotdeck.yaml}"
MAX_PORT_TRIES="${PILOTDECK_MAX_PORT_TRIES:-20}"

fail() { printf "pilotdeck: %s\n" "$1" >&2; exit 1; }
warn() { printf "pilotdeck: %s\n" "$1" >&2; }

is_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ! ss -tlnH "sport = :$port" 2>/dev/null | grep -q .
  else
    ! (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null
  fi
}

find_free_port() {
  local base="$1"
  local offset candidate
  for ((offset = 0; offset < MAX_PORT_TRIES; offset++)); do
    candidate=$((base + offset))
    if is_port_free "$candidate"; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

COMMAND="start"
while [[ $# -gt 0 ]]; do
  case "$1" in
    start)
      COMMAND="start"
      shift
      ;;
    status|info)
      COMMAND="status"
      shift
      ;;
    help|-h|--help)
      COMMAND="help"
      shift
      ;;
    --port|-p)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      SERVER_PORT="$2"
      shift 2
      ;;
    --port=*)
      SERVER_PORT="${1#--port=}"
      shift
      ;;
    --config)
      [[ $# -ge 2 ]] || fail "--config requires a value"
      CONFIG_FILE="$2"
      shift 2
      ;;
    --config=*)
      CONFIG_FILE="${1#--config=}"
      shift
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ "$COMMAND" == "help" ]]; then
  cat <<HELP
pilotdeck - start the PilotDeck web UI

Usage:
  pilotdeck [start] [--port <port>] [--config <path>]
  pilotdeck status
  pilotdeck help

HELP
  exit 0
fi

if [[ "$COMMAND" == "status" ]]; then
  printf "Installation: %s\n" "$INSTALL_DIR"
  printf "Config:       %s\n" "$CONFIG_FILE"
  printf "URL:          http://localhost:%s\n" "${SERVER_PORT:-3001}"
  exit 0
fi

SERVER_BASE="${SERVER_PORT:-3001}"
GATEWAY_BASE="${PILOTDECK_GATEWAY_PORT:-18789}"
SERVER_PORT="$(find_free_port "$SERVER_BASE")" || fail "could not find a free UI port from ${SERVER_BASE}"
PILOTDECK_GATEWAY_PORT="$(find_free_port "$GATEWAY_BASE")" || fail "could not find a free gateway port from ${GATEWAY_BASE}"
PILOTDECK_GATEWAY_URL="ws://127.0.0.1:${PILOTDECK_GATEWAY_PORT}/ws"

export PILOTDECK_CONFIG_PATH="$CONFIG_FILE"
export SERVER_PORT PILOTDECK_GATEWAY_PORT PILOTDECK_GATEWAY_URL

if [[ "$SERVER_PORT" != "$SERVER_BASE" ]]; then
  warn "UI port ${SERVER_BASE} is busy; using ${SERVER_PORT} instead."
fi
if [[ "$PILOTDECK_GATEWAY_PORT" != "$GATEWAY_BASE" ]]; then
  warn "Gateway port ${GATEWAY_BASE} is busy; using ${PILOTDECK_GATEWAY_PORT} instead."
fi

node "$INSTALL_DIR/scripts/bootstrap-pilotdeck-config.mjs"

printf "pilotdeck: starting at http://localhost:%s\n" "$SERVER_PORT"
cd "$INSTALL_DIR/ui"
exec npm run start
EOF
chmod +x "$CLI_TARGET"
TARGET_BIN="$BIN_LINK"

if [[ -e "$BIN_LINK" || -L "$BIN_LINK" ]]; then
  if rm -f "$BIN_LINK" 2>/dev/null; then
    :
  elif sudo -n rm -f "$BIN_LINK" 2>/dev/null; then
    :
  else
    warn "Cannot update ${BIN_LINK} without sudo; falling back to user-local bin."
    TARGET_BIN="$HOME/.local/bin/pilotdeck"
  fi
fi

if [[ "$TARGET_BIN" == "$BIN_LINK" && -w "$(dirname "$BIN_LINK")" ]]; then
  ln -sf "$CLI_TARGET" "$TARGET_BIN"
  ok "pilotdeck command linked to ${DIM}${TARGET_BIN}${RESET}"
elif sudo -n true 2>/dev/null; then
  sudo ln -sf "$CLI_TARGET" "$TARGET_BIN"
  ok "pilotdeck command linked to ${DIM}${TARGET_BIN}${RESET}"
else
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  ln -sf "$CLI_TARGET" "$LOCAL_BIN/pilotdeck"
  ok "pilotdeck command linked to ${DIM}${LOCAL_BIN}/pilotdeck${RESET}"
  if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
    warn "Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi
echo ""

echo -e "${BOLD}Installation complete!${RESET}"
echo ""
echo -e "  App location:   ${DIM}${INSTALL_DIR}${RESET}"
echo -e "  Config file:    ${DIM}${CONFIG_FILE}${RESET}"
echo -e "  CLI command:    ${DIM}pilotdeck${RESET}"
echo ""

echo "Starting PilotDeck..."
echo ""
export PILOTDECK_CONFIG_PATH="$CONFIG_FILE"
resolve_runtime_ports
node "$INSTALL_DIR/scripts/bootstrap-pilotdeck-config.mjs"
echo -e "  UI:             ${DIM}http://localhost:${SERVER_PORT}${RESET}"
echo -e "  Gateway:        ${DIM}${PILOTDECK_GATEWAY_URL}${RESET}"
echo ""
cd "$INSTALL_DIR/ui"
exec npm run start
