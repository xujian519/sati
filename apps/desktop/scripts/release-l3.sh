#!/usr/bin/env bash
# ============================================================================
# L3 release E2E — real Gateway agent turn (opt-in, needs API credentials)
#
# Usage:
#   bash scripts/release-l3.sh              # skip if no API keys
#   bash scripts/release-l3.sh --force      # fail if keys missing
#   SATI_RUN_FRAMEWORK_E2E=1 bash scripts/release-l3.sh
#
# Also runs real-agent-lifecycle-hooks when SATI_RUN_REAL_AGENT_LIFECYCLE_E2E=1.
#
# Note on harnesses: the real-model harnesses referenced here
# (dist/tests/e2e/framework-wcb-smoke.test.js and
# dist/tests/agent/e2e/run-real-agent-lifecycle-hooks.js) were removed from the
# repo (see RELEASING.md). This script auto-detects whichever harnesses are
# present in dist/tests and runs them. If a key is provided but no harness
# exists, the gate FAILS (exit 1) — a release gate that silently passes without
# doing its job is a false pass. Mirrors release-l3-win.mjs.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; CYN=$'\033[0;36m'; BLD=$'\033[1m'; RST=$'\033[0m'

has_key=0
for v in ANTHROPIC_API_KEY OPENAI_API_KEY SATI_API_KEY; do
  [[ -n "${!v:-}" ]] && has_key=1 && break
done

echo "${BLD}Sati L3 E2E${RST}"

if [[ "$has_key" == "0" ]]; then
  if [[ "$FORCE" == "1" ]]; then
    echo "${RED}No API key in env (ANTHROPIC_API_KEY / OPENAI_API_KEY / SATI_API_KEY)${RST}" >&2
    exit 1
  fi
  echo "${YEL}⚠ Skipping L3 — no API credentials in environment${RST}"
  echo "  Export a key and re-run, or: bash scripts/release-l3.sh --force"
  exit 0
fi

cd "$REPO_ROOT"
echo
echo "${CYN}── L3a: Framework WCB smoke (Gateway + real model) ──${RST}"
pnpm run build
RAN_L3A=0
if [[ -f dist/tests/e2e/framework-wcb-smoke.test.js ]]; then
  SATI_RUN_FRAMEWORK_E2E=1 node --test --test-force-exit --test-timeout 300000 \
    dist/tests/e2e/framework-wcb-smoke.test.js
  RAN_L3A=1
else
  echo "${YEL}⚠ dist/tests/e2e/framework-wcb-smoke.test.js not found in this build — skipped.${RST}"
  echo "  (The real-model harness was removed repo-wide; see RELEASING.md.)"
fi

if [[ "${SATI_RUN_REAL_AGENT_LIFECYCLE_E2E:-}" == "1" ]]; then
  echo
  echo "${CYN}── L3b: Real agent lifecycle hooks ──${RST}"
  if [[ -f dist/tests/agent/e2e/run-real-agent-lifecycle-hooks.js ]]; then
    if SATI_RUN_REAL_AGENT_LIFECYCLE_E2E=1 node dist/tests/agent/e2e/run-real-agent-lifecycle-hooks.js; then
      echo "  ${GRN}✓${RST} lifecycle hooks E2E passed"
    else
      echo "  ${YEL}⚠${RST} lifecycle hooks E2E failed (often model tool_choice; L3a still counts)"
      L3B_FAILED=1
    fi
  else
    echo "${YEL}⚠ dist/tests/agent/e2e/run-real-agent-lifecycle-hooks.js not found — skipped.${RST}"
  fi
else
  echo
  echo "${CYN}── L3b: lifecycle hooks (skipped) ──${RST}"
  echo "  Set SATI_RUN_REAL_AGENT_LIFECYCLE_E2E=1 to enable"
fi

echo
if [[ "${RAN_L3A:-0}" == "1" ]]; then
  if [[ "${L3B_FAILED:-0}" == "1" ]]; then
    echo "${BLD}${YEL}✓ L3 core PASSED (L3a); L3b failed — see log above${RST}"
    exit 0
  fi
  echo "${BLD}${GRN}✓ L3 E2E PASSED${RST}"
  exit 0
fi

echo "${RED}✗ No real-model harness was available in this build — L3 ran nothing.${RST}"
echo "  A key was provided but the gate could not do its job, so this is a FAILURE,"
echo "  not a pass (mirrors release-l3-win.mjs). Restore the harness or skip L3."
exit 1
