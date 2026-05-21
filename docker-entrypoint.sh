#!/usr/bin/env bash
set -euo pipefail

PILOT_HOME="${PILOT_HOME:-/root/.pilotdeck}"
CONFIG_FILE="$PILOT_HOME/pilotdeck.yaml"

mkdir -p "$PILOT_HOME/projects" "$PILOT_HOME/router"

# ── Generate config from env vars if no config file is mounted ────────
if [ ! -f "$CONFIG_FILE" ]; then
  MODEL="${PILOTDECK_MODEL:-anthropic/claude-sonnet-4.6}"
  API_KEY="${PILOTDECK_API_KEY:-PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE}"
  API_URL="${PILOTDECK_API_URL:-https://api.anthropic.com}"

  # Derive provider name from model string (e.g. "openai/gpt-4.1" -> "openai")
  PROVIDER="${MODEL%%/*}"

  cat > "$CONFIG_FILE" <<YAML
schemaVersion: 1
agent:
  model: ${MODEL}
model:
  providers:
    ${PROVIDER}:
      protocol: ${PROVIDER}
      url: ${API_URL}
      apiKey: ${API_KEY}
      models:
        ${MODEL#*/}: {}
YAML

  echo "[pilotdeck-docker] Generated config at $CONFIG_FILE (provider=$PROVIDER, model=$MODEL)"
fi

# ── Forward proxy env vars ────────────────────────────────────────────
if [ -n "${PILOTDECK_PROXY:-}" ]; then
  export http_proxy="$PILOTDECK_PROXY"
  export https_proxy="$PILOTDECK_PROXY"
  export HTTP_PROXY="$PILOTDECK_PROXY"
  export HTTPS_PROXY="$PILOTDECK_PROXY"
  echo "[pilotdeck-docker] Proxy set to $PILOTDECK_PROXY"
fi

echo "[pilotdeck-docker] Starting PilotDeck (gateway + UI server)..."
echo "[pilotdeck-docker] Config: $CONFIG_FILE"
echo "[pilotdeck-docker] UI will be available at http://0.0.0.0:${SERVER_PORT:-3001}"

# ── Start gateway + UI server via concurrently ────────────────────────
cd /app

exec npx concurrently --kill-others --names gateway,server \
  "node dist/src/cli/pilotdeck.js server" \
  "node --import tsx ui/server/index.js"
