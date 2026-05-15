#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════
# WCB 0510 Orchestration Demo — Docker Batch Runner (PilotDeck)
#
# Runs 8 selected tasks from 0510_Orchestration_Demo via PilotDeck.
# Usage:
#   bash wcb/run_0510_batch.sh
#   MODEL=openai/gpt-5.4 PARALLEL=4 bash wcb/run_0510_batch.sh
# ═══════════════════════════════════════════════════════════════════════

DOCKER_IMAGE="${DOCKER_IMAGE:-wildclawbench-pilotdeck:v1.6}"
NFS_ROOT="/home/yyk/yyk03/Workspace"
MODEL="${MODEL:-minimax/minimax-m2.7}"
ORCH_MODEL="${ORCH_MODEL:-}"
PARALLEL="${PARALLEL:-8}"

CATEGORY="0510_Orchestration_Demo"
if [[ -z "$BATCH_ID" ]]; then
  if [[ -n "$ORCH_MODEL" ]]; then
    BATCH_ID="orch_$(date +%Y%m%d_%H%M)"
  else
    BATCH_ID="${MODEL//\//_}_$(date +%Y%m%d_%H%M)"
  fi
fi
OUTPUT_DIR="$NFS_ROOT/PilotDeck/wcb-output/$BATCH_ID"
OUTPUT_DIR_CONTAINER="/workspace/PilotDeck/wcb-output/$BATCH_ID"
BUGS_FILE="$OUTPUT_DIR/bugs.jsonl"

WCB_CC_TASKS="$NFS_ROOT/WildClawBench/WildClawBench-cc/tasks/$CATEGORY"
WCB_CC_TASKS_CONTAINER="/workspace/WildClawBench/WildClawBench-cc/tasks/$CATEGORY"

TASKS=(
  0510_Orchestration_Demo_task_1_podcast_multilingual_push
  0510_Orchestration_Demo_task_2_multi_source_data_report
  0510_Orchestration_Demo_task_3_domain_survey
  0510_Orchestration_Demo_task_4_financial_portfolio_digest
  0510_Orchestration_Demo_task_5_codebase_architecture_doc
  0510_Orchestration_Demo_task_6_sam3_debug
  0510_Orchestration_Demo_task_7_video_en_to_zh_dub
  0510_Orchestration_Demo_task_8d_embedding_platform_full
)

# ── Source API keys from .env ──────────────────────────────────────────
WCB_ENV="$NFS_ROOT/WildClawBench/WildClawBench-cc/.env"
if [[ -f "$WCB_ENV" ]]; then
  set -a; source "$WCB_ENV"; set +a
fi

EDGECLAW_API_KEY="${EDGECLAW_API_KEY:?EDGECLAW_API_KEY must be set}"
EDGECLAW_API_BASE_URL="${EDGECLAW_API_BASE_URL:-https://openrouter.ai/api}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$EDGECLAW_API_KEY}"
OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"
SERP_API_KEY="${SERP_API_KEY:-}"
JUDGE_MODEL="${JUDGE_MODEL:-openai/gpt-4.1-mini}"
HTTP_PROXY_INNER="${HTTP_PROXY_INNER:-http://11.11.26.2:7897}"
HTTPS_PROXY_INNER="${HTTPS_PROXY_INNER:-http://11.11.26.2:7897}"
NO_PROXY_INNER="${NO_PROXY_INNER:-localhost,127.0.0.1,11.11.26.2,11.11.16.2,api.serp.hk}"

# ── Setup output directory ─────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"
touch "$BUGS_FILE"

TASK_COUNT=${#TASKS[@]}

echo "═══════════════════════════════════════════════════════════════"
echo "  WCB 0510 Orchestration Demo — PilotDeck Batch Runner"
echo "═══════════════════════════════════════════════════════════════"
echo "  Model:      $MODEL"
if [[ -n "$ORCH_MODEL" ]]; then
echo "  Orch Model: $ORCH_MODEL"
fi
echo "  Batch ID:   $BATCH_ID"
echo "  Output:     $OUTPUT_DIR"
echo "  Parallel:   $PARALLEL"
echo "  Tasks:      $TASK_COUNT"
echo "  Docker:     $DOCKER_IMAGE"
echo "═══════════════════════════════════════════════════════════════"

cat > "$OUTPUT_DIR/batch-meta.json" <<METAEOF
{
  "batchId": "$BATCH_ID",
  "model": "$MODEL",
  "orchModel": "$ORCH_MODEL",
  "category": "$CATEGORY",
  "dockerImage": "$DOCKER_IMAGE",
  "parallel": $PARALLEL,
  "taskCount": $TASK_COUNT,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname)"
}
METAEOF

# ── Helper: extract timeout from task frontmatter ──────────────────────
get_timeout() {
  local task_md="$1"
  local t
  t=$(grep -m1 'timeout_seconds:' "$task_md" 2>/dev/null | sed 's/.*timeout_seconds:[[:space:]]*//' | tr -d ' "' || true)
  [[ -z "$t" || "$t" == "0" ]] && t="600"
  echo "$t"
}

# ── Run a single task inside Docker ────────────────────────────────────
run_one_task() {
  local TASK_NAME="$1"
  local TASK_BASENAME="${TASK_NAME}.md"

  local HOST_TASK_MD="$WCB_CC_TASKS/$TASK_BASENAME"
  if [[ ! -f "$HOST_TASK_MD" ]]; then
    echo "[$(date +%H:%M:%S)] SKIP  $TASK_NAME (file not found: $HOST_TASK_MD)"
    return 1
  fi

  local TIMEOUT_S
  TIMEOUT_S=$(get_timeout "$HOST_TASK_MD")
  local TIMEOUT_MS=$((TIMEOUT_S * 1000))
  local CONTAINER_TASK="$WCB_CC_TASKS_CONTAINER/$TASK_BASENAME"
  local CNAME="wcb-${TASK_NAME:0:50}-$$"

  mkdir -p "$OUTPUT_DIR/$CATEGORY/$TASK_NAME"
  echo "[$(date +%H:%M:%S)] START $TASK_NAME (timeout=${TIMEOUT_S}s)"

  local EXIT_CODE=0
  timeout $((TIMEOUT_S + 120)) \
    docker run --rm \
      --stop-timeout 30 \
      --network host \
      --name "$CNAME" \
      -v "$NFS_ROOT:/workspace:rw" \
      -e EDGECLAW_MODEL="$MODEL" \
      -e ORCH_MODEL="$ORCH_MODEL" \
      -e EDGECLAW_API_KEY="$EDGECLAW_API_KEY" \
      -e EDGECLAW_API_BASE_URL="$EDGECLAW_API_BASE_URL" \
      -e DOCKER_MODE=1 \
      -e HOME=/root \
      -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
      -e OPENROUTER_BASE_URL="$OPENROUTER_BASE_URL" \
      -e SERP_API_KEY="$SERP_API_KEY" \
      -e JUDGE_MODEL="$JUDGE_MODEL" \
      -e SEARCH_PROVIDER=serp \
      -e HTTP_PROXY="$HTTP_PROXY_INNER" \
      -e HTTPS_PROXY="$HTTPS_PROXY_INNER" \
      -e http_proxy="$HTTP_PROXY_INNER" \
      -e https_proxy="$HTTPS_PROXY_INNER" \
      -e NO_PROXY="$NO_PROXY_INNER" \
      -e no_proxy="$NO_PROXY_INNER" \
      -e WCB_ROOT="/workspace/WildClawBench/WildClawBench-github" \
      "$DOCKER_IMAGE" \
      /bin/bash -c "cd /workspace/PilotDeck && bun wcb/run_pilotdeck.mjs \
        --task '$CONTAINER_TASK' \
        --output-dir '$OUTPUT_DIR_CONTAINER' \
        --model '$MODEL' \
        --bugs-file '$OUTPUT_DIR_CONTAINER/bugs.jsonl' \
        --timeout $TIMEOUT_MS ; chmod -R a+rX '$OUTPUT_DIR_CONTAINER/$CATEGORY' 2>/dev/null ; chown -R 32157:42034 '$OUTPUT_DIR_CONTAINER/$CATEGORY/$TASK_NAME' 2>/dev/null || true" \
      > "$OUTPUT_DIR/$CATEGORY/$TASK_NAME/docker-stdout.log" 2>&1 || EXIT_CODE=$?

  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "[$(date +%H:%M:%S)] FAIL  $TASK_NAME (exit=$EXIT_CODE)"
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"taskId\":\"$TASK_NAME\",\"type\":\"docker_error\",\"msg\":\"exit $EXIT_CODE\",\"context\":{\"category\":\"$CATEGORY\"}}" >> "$BUGS_FILE"
  else
    echo "[$(date +%H:%M:%S)] DONE  $TASK_NAME"
  fi
}

export -f run_one_task get_timeout
export OUTPUT_DIR OUTPUT_DIR_CONTAINER BATCH_ID MODEL ORCH_MODEL DOCKER_IMAGE NFS_ROOT BUGS_FILE
export WCB_CC_TASKS WCB_CC_TASKS_CONTAINER CATEGORY
export EDGECLAW_API_KEY EDGECLAW_API_BASE_URL OPENROUTER_API_KEY OPENROUTER_BASE_URL
export SERP_API_KEY JUDGE_MODEL HTTP_PROXY_INNER HTTPS_PROXY_INNER NO_PROXY_INNER

# ── Execute ────────────────────────────────────────────────────────────
START_TS=$(date +%s)

if [[ "$PARALLEL" -le 1 ]]; then
  for TASK_NAME in "${TASKS[@]}"; do
    run_one_task "$TASK_NAME"
  done
else
  printf '%s\n' "${TASKS[@]}" | xargs -I{} -P"$PARALLEL" bash -c 'run_one_task "$@"' _ {}
fi

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Batch complete: $TASK_COUNT tasks in ${ELAPSED}s ($((ELAPSED/60))m $((ELAPSED%60))s)"
echo "  Output: $OUTPUT_DIR"
echo "═══════════════════════════════════════════════════════════════"

python3 -c "
import json
with open('$OUTPUT_DIR/batch-meta.json') as f:
    meta = json.load(f)
meta['finishedAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
meta['elapsedSeconds'] = $ELAPSED
with open('$OUTPUT_DIR/batch-meta.json', 'w') as f:
    json.dump(meta, f, indent=2)
" 2>/dev/null || true
