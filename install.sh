#!/usr/bin/env bash
set -euo pipefail

# PilotDeck one-line installer for macOS.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Gucc111/PilotDeck/feat/onboarding-and-installer/install.sh | bash

REPO_URL="${PILOTDECK_REPO_URL:-https://github.com/Gucc111/PilotDeck.git}"
BRANCH="${PILOTDECK_BRANCH:-feat/onboarding-and-installer}"
INSTALL_DIR="${PILOTDECK_INSTALL_DIR:-$HOME/.pilotdeck/app}"
CONFIG_FILE="${PILOTDECK_CONFIG_PATH:-$HOME/.pilotdeck/pilotdeck.yaml}"
BIN_LINK="${PILOTDECK_BIN_LINK:-/usr/local/bin/pilotdeck}"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

ok() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}→${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; exit 1; }

echo ""
echo -e "${BOLD}PilotDeck Installer${RESET}"
echo "====================="
echo ""

echo "Checking system requirements..."
if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This installer currently supports macOS only."
fi
ok "macOS detected"
echo ""

echo "Checking Node.js..."
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)"
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    ok "Node.js ${NODE_VERSION} found"
  else
    warn "Node.js ${NODE_VERSION} is too old (need >=18). Installing Node.js 22..."
    if command -v fnm >/dev/null 2>&1; then
      fnm install 22
      fnm use 22
    elif command -v nvm >/dev/null 2>&1; then
      nvm install 22
      nvm use 22
    else
      warn "Installing fnm (Fast Node Manager)..."
      curl -fsSL https://fnm.vercel.app/install | bash
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$(fnm env)"
      fnm install 22
      fnm use 22
    fi
    ok "Node.js $(node --version) installed"
  fi
else
  warn "Node.js not found. Installing via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
  fnm install 22
  fnm use 22
  ok "Node.js $(node --version) installed"
fi
echo ""

echo "Checking git..."
if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed. Please install Xcode Command Line Tools: xcode-select --install"
fi
ok "git found"
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
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
  ok "Repository cloned"
fi
echo ""

echo "Installing root dependencies & building gateway..."
cd "$INSTALL_DIR"
HUSKY=0 npm install --no-audit --no-fund --loglevel=error
ok "Root dependencies installed"
npm run build
ok "Gateway built"
npm prune --omit=dev --no-audit --no-fund --loglevel=error
ok "Root dev dependencies cleaned"
echo ""

echo "Installing UI dependencies & building frontend..."
cd "$INSTALL_DIR/ui"
HUSKY=0 npm install --no-audit --no-fund --loglevel=error
ok "UI dependencies installed"
npm run build
ok "Frontend built"
npm prune --omit=dev --no-audit --no-fund --loglevel=error
ok "UI dev dependencies cleaned"
echo ""

echo "Setting up CLI command..."
CLI_TARGET="$INSTALL_DIR/ui/server/cli.js"
chmod +x "$CLI_TARGET"

if [[ -L "$BIN_LINK" ]]; then
  rm -f "$BIN_LINK" 2>/dev/null || sudo rm -f "$BIN_LINK"
fi

if [[ -w "$(dirname "$BIN_LINK")" ]]; then
  ln -sf "$CLI_TARGET" "$BIN_LINK"
  ok "pilotdeck command linked to ${DIM}${BIN_LINK}${RESET}"
elif sudo -n true 2>/dev/null; then
  sudo ln -sf "$CLI_TARGET" "$BIN_LINK"
  ok "pilotdeck command linked to ${DIM}${BIN_LINK}${RESET}"
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
exec node "$CLI_TARGET"
