#!/usr/bin/env bash
# Shared helpers: extract Sati.app runtime bundles and start Gateway + UI
# in an isolated sandbox. Sourced by release-l2.sh / release-l3.sh (not executed).

pd_runtime__fail() { echo "packaged-runtime: $*" >&2; exit 1; }

# Mount DMG; sets PD_MOUNT_DIR and PD_APP. Caller must trap pd_runtime_unmount_dmg.
pd_runtime_mount_dmg() {
  local dmg="$1"
  [[ -f "$dmg" ]] || pd_runtime__fail "DMG not found: $dmg"
  local mount_out
  mount_out="$(hdiutil attach "$dmg" -nobrowse -noautoopen -readonly 2>&1)" \
    || pd_runtime__fail "hdiutil attach failed: $mount_out"
  PD_MOUNT_DIR="$(echo "$mount_out" | awk '/\/Volumes\//{for(i=1;i<=NF;i++) if($i~/^\/Volumes\//){p=$i; for(j=i+1;j<=NF;j++) p=p" "$j; print p; exit}}')"
  [[ -d "$PD_MOUNT_DIR" ]] || pd_runtime__fail "Cannot determine mount point"
  PD_APP="$PD_MOUNT_DIR/Sati.app"
  [[ -d "$PD_APP" ]] || pd_runtime__fail "Sati.app missing in DMG"
}

pd_runtime_unmount_dmg() {
  [[ -n "${PD_MOUNT_DIR:-}" ]] && hdiutil detach "$PD_MOUNT_DIR" >/dev/null 2>&1 || true
}

# Resolve PD_APP from a .app path or mounted DMG app.
pd_runtime_resolve_app() {
  local target="$1"
  if [[ -d "$target" && "$target" == *.app ]]; then
    PD_APP="$target"
    return 0
  fi
  if [[ -f "$target" && "$target" == *.dmg ]]; then
    pd_runtime_mount_dmg "$target"
    return 0
  fi
  pd_runtime__fail "Expected .app directory or .dmg file: $target"
}

# Extract tarballs from PD_APP into SANDBOX; set CCUI_DIR, CCM_DIR, MEM_DIR, RES.
pd_runtime_extract_bundles() {
  [[ -d "${PD_APP:-}" ]] || pd_runtime__fail "PD_APP not set"
  RES="$PD_APP/Contents/Resources"
  SANDBOX="$(mktemp -d -t sati-runtime.XXXXXX)"
  export SANDBOX RES CCUI_DIR CCM_DIR MEM_DIR

  CCUI_DIR="$SANDBOX/satiui"
  mkdir -p "$CCUI_DIR"
  tar xf "$RES/satiui-bundle.tar" -C "$CCUI_DIR" \
    || pd_runtime__fail "satiui-bundle.tar extract failed"

  CCM_DIR="$SANDBOX/sati-main"
  mkdir -p "$CCM_DIR"
  tar xf "$RES/sati-main-bundle.tar" -C "$CCM_DIR" \
    || pd_runtime__fail "sati-main-bundle.tar extract failed"

  MEM_DIR="$SANDBOX/sati-memory-core"
  mkdir -p "$MEM_DIR"
  tar xf "$RES/sati-memory-core-bundle.tar" -C "$MEM_DIR" \
    || pd_runtime__fail "sati-memory-core-bundle.tar extract failed"

  [[ -f "$CCUI_DIR/server/index.js" ]] || pd_runtime__fail "missing server/index.js"
  [[ -f "$CCM_DIR/dist/src/cli/sati.js" ]] || pd_runtime__fail "missing sati.js"
  [[ -f "$MEM_DIR/lib/index.js" ]] || pd_runtime__fail "missing memory-core lib"

  if [[ -d "$CCM_DIR/dist" ]]; then
    ln -sfn "$CCM_DIR/dist" "$SANDBOX/dist"
    ln -sfn "$CCM_DIR/dist/src" "$SANDBOX/src"
  fi
  if [[ -d "$MEM_DIR" ]]; then
    ln -sfn "$MEM_DIR" "$SANDBOX/edgeclaw-memory-core"
    mkdir -p "$CCM_DIR/node_modules"
    ln -sfn "$MEM_DIR" "$CCM_DIR/node_modules/edgeclaw-memory-core"
    # UI server routes/memory.js imports via relative path that resolves to
    # $SANDBOX/src/context/memory/edgeclaw-memory-core/lib/index.js.
    # Since $SANDBOX/src is a symlink to sati-main/dist/src, which may
    # contain a stub dir from tsc output, remove it before symlinking.
    mkdir -p "$SANDBOX/src/context/memory"
    local _ecmc="$SANDBOX/src/context/memory/edgeclaw-memory-core"
    if [[ -d "$_ecmc" && ! -L "$_ecmc" ]]; then rm -rf "$_ecmc"; fi
    ln -sfn "$MEM_DIR" "$_ecmc"
  fi
  if [[ ! -e "$SANDBOX/node_modules" ]]; then
    ln -sfn "$CCM_DIR/node_modules" "$SANDBOX/node_modules"
  fi
}

pd_runtime_write_v2_stub_config() {
  local pilot_home="${1:-$SANDBOX/home/.sati}"
  mkdir -p "$pilot_home"
  cat > "$pilot_home/sati.yaml" <<'EOF'
schemaVersion: 1
agent:
  model: sati/claude-sonnet-4-5-20250929
model:
  providers:
    sati:
      protocol: anthropic
      url: https://api.anthropic.com
      apiKey: smoke-test-not-real
      models:
        claude-sonnet-4-5-20250929: {}
EOF
  export SATI_HOME="$pilot_home"
}

pd_runtime_free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});' 2>/dev/null || echo 28790
}

# Start Gateway (19789) + UI server. Sets PD_UI_PORT, PD_UI_URL, PD_GW_PID, PD_SRV_PID.
pd_runtime_start_dual_stack() {
  local ui_port="${1:-$(pd_runtime_free_port)}"
  local gw_port="${2:-19789}"
  export PD_UI_PORT="$ui_port" PD_GATEWAY_PORT="$gw_port"
  export PD_UI_URL="http://127.0.0.1:${ui_port}"

  pd_runtime_write_v2_stub_config "${SATI_HOME:-$SANDBOX/home/.sati}"

  local gw_listener
  gw_listener="$(/usr/sbin/lsof -nP -t -iTCP:"$gw_port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [[ -n "$gw_listener" ]]; then
    # 只杀 Sati gateway 自身：端口可能被用户的无关进程占用，先校验命令行
    if ps -p "$gw_listener" -o command= 2>/dev/null | grep -q 'dist/src/cli/sati'; then
      kill "$gw_listener" 2>/dev/null || true
      sleep 1
    fi
  fi

  local gw_entry="$CCM_DIR/dist/src/cli/sati.js"
  SRV_LOG="$SANDBOX/server.log"
  GW_LOG="$SANDBOX/gateway.log"

  (
    cd "$CCM_DIR"
    HOME="$SANDBOX/home" \
    SATI_HOME="$SATI_HOME" \
    SATI_GATEWAY_PORT="$gw_port" \
    BUN_BIN="$RES/bun-bin/bun" \
    NO_COLOR=1 FORCE_COLOR=0 \
    "$RES/node-bin/node" "$gw_entry" server >"$GW_LOG" 2>&1 &
    echo $!
  ) >"$SANDBOX/gw.pid"
  PD_GW_PID="$(cat "$SANDBOX/gw.pid")"

  local gw_ok=0 i
  for i in $(seq 1 90); do
    if curl -s -m 1 "http://127.0.0.1:${gw_port}/health" 2>/dev/null | grep -q '"ok":true'; then
      gw_ok=1
      break
    fi
    sleep 0.5
    kill -0 "$PD_GW_PID" 2>/dev/null || break
  done
  [[ "$gw_ok" == "1" ]] || pd_runtime__fail "Gateway did not become healthy (see $GW_LOG)"

  local token_ok=0
  for i in $(seq 1 20); do
    [[ -f "$SATI_HOME/server-token" ]] && token_ok=1 && break
    sleep 0.5
  done
  [[ "$token_ok" == "1" ]] || pd_runtime__fail "Gateway did not write server-token"

  (
    cd "$CCUI_DIR"
    HOME="$SANDBOX/home" \
    SATI_HOME="$SATI_HOME" \
    SERVER_PORT="$ui_port" \
    SATI_MAIN_DIR="$CCM_DIR" \
    BUN_BIN="$RES/bun-bin/bun" \
    NO_COLOR=1 FORCE_COLOR=0 \
    "$RES/node-bin/node" server/index.js >"$SRV_LOG" 2>&1 &
    echo $!
  ) >"$SANDBOX/srv.pid"
  PD_SRV_PID="$(cat "$SANDBOX/srv.pid")"

  local srv_ok=0
  for i in $(seq 1 60); do
    if curl -s -m 1 "${PD_UI_URL}/health" 2>/dev/null | grep -q '"status":"ok"'; then
      srv_ok=1
      break
    fi
    sleep 0.5
    kill -0 "$PD_SRV_PID" 2>/dev/null || break
  done
  [[ "$srv_ok" == "1" ]] || pd_runtime__fail "UI server did not become healthy (see $SRV_LOG)"

  curl -s -m 5 "${PD_UI_URL}/api/projects" >/dev/null 2>&1 || true
  local bridge_ok=0
  for i in $(seq 1 90); do
    if grep -q '\[sati-bridge\] connected' "$SRV_LOG" 2>/dev/null; then
      bridge_ok=1
      break
    fi
    grep -q 'gateway connect failed after' "$SRV_LOG" 2>/dev/null && break
    sleep 0.5
  done
  [[ "$bridge_ok" == "1" ]] || pd_runtime__fail "sati-bridge did not connect (see $SRV_LOG)"
}

pd_runtime_stop_dual_stack() {
  for pid_var in PD_SRV_PID PD_GW_PID; do
    local pid="${!pid_var:-}"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

pd_runtime_teardown_sandbox() {
  pd_runtime_stop_dual_stack
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX:-/dev/null}" ]] && rm -rf "$SANDBOX"
}
