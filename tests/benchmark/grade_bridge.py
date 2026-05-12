#!/usr/bin/env python3
"""
Thin bridge invoked by the PilotDeck benchmark runner via child_process.

Usage: python3 grade_bridge.py <input.json>

Input JSON shape:
  {
    "task_file": "/path/to/task_XX_foo.md",
    "execution_result": { "transcript": [...], "workspace": "/path", "status": "success", ... },
    "skill_dir": "/path/to/skill",
    "judge_model": "...",        // optional
    "verbose": false             // optional
  }

Outputs a JSON line to stdout:
  { "task_id": "...", "score": 0.8, "max_score": 1.0, "grading_type": "...",
    "breakdown": {...}, "notes": "..." }
"""

import json
import sys
from pathlib import Path

def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: grade_bridge.py <input.json>"}))
        sys.exit(1)

    input_path = Path(sys.argv[1])
    payload = json.loads(input_path.read_text(encoding="utf-8"))

    skill_dir = Path(payload["skill_dir"])
    scripts_dir = skill_dir / "scripts"

    # Add the PinchBench scripts directory to sys.path so we can import
    # lib_tasks and lib_grading without installing them.
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    from lib_tasks import TaskLoader
    from lib_grading import grade_task

    task_file = Path(payload["task_file"])
    loader = TaskLoader(task_file.parent)
    task = loader.load_task(task_file)

    execution_result = payload["execution_result"]

    grade = grade_task(
        task=task,
        execution_result=execution_result,
        skill_dir=skill_dir,
        judge_model=payload.get("judge_model", "openrouter/anthropic/claude-opus-4.5"),
        verbose=payload.get("verbose", False),
    )

    print(json.dumps(grade.to_dict()))


if __name__ == "__main__":
    main()
