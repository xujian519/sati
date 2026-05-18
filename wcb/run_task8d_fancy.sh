#!/usr/bin/env bash
set -euo pipefail

DOCKER_IMAGE="${DOCKER_IMAGE:-wildclawbench-pilotdeck:v1.6}"
NFS_ROOT="/home/yyk/yyk03/Workspace"
MODEL="${MODEL:-minimax/minimax-m2.7}"
ORCH_MODEL="${ORCH_MODEL:-claude-4.6-sonnet-20260217}"
BATCH_ID="${BATCH_ID:-orch_sonnet_v4_task8d_fancy}"

CATEGORY="0510_Orchestration_Demo"
OUTPUT_DIR="$NFS_ROOT/PilotDeck/wcb-output/$BATCH_ID"
OUTPUT_DIR_CONTAINER="/workspace/PilotDeck/wcb-output/$BATCH_ID"
BUGS_FILE="$OUTPUT_DIR/bugs.jsonl"

WCB_CC_TASKS="$NFS_ROOT/WildClawBench/WildClawBench-cc/tasks/$CATEGORY"
WCB_CC_TASKS_CONTAINER="/workspace/WildClawBench/WildClawBench-cc/tasks/$CATEGORY"

TASK_NAME="0510_Orchestration_Demo_task_8d_embedding_platform_full"

# Source API keys
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
# Force no proxy — g72 has direct connectivity to openrouter.ai
HTTP_PROXY_INNER=""
HTTPS_PROXY_INNER=""
NO_PROXY_INNER=""

mkdir -p "$OUTPUT_DIR/$CATEGORY/$TASK_NAME"
touch "$BUGS_FILE"

echo "═══════════════════════════════════════════════════════════════"
echo "  WCB task_8d FANCY — PilotDeck Single Task Runner"
echo "═══════════════════════════════════════════════════════════════"
echo "  Model:      $MODEL"
echo "  Orch Model: $ORCH_MODEL"
echo "  Batch ID:   $BATCH_ID"
echo "  Output:     $OUTPUT_DIR"
echo "  Docker:     $DOCKER_IMAGE"
echo "═══════════════════════════════════════════════════════════════"

cat > "$OUTPUT_DIR/batch-meta.json" <<METAEOF
{
  "batchId": "$BATCH_ID",
  "model": "$MODEL",
  "orchModel": "$ORCH_MODEL",
  "category": "$CATEGORY",
  "dockerImage": "$DOCKER_IMAGE",
  "parallel": 1,
  "taskCount": 1,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname)"
}
METAEOF

HOST_TASK_MD="$WCB_CC_TASKS/${TASK_NAME}.md"
TIMEOUT_S=$(grep -m1 'timeout_seconds:' "$HOST_TASK_MD" 2>/dev/null | sed 's/.*timeout_seconds:[[:space:]]*//' | tr -d ' "' || echo 600)
[[ -z "$TIMEOUT_S" || "$TIMEOUT_S" == "0" ]] && TIMEOUT_S=600
TIMEOUT_MS=$((TIMEOUT_S * 1000))
CONTAINER_TASK="$WCB_CC_TASKS_CONTAINER/${TASK_NAME}.md"
CNAME="wcb-task8d-fancy-$$"

echo "[$(date +%H:%M:%S)] START $TASK_NAME (timeout=${TIMEOUT_S}s)"

START_TS=$(date +%s)

EXIT_CODE=0
timeout $((TIMEOUT_S + 120)) \
  docker run --rm \
    --stop-timeout 30 \
    --network host \
    --name "$CNAME" \
    -v "$NFS_ROOT:/workspace:rw" \
    -e EDGECLAW_MODEL="$MODEL" \
    -e ORCH_MODEL="$ORCH_MODEL" \
    -e ORCH_TRIGGER_TIERS="${ORCH_TRIGGER_TIERS:-complex,medium}" \
    -e ORCH_VIA_OPENAI="${ORCH_VIA_OPENAI:-1}" \
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
    2>&1 | tee "$OUTPUT_DIR/$CATEGORY/$TASK_NAME/docker-stdout.log" || EXIT_CODE=$?

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "[$(date +%H:%M:%S)] FAIL $TASK_NAME (exit=$EXIT_CODE)"
else
  echo "[$(date +%H:%M:%S)] DONE $TASK_NAME"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Completed in ${ELAPSED}s ($((ELAPSED/60))m $((ELAPSED%60))s)"
echo "  Output: $OUTPUT_DIR/$CATEGORY/$TASK_NAME"
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
