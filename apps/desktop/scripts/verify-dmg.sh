#!/usr/bin/env bash
# ============================================================================
# Sati Desktop DMG Verifier (verify-dmg.sh)
# ----------------------------------------------------------------------------
# 校验一个已经构建好的 Sati Desktop DMG 是否真的能用：
#   1. DMG 结构完整、可挂载
#   2. App bundle 结构正确（4 个 Helper、Frameworks、node-bin、bun-bin、bundles）
#   3. 代码签名通过 codesign --verify --deep --strict
#   4. satiui-bundle.tar 解开后存在 server/index.js
#   5. sati-main-bundle.tar 解开后存在 src/cli/sati.ts
#   6. 用打包好的 node spawn UI server + /health (V2 sati.yaml)
#   7. Gateway 进程启动 + /health (18789)
#   8. sati-bridge 连接 Gateway
#   9. 新用户 onboarding YAML 与 loadPilotConfig 兼容 (monorepo)
#
# Usage:
#   bash verify-dmg.sh <DMG_PATH> [signed|adhoc]
#   exit 0 = all checks pass; exit 1 = any failure
# ============================================================================

set -uo pipefail

DMG="${1:?Usage: verify-dmg.sh <DMG_PATH> [signed|adhoc]}"
MODE="${2:-auto}"

[[ -f "$DMG" ]] || { echo "DMG not found: $DMG" >&2; exit 2; }

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'
CYN=$'\033[0;36m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'

PASS=0; FAIL=0; WARN=0
pass() { PASS=$((PASS+1)); echo "  ${GRN}✓${RST} $*"; }
fail() { FAIL=$((FAIL+1)); echo "  ${RED}✗${RST} $*"; }
warn() { WARN=$((WARN+1)); echo "  ${YEL}⚠${RST} $*"; }
info() { echo "  ${DIM}$*${RST}"; }
hdr()  { echo; echo "${BLD}${CYN}── $* ──${RST}"; }

echo "${BLD}Sati Desktop DMG Verification${RST}"
echo "${DIM}DMG: ${DMG}${RST}"
echo "${DIM}Mode: ${MODE}${RST}"

# ─────────────── Mount ───────────────
hdr "1. Mount DMG"

MOUNT_OUT="$(hdiutil attach "$DMG" -nobrowse -noautoopen -readonly 2>&1)" || {
  fail "hdiutil attach failed:"; echo "$MOUNT_OUT"; exit 1; }
MOUNT_DIR="$(echo "$MOUNT_OUT" | awk '/\/Volumes\//{for(i=1;i<=NF;i++) if($i~/^\/Volumes\//){p=$i; for(j=i+1;j<=NF;j++) p=p" "$j; print p; exit}}')"
[[ -d "$MOUNT_DIR" ]] || { fail "Cannot determine mount point"; exit 1; }
pass "Mounted at: $MOUNT_DIR"

cleanup() {
  [[ -n "${MOUNT_DIR:-}" ]] && hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true
  [[ -n "${GW_PID:-}" ]] && kill "$GW_PID" 2>/dev/null || true
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX:-/dev/null}" ]] && rm -rf "$SANDBOX"
}
trap cleanup EXIT INT TERM

APP="$MOUNT_DIR/Sati.app"
[[ -d "$APP" ]] && pass "Sati.app present" || { fail "Sati.app missing"; exit 1; }
[[ -L "$MOUNT_DIR/Applications" ]] && pass "/Applications symlink present" \
  || warn "/Applications symlink missing (用户拖拽体验受影响)"

# ─────────────── Bundle structure ───────────────
hdr "2. App bundle structure"

[[ -f "$APP/Contents/MacOS/Sati" ]] && pass "Main executable present" \
  || fail "Main executable missing"
[[ -f "$APP/Contents/Info.plist" ]]    && pass "Info.plist present" \
  || fail "Info.plist missing"
[[ -d "$APP/Contents/Frameworks/Electron Framework.framework" ]] && pass "Electron Framework present" \
  || fail "Electron Framework missing"

helper_ok=0
for h in "Sati Helper" "Sati Helper (GPU)" "Sati Helper (Renderer)" "Sati Helper (Plugin)"; do
  if [[ -f "$APP/Contents/Frameworks/${h}.app/Contents/MacOS/${h}" ]]; then
    helper_ok=$((helper_ok+1))
  else
    fail "Missing helper: $h"
  fi
done
[[ "$helper_ok" -eq 4 ]] && pass "All 4 helpers present"

# ─────────────── Resources ───────────────
hdr "3. Bundled resources"

RES="$APP/Contents/Resources"
[[ -f "$RES/app.asar" ]]                && pass "app.asar present ($(du -sh "$RES/app.asar" | awk '{print $1}'))" \
                                        || fail "app.asar missing"
[[ -x "$RES/node-bin/node" ]]           && pass "Bundled Node present ($("$RES/node-bin/node" --version))" \
                                        || fail "node-bin/node missing or not executable"
[[ -x "$RES/bun-bin/bun" ]]             && pass "Bundled Bun present ($("$RES/bun-bin/bun" --version))" \
                                        || fail "bun-bin/bun missing or not executable"
[[ -f "$RES/satiui-bundle.tar" ]] && pass "satiui-bundle.tar present ($(du -sh "$RES/satiui-bundle.tar" | awk '{print $1}'))" \
                                        || fail "satiui-bundle.tar missing"
if tar -xOf "$RES/satiui-bundle.tar" server/index.js 2>/dev/null | grep -q 'SATI_DESKTOP'; then
  pass "ui server bundle skips browser auto-open when SATI_DESKTOP=1"
else
  fail "satiui-bundle.tar is stale: server/index.js still runs 'open' on listen — rebuild bundle from ui/"
fi
[[ -f "$RES/sati-main-bundle.tar" ]] && pass "sati-main-bundle.tar present ($(du -sh "$RES/sati-main-bundle.tar" | awk '{print $1}'))" \
                                        || fail "sati-main-bundle.tar missing"
[[ -f "$RES/sati-memory-core-bundle.tar" ]] && pass "sati-memory-core-bundle.tar present ($(du -sh "$RES/sati-memory-core-bundle.tar" | awk '{print $1}'))" \
                                        || fail "sati-memory-core-bundle.tar missing"

# ─────────────── Code signature ───────────────
hdr "4. Code signature"

if codesign --verify --deep --strict "$APP" 2>/tmp/sati-vrf-cs.log; then
  pass "codesign --verify --deep --strict OK"
else
  fail "codesign verify failed:"; cat /tmp/sati-vrf-cs.log
fi

CS_INFO="$(codesign -dvv "$APP" 2>&1 || true)"
SIGN_AUTH="$(echo "$CS_INFO" | awk -F'=' '/^Authority=/{print $2; exit}')"
SIGN_TEAM="$(echo "$CS_INFO" | awk -F'=' '/^TeamIdentifier=/{print $2; exit}')"
SIGN_ID="$(  echo "$CS_INFO" | awk -F'=' '/^Identifier=/{print $2; exit}')"
info "Identifier: ${SIGN_ID:-?}"
info "Authority:  ${SIGN_AUTH:-(ad-hoc)}"
info "Team ID:    ${SIGN_TEAM:-(none, ad-hoc)}"

DETECTED_MODE="adhoc"
[[ "$SIGN_AUTH" == *"Developer ID"* ]] && DETECTED_MODE="signed"
[[ "$MODE" == "auto" ]] && MODE="$DETECTED_MODE"

if [[ "$MODE" == "signed" ]]; then
  [[ "$SIGN_AUTH" == *"Developer ID"* ]] \
    && pass "Developer ID signature confirmed" \
    || fail "Expected Developer ID signature, got: ${SIGN_AUTH:-none}"
  if xcrun stapler validate "$APP" >/dev/null 2>&1; then
    pass "Notarization ticket stapled"
  else
    warn "Not stapled (用户首次启动需联网由 macOS 在线校验)"
  fi
elif [[ "$MODE" == "adhoc" ]]; then
  if [[ -z "$SIGN_TEAM" || "$SIGN_TEAM" == "(unset)" ]]; then
    pass "ad-hoc signature confirmed (no Team ID)"
  elif [[ "$DETECTED_MODE" == "signed" ]]; then
    info "DMG actually carries Developer ID signature — switching expectation to 'signed'"
    pass "Developer ID signature present (Team: ${SIGN_TEAM})"
  else
    warn "Unexpected Team ID: $SIGN_TEAM"
  fi
fi

SPCTL_OUT="$(spctl --assess --type execute --verbose "$APP" 2>&1 || true)"
if echo "$SPCTL_OUT" | grep -q "accepted"; then
  pass "Gatekeeper: accepted"
else
  if [[ "$MODE" == "adhoc" ]]; then
    info "Gatekeeper: rejected (expected for ad-hoc — 用户右键打开即可)"
  else
    warn "Gatekeeper: $(echo "$SPCTL_OUT" | head -1)"
  fi
fi

# ─────────────── Bundle extraction smoke test ───────────────
hdr "5. Bundle extraction smoke test"

SANDBOX="$(mktemp -d -t sati-desktop-verify.XXXXXX)"
info "Sandbox: $SANDBOX"

CCUI_DIR="$SANDBOX/satiui"
mkdir -p "$CCUI_DIR"
if tar xf "$RES/satiui-bundle.tar" -C "$CCUI_DIR" 2>/tmp/sati-vrf-tar1.log; then
  pass "satiui-bundle.tar extracted ($(du -sh "$CCUI_DIR" | awk '{print $1}'))"
else
  fail "satiui tar extract failed:"; cat /tmp/sati-vrf-tar1.log
  exit 1
fi

[[ -f "$CCUI_DIR/server/index.js" ]] && pass "server/index.js present" \
  || { fail "server/index.js missing"; exit 1; }
[[ -f "$CCUI_DIR/dist/index.html" ]] && pass "dist/index.html (vite build) present" \
  || warn "dist/index.html missing (UI may not load)"

CCM_DIR="$SANDBOX/sati-main"
mkdir -p "$CCM_DIR"
if tar xf "$RES/sati-main-bundle.tar" -C "$CCM_DIR" 2>/tmp/sati-vrf-tar2.log; then
  pass "sati-main-bundle.tar extracted ($(du -sh "$CCM_DIR" | awk '{print $1}'))"
else
  fail "sati-main tar extract failed:"; cat /tmp/sati-vrf-tar2.log
  exit 1
fi

[[ -f "$CCM_DIR/dist/src/cli/sati.js" ]] && pass "dist/src/cli/sati.js present" \
  || fail "dist/src/cli/sati.js missing (Gateway entry)"
[[ -f "$CCM_DIR/src/cli/sati.ts" ]] && pass "src/cli/sati.ts present" \
  || warn "src/cli/sati.ts missing (source tree optional in bundle)"
[[ -f "$CCM_DIR/preload.ts" ]] && pass "preload.ts present" \
  || warn "preload.ts missing"

MEM_DIR="$SANDBOX/sati-memory-core"
mkdir -p "$MEM_DIR"
if tar xf "$RES/sati-memory-core-bundle.tar" -C "$MEM_DIR" 2>/tmp/sati-vrf-tar3.log; then
  pass "sati-memory-core-bundle.tar extracted ($(du -sh "$MEM_DIR" | awk '{print $1}'))"
else
  fail "sati-memory-core tar extract failed:"; cat /tmp/sati-vrf-tar3.log
  exit 1
fi

[[ -f "$MEM_DIR/lib/index.js" ]] && pass "sati-memory-core/lib/index.js present" \
  || fail "sati-memory-core/lib/index.js missing"

# ─────────────── Runtime smoke (Gateway + UI + bridge) ───────────────
hdr "6–8. Gateway + UI server + bridge smoke test"

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});' 2>/dev/null || echo 28790)"
GATEWAY_PORT=18789

# V2 schema — must match loadPilotConfig() (schemaVersion + agent + model).
SATI_HOME="$SANDBOX/home/.sati"
mkdir -p "$SATI_HOME"
cat > "$SATI_HOME/sati.yaml" <<EOF
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
pass "Stub sati.yaml created (V2, UI port=${PORT})"
SRV_LOG="$SANDBOX/server.log"
GW_LOG="$SANDBOX/gateway.log"

# UI server files use relative imports that resolve outside the satiui/ dir:
#   projects.js    → ../../dist/src/pilot/index.js  (→ $SANDBOX/dist/)
#   routes/memory.js → ../../../../src/context/memory/edgeclaw-memory-core/lib/index.js (→ $SANDBOX/src/context/memory/edgeclaw-memory-core/)
# Create symlinks so these cross-bundle imports resolve in the sandbox.
if [[ -d "$CCM_DIR/dist" ]]; then
  ln -sfn "$CCM_DIR/dist" "$SANDBOX/dist"
  pass "Symlinked \$SANDBOX/dist → sati-main/dist"
fi
if [[ -d "$CCM_DIR/dist/src" ]]; then
  ln -sfn "$CCM_DIR/dist/src" "$SANDBOX/src"
  pass "Symlinked \$SANDBOX/src → sati-main/dist/src (TSX→JS bridge)"
fi
if [[ -d "$MEM_DIR" ]]; then
  mkdir -p "$SANDBOX/src/context/memory"
  # The sati-main bundle may contain a stub edgeclaw-memory-core/ dir
  # from tsc output; remove it so the symlink to the real bundle takes effect.
  ECMC_LINK="$SANDBOX/src/context/memory/edgeclaw-memory-core"
  if [[ -d "$ECMC_LINK" && ! -L "$ECMC_LINK" ]]; then
    rm -rf "$ECMC_LINK"
  fi
  ln -sfn "$MEM_DIR" "$ECMC_LINK"
  # Also expose as a node_modules package so bare `import 'edgeclaw-memory-core'` resolves
  mkdir -p "$CCM_DIR/node_modules"
  ln -sfn "$MEM_DIR" "$CCM_DIR/node_modules/edgeclaw-memory-core"
  pass "Symlinked \$SANDBOX/src/context/memory/edgeclaw-memory-core → sati-memory-core"
fi

# ESM resolution walks up from the importing file; satiui/server/index.js
# needs to find hoisted packages (ws, express, etc.) that live in
# sati-main/node_modules. A parent-level symlink emulates workspace hoisting.
if [[ ! -e "$SANDBOX/node_modules" ]]; then
  ln -sfn "$CCM_DIR/node_modules" "$SANDBOX/node_modules"
  pass "Symlinked \$SANDBOX/node_modules → sati-main/node_modules (ESM resolve)"
fi

# src: ui/server imports ../../src/web/server/*.js — compiled JS lives in sati-main/dist/src
if [[ -d "$CCM_DIR/dist/src" && ! -e "$SANDBOX/src" ]]; then
  ln -sfn "$CCM_DIR/dist/src" "$SANDBOX/src"
  pass "Symlinked \$SANDBOX/src → sati-main/dist/src"
fi

# Reuse of port 18789 from a prior desktop run breaks token/bridge checks.
# 与 packaged-runtime.sh 一致：杀前先验证命令行，端口可能被用户的无关
# 进程（或真实运行的 Sati 实例）占用，不得无身份检查地 kill。
GW_LISTENER="$(/usr/sbin/lsof -nP -t -iTCP:18789 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$GW_LISTENER" ]]; then
  if ps -p "$GW_LISTENER" -o command= 2>/dev/null | grep -q 'dist/src/cli/sati'; then
    info "Stopping stale Sati gateway on :18789 (pid $GW_LISTENER)"
    kill "$GW_LISTENER" 2>/dev/null || true
    sleep 1
  else
    info "Skipping listener on :18789 (pid $GW_LISTENER) — not a Sati gateway"
  fi
fi

# Step 7: Gateway must be up before UI bridge connects.
GW_ENTRY="$CCM_DIR/dist/src/cli/sati.js"
info "Spawning Gateway: $GW_ENTRY (port $GATEWAY_PORT)"
(
  cd "$CCM_DIR"
  HOME="$SANDBOX/home" \
  SATI_HOME="$SATI_HOME" \
  SATI_GATEWAY_PORT="$GATEWAY_PORT" \
  BUN_BIN="$RES/bun-bin/bun" \
  NO_COLOR=1 FORCE_COLOR=0 \
  "$RES/node-bin/node" "$GW_ENTRY" server \
    > "$GW_LOG" 2>&1 &
  echo $!
) > "$SANDBOX/gw.pid"
GW_PID="$(cat "$SANDBOX/gw.pid")"

GW_OK=0
for i in $(seq 1 90); do
  if /usr/bin/curl -s -m 1 "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null | grep -q '"ok":true'; then
    GW_OK=1; break
  fi
  sleep 0.5
  if ! kill -0 "$GW_PID" 2>/dev/null; then break; fi
done

if [[ "$GW_OK" == "1" ]]; then
  pass "Gateway responding on http://127.0.0.1:${GATEWAY_PORT}/health"
else
  fail "Gateway did not respond within 45s"
  echo "  ${DIM}Last 40 lines of gateway log:${RST}"
  tail -40 "$GW_LOG" | sed 's/^/    /'
fi

TOKEN_OK=0
for i in $(seq 1 20); do
  if [[ -f "$SATI_HOME/server-token" ]]; then
    TOKEN_OK=1
    break
  fi
  sleep 0.5
done
if [[ "$TOKEN_OK" == "1" ]]; then
  pass "Gateway wrote server-token"
else
  fail "Missing $SATI_HOME/server-token (bridge cannot authenticate)"
  echo "  ${DIM}Last 30 lines of gateway log:${RST}"
  tail -30 "$GW_LOG" | sed 's/^/    /'
fi

# Step 6: UI server
info "Spawning UI server: $CCUI_DIR/server/index.js (port $PORT)"
(
  cd "$CCUI_DIR"
  HOME="$SANDBOX/home" \
  SATI_HOME="$SATI_HOME" \
  SERVER_PORT="$PORT" \
  SATI_MAIN_DIR="$CCM_DIR" \
  BUN_BIN="$RES/bun-bin/bun" \
  NO_COLOR=1 FORCE_COLOR=0 \
  "$RES/node-bin/node" server/index.js \
    > "$SRV_LOG" 2>&1 &
  echo $!
) > "$SANDBOX/srv.pid"
SRV_PID="$(cat "$SANDBOX/srv.pid")"

SRV_OK=0
for i in $(seq 1 60); do
  if /usr/bin/curl -s -m 1 "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; then
    SRV_OK=1; break
  fi
  sleep 0.5
  if ! kill -0 "$SRV_PID" 2>/dev/null; then break; fi
done

if [[ "$SRV_OK" == "1" ]]; then
  pass "UI server responding on http://127.0.0.1:${PORT}/health"
else
  fail "UI server did not respond within 30s"
  echo "  ${DIM}Last 40 lines of server log:${RST}"
  tail -40 "$SRV_LOG" | sed 's/^/    /'
fi

# Step 8: bridge WebSocket to Gateway (lazy; may take up to GATEWAY_CONNECT_TIMEOUT_MS)
# Nudge an API that calls getSatiGateway().
/usr/bin/curl -s -m 5 "http://127.0.0.1:${PORT}/api/projects" >/dev/null 2>&1 || true

# 增量 tail 而非整文件 grep：90 次轮询 × 全文件扫描在日志增长时是 O(n²)。
BRIDGE_OK=0
BRIDGE_OFFSET=0
for i in $(seq 1 90); do
  if [[ -f "$SRV_LOG" ]]; then
    NEW_SIZE="$(wc -c < "$SRV_LOG" | tr -d ' ' || echo 0)"
    if [[ "$NEW_SIZE" -gt "$BRIDGE_OFFSET" ]]; then
      NEW_CHUNK="$(dd if="$SRV_LOG" bs=1 skip="$BRIDGE_OFFSET" 2>/dev/null || true)"
      BRIDGE_OFFSET="$NEW_SIZE"
      if [[ "$NEW_CHUNK" == *'[sati-bridge] connected'* ]]; then
        BRIDGE_OK=1; break
      fi
      if [[ "$NEW_CHUNK" == *'gateway connect failed after'* ]]; then
        break
      fi
    fi
  fi
  sleep 0.5
done
if [[ "$BRIDGE_OK" == "1" ]]; then
  pass "sati-bridge connected to Gateway"
else
  fail "sati-bridge did not connect within 45s"
  echo "  ${DIM}Last 40 lines of server log:${RST}"
  tail -40 "$SRV_LOG" | sed 's/^/    /'
fi

for pid_var in SRV_PID GW_PID; do
  pid="${!pid_var}"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
done
pass "Gateway and UI server terminated cleanly"

# ─────────────── Step 9: onboarding config compatibility ───────────────
hdr "9. New-user onboarding config (loadPilotConfig)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ONBOARD_TEST="${REPO_ROOT}/tests/desktop/onboarding-config-compat.test.ts"

if [[ -f "$ONBOARD_TEST" ]]; then
  # release.sh 在发布流程中已编译过 apps/desktop（同一 checkout）；这里只
  # 在 dist/main.js 缺失或过期（源文件更新）时才重建，避免同一次发布
  # 对同一批源码重复跑 3 次 tsc。
  DESKTOP_DIST="${REPO_ROOT}/apps/desktop/dist/main.js"
  NEEDS_BUILD=0
  if [[ ! -f "$DESKTOP_DIST" ]]; then
    NEEDS_BUILD=1
  elif [[ "$(find "${REPO_ROOT}/apps/desktop/src" -name '*.ts' -newer "$DESKTOP_DIST" | wc -l | tr -d ' ')" != "0" ]]; then
    NEEDS_BUILD=1
  fi
  if [[ "$NEEDS_BUILD" == "1" ]]; then
    info "Building apps/desktop (onboarding-config → dist/)…"
    if ! (cd "${REPO_ROOT}/apps/desktop" && pnpm run build >/dev/null 2>&1); then
      fail "apps/desktop tsc build failed (required for step 9)"
    else
      pass "apps/desktop built"
    fi
  else
    info "apps/desktop dist/ is fresh — skipping rebuild (compiled earlier this release)"
  fi
  if [[ -f "$DESKTOP_DIST" ]]; then
    info "Running: node --import tsx --test $ONBOARD_TEST"
    if (cd "$REPO_ROOT" && node --import tsx --test "$ONBOARD_TEST" 2>&1); then
      pass "Onboarding V2 YAML passes loadPilotConfig"
    else
      fail "Onboarding config compatibility test failed"
    fi
  fi
else
  warn "Skipping step 9 (test file not found — run from monorepo checkout)"
fi

# ─────────────── Summary ───────────────
hdr "Summary"
echo "  ${GRN}Pass${RST}: $PASS    ${YEL}Warn${RST}: $WARN    ${RED}Fail${RST}: $FAIL"
echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "${BLD}${GRN}✓ DMG verification PASSED${RST}"
  exit 0
else
  echo "${BLD}${RED}✗ DMG verification FAILED${RST}"
  exit 1
fi
