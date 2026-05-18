#!/bin/bash
set -e
cd /home/yyk/yyk03/Workspace/PilotDeck
HOST="http://58.57.119.12:52006"
LOG="wcb-output/remote_qwen36_run_$(date +%Y%m%d_%H%M%S).log"

echo "=== WCB Remote Runner (qwen3.6) started at $(date) ===" | tee "$LOG"
echo "Host: $HOST" | tee -a "$LOG"

for TASK in task_1 task_2 task_3 task_4; do
  echo "" | tee -a "$LOG"
  echo ">>>>>>>>>> Running $TASK <<<<<<<<<<" | tee -a "$LOG"
  node wcb/run_remote_pilotdeck.mjs --host "$HOST" --filter "$TASK" --limit 1 2>&1 | tee -a "$LOG"
  echo ">>>>>>>>>> $TASK finished at $(date) <<<<<<<<<<" | tee -a "$LOG"
done

echo "" | tee -a "$LOG"
echo "=== ALL DONE at $(date) ===" | tee -a "$LOG"
