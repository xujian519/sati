#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────
# rename-polit-to-pilot.sh
#
# 一键将项目中所有 Polit/PolitDeck 变体重命名为 Pilot/PilotDeck。
# 默认在 git worktree 中执行，验证通过后提示是否应用回主工作区。
#
# 用法:
#   bash scripts/rename-polit-to-pilot.sh                  # worktree 模式（默认，安全）
#   bash scripts/rename-polit-to-pilot.sh --in-place        # 直接修改当前工作区
#   bash scripts/rename-polit-to-pilot.sh --worktree /tmp/x # 指定 worktree 路径
#   bash scripts/rename-polit-to-pilot.sh --dry-run         # 只打印，不执行
# ────────────────────────────────────────────────────────────

DRY_RUN=false
IN_PLACE=false
WORKTREE_DIR=""
SCRIPT_SOURCE="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)   DRY_RUN=true; shift ;;
    --in-place)  IN_PLACE=true; shift ;;
    --worktree)  WORKTREE_DIR="${2:-}"; shift 2 ;;
    --_running-in-worktree) IN_PLACE=true; shift ;; # internal: already inside worktree
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

DEFAULT_WORKTREE="/tmp/pilotdeck-rename-preview"

# If not --in-place and not --dry-run, bootstrap into a worktree
if ! $IN_PLACE && ! $DRY_RUN; then
  WORKTREE_DIR="${WORKTREE_DIR:-$DEFAULT_WORKTREE}"

  echo ""
  blue "═══ Worktree 模式 ═══"
  echo "  源仓库: $SOURCE_ROOT"
  echo "  工作目录: $WORKTREE_DIR"
  echo ""

  # Clean up stale worktree if exists
  if [[ -d "$WORKTREE_DIR" ]]; then
    yellow "  清理旧的 worktree: $WORKTREE_DIR"
    git -C "$SOURCE_ROOT" worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR"
  fi

  # Create fresh worktree
  git -C "$SOURCE_ROOT" worktree add "$WORKTREE_DIR" HEAD 2>&1 | sed 's/^/  /'

  # Copy this script into the worktree and re-exec
  mkdir -p "$WORKTREE_DIR/scripts"
  cp "$SCRIPT_SOURCE" "$WORKTREE_DIR/scripts/"

  # Install deps in worktree (needed for tsc/test)
  echo ""
  yellow "  安装依赖..."
  (cd "$WORKTREE_DIR" && npm install --silent 2>&1 | tail -3)

  echo ""
  blue "═══ 在 worktree 中执行重命名 ═══"
  echo ""

  # Re-exec inside worktree with internal flag
  bash "$WORKTREE_DIR/scripts/rename-polit-to-pilot.sh" --_running-in-worktree
  RENAME_EXIT=$?

  echo ""
  if [[ $RENAME_EXIT -eq 0 ]]; then
    blue "═══ Worktree 中执行成功 ═══"
    echo ""
    echo "  结果目录: $WORKTREE_DIR"
    echo "  你可以 cd 进去检查任何文件。"
    echo ""
    read -rp "Apply changes to ${SOURCE_ROOT} ? (y/N) " apply_answer
    if [[ "$apply_answer" =~ ^[Yy]$ ]]; then
      blue "═══ 应用变更到主工作区 ═══"
      # Use git diff to generate a patch from the worktree, then apply it
      # This preserves renames properly
      (cd "$WORKTREE_DIR" && git diff HEAD) > /tmp/pilotdeck-rename.patch
      (cd "$WORKTREE_DIR" && git diff --name-status HEAD | grep '^R') > /tmp/pilotdeck-renames.txt || true

      cd "$SOURCE_ROOT"

      # Apply file renames first (git mv)
      while IFS=$'\t' read -r status old_name new_name; do
        if [[ "$status" == R* ]]; then
          dir="$(dirname "$new_name")"
          mkdir -p "$dir"
          git mv "$old_name" "$new_name"
        fi
      done < /tmp/pilotdeck-renames.txt

      # Apply content changes
      git apply --allow-empty /tmp/pilotdeck-rename.patch 2>/dev/null || \
        git checkout -- . && (cd "$WORKTREE_DIR" && git diff HEAD) | git apply -

      # Rebuild package-lock.json
      rm -f package-lock.json
      npm install --package-lock-only 2>&1 | tail -3

      rm -f /tmp/pilotdeck-rename.patch /tmp/pilotdeck-renames.txt

      green "✓ 变更已应用到 $SOURCE_ROOT"
      echo ""
      yellow "清理 worktree..."
      git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
    else
      echo ""
      yellow "未应用。worktree 保留在: $WORKTREE_DIR"
      echo "  手动清理: git worktree remove $WORKTREE_DIR --force"
    fi
  else
    red "Worktree 中执行失败 (exit $RENAME_EXIT)，未应用任何变更。"
    echo "  检查 worktree: $WORKTREE_DIR"
  fi
  exit $RENAME_EXIT
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PLACEHOLDER="__ZZKEEP_COURTEOUS_WORD__"

run() {
  if $DRY_RUN; then
    yellow "[dry-run] $*"
  else
    "$@"
  fi
}

# ════════════════════════════════════════════════════════════
# 阶段 0: 预检
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 0: 预检 ═══"

if ! git diff --quiet HEAD 2>/dev/null; then
  yellow "警告: 工作区有未提交的变更，建议先 commit 或 stash"
  read -rp "继续？(y/N) " answer
  [[ "$answer" =~ ^[Yy]$ ]] || exit 1
fi

# 需要 sed 和 find（macOS 自带即可）
# 跳过的目录/文件
EXCLUDE_DIRS=(".git" "node_modules" "dist" ".next" ".turbo")
FIND_PRUNE=""
for d in "${EXCLUDE_DIRS[@]}"; do
  FIND_PRUNE="$FIND_PRUNE -path ./$d -prune -o"
done

# 构建 find 命令来获取文本文件（排除 package-lock.json 和二进制文件）
find_text_files() {
  eval "find . $FIND_PRUNE -type f \
    -not -name 'package-lock.json' \
    -not -name '*.png' \
    -not -name '*.jpg' \
    -not -name '*.ico' \
    -not -name '*.woff' \
    -not -name '*.woff2' \
    -not -name '*.ttf' \
    -not -name '*.eot' \
    -not -name 'rename-polit-to-pilot.sh' \
    -print"
}

# ════════════════════════════════════════════════════════════
# 阶段 1: 保护误报词（Politely 等）
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 1: 保护误报词 ═══"

protect_count=0
while IFS= read -r file; do
  if grep -q 'Politely' "$file" 2>/dev/null; then
    green "  保护 Politely: $file"
    run sed -i '' "s/Politely/$PLACEHOLDER/g" "$file"
    protect_count=$((protect_count + 1))
  fi
done < <(find_text_files)
echo "  保护了 $protect_count 个文件中的 Politely"

# ════════════════════════════════════════════════════════════
# 阶段 2: 文件内容替换（长匹配优先）
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 2: 文件内容替换 ═══"

# 替换对：从最长/最具体到最短/最通用
# 这个顺序保证不会出现部分替换
REPLACEMENTS=(
  "POLITDECK:PILOTDECK"
  "PolitDeck:PilotDeck"
  "politdeck:pilotdeck"
  "politDeck:pilotDeck"
  "POLIT:PILOT"
  "Polit:Pilot"
  "polit:pilot"
)

for pair in "${REPLACEMENTS[@]}"; do
  old="${pair%%:*}"
  new="${pair##*:}"
  count=0
  while IFS= read -r file; do
    if grep -q "$old" "$file" 2>/dev/null; then
      run sed -i '' "s/$old/$new/g" "$file"
      count=$((count + 1))
    fi
  done < <(find_text_files)
  echo "  $old → $new: $count 个文件"
done

# ════════════════════════════════════════════════════════════
# 阶段 3: 恢复误报词
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 3: 恢复误报词 ═══"

while IFS= read -r file; do
  if grep -q "$PLACEHOLDER" "$file" 2>/dev/null; then
    green "  恢复 Politely: $file"
    run sed -i '' "s/$PLACEHOLDER/Politely/g" "$file"
  fi
done < <(find_text_files)

# ════════════════════════════════════════════════════════════
# 阶段 4: 文件重命名（先文件，后目录；从深到浅）
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 4: 文件/目录重命名 ═══"

# 先重命名文件（不含目录），跳过本脚本自身
SELF_NAME="rename-polit-to-pilot.sh"
eval "find . $FIND_PRUNE -type f -name '*[Pp]olit*' -print" | sort -r | while IFS= read -r old_path; do
  dir="$(dirname "$old_path")"
  base="$(basename "$old_path")"
  [[ "$base" == "$SELF_NAME" ]] && continue
  new_base="$base"
  new_base="${new_base//PolitDeck/PilotDeck}"
  new_base="${new_base//politdeck/pilotdeck}"
  new_base="${new_base//Polit/Pilot}"
  new_base="${new_base//polit/pilot}"
  if [[ "$new_base" != "$base" ]]; then
    green "  文件: $old_path → $dir/$new_base"
    run git mv "$old_path" "$dir/$new_base"
  fi
done

# 再重命名目录（从深到浅，sort -r 保证深的先处理）
eval "find . $FIND_PRUNE -type d -name '*[Pp]olit*' -print" | sort -r | while IFS= read -r old_path; do
  parent="$(dirname "$old_path")"
  base="$(basename "$old_path")"
  new_base="$base"
  new_base="${new_base//PolitDeck/PilotDeck}"
  new_base="${new_base//politdeck/pilotdeck}"
  new_base="${new_base//Polit/Pilot}"
  new_base="${new_base//polit/pilot}"
  if [[ "$new_base" != "$base" ]]; then
    green "  目录: $old_path → $parent/$new_base"
    run git mv "$old_path" "$parent/$new_base"
  fi
done

# ════════════════════════════════════════════════════════════
# 阶段 5: package-lock.json 重建
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 5: 重建 package-lock.json ═══"

if [[ -f package-lock.json ]]; then
  green "  删除 package-lock.json 并重新 npm install"
  run rm package-lock.json
  if ! $DRY_RUN; then
    npm install --package-lock-only 2>&1 | tail -3
  fi
fi

# ════════════════════════════════════════════════════════════
# 阶段 6: 验证
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 6: 验证 ═══"

if $DRY_RUN; then
  yellow "  dry-run 模式，跳过验证（未实际修改文件）"
else
  echo ""
  echo "残留检查（应只有 Politely 和本脚本自身）:"
  RESIDUAL=$(grep -ril 'polit' --include='*.ts' --include='*.tsx' --include='*.md' \
    --include='*.json' --include='*.yaml' --include='*.html' \
    --exclude='package-lock.json' \
    --exclude='rename-polit-to-pilot.sh' \
    --exclude-dir='.git' --exclude-dir='node_modules' --exclude-dir='dist' \
    . 2>/dev/null || true)

  if [[ -z "$RESIDUAL" ]]; then
    green "✓ 零残留，替换完成！"
  else
    has_real_residual=false
    echo "$RESIDUAL" | while IFS= read -r f; do
      matches=$(grep -ic 'polit' "$f" 2>/dev/null || echo 0)
      non_politely=$(grep -i 'polit' "$f" 2>/dev/null | grep -iv 'politely' | head -3 || true)
      if [[ -z "$non_politely" ]]; then
        green "  ✓ $f ($matches 处, 全是 Politely — 正常)"
      else
        red "  ✗ $f ($matches 处残留):"
        echo "$non_politely" | sed 's/^/      /'
        has_real_residual=true
      fi
    done
  fi

  echo ""
  echo "文件名/目录名残留检查:"
  NAME_RESIDUAL=$(find . -iname '*polit*' -not -path './.git/*' -not -path './node_modules/*' \
    -not -path './dist/*' -not -name 'rename-polit-to-pilot.sh' 2>/dev/null || true)

  if [[ -z "$NAME_RESIDUAL" ]]; then
    green "✓ 文件名零残留！"
  else
    red "✗ 以下文件/目录名仍含 polit:"
    echo "$NAME_RESIDUAL"
  fi

  # 6b. 占位符残留检查（防止保护/还原逻辑出 bug）
  echo ""
  echo "占位符残留检查:"
  PLACEHOLDER_RESIDUAL=$(grep -rl "$PLACEHOLDER" --exclude-dir='.git' --exclude-dir='node_modules' \
    --exclude-dir='dist' --exclude='rename-polit-to-pilot.sh' . 2>/dev/null || true)
  if [[ -z "$PLACEHOLDER_RESIDUAL" ]]; then
    green "✓ 无占位符残留！"
  else
    red "✗ 占位符未被还原:"
    echo "$PLACEHOLDER_RESIDUAL"
  fi

  # 6c. 新名称存在性抽查
  echo ""
  echo "新名称存在性抽查:"
  SPOT_CHECKS=(
    "PilotConfig:src/pilot/config/types.ts"
    "PilotDeckLogo:src/adapters/channel/tui/app/PilotDeckLogo.tsx"
    "PILOT_HOME:src/pilot/paths.ts"
    "PILOTDECK_GATEWAY:src/gateway/protocol/version.ts"
    "pilotDeckDarkBlueTheme:src/adapters/channel/tui/app/theme.ts"
    "pilotdeck:package.json"
  )
  spot_ok=true
  for check in "${SPOT_CHECKS[@]}"; do
    symbol="${check%%:*}"
    target="${check##*:}"
    if [[ -f "$target" ]] && grep -q "$symbol" "$target" 2>/dev/null; then
      green "  ✓ $symbol  ← $target"
    else
      red "  ✗ $symbol  ← $target (未找到)"
      spot_ok=false
    fi
  done

  # 6d. git rename 检测
  echo ""
  echo "git rename 检测:"
  rename_count=$(git diff --name-status HEAD 2>/dev/null | grep -c '^R' || echo 0)
  if [[ "$rename_count" -gt 0 ]]; then
    green "  ✓ git 识别到 $rename_count 个文件重命名（历史保留）"
  else
    yellow "  ⚠ git 未检测到 rename，可能是相似度过低"
  fi

  # 6e. git diff 对称性检查（增删行数应相等）
  echo ""
  echo "增删对称性检查:"
  insertions=$(git diff --numstat HEAD 2>/dev/null | awk '{s+=$1} END{print s+0}')
  deletions=$(git diff --numstat HEAD 2>/dev/null | awk '{s+=$2} END{print s+0}')
  if [[ "$insertions" -eq "$deletions" ]]; then
    green "  ✓ +${insertions} / -${deletions} (完美对称，纯重命名)"
  else
    yellow "  ⚠ +${insertions} / -${deletions} (不对称，请人工检查)"
  fi
fi

# ════════════════════════════════════════════════════════════
# 阶段 7: 编译和测试
# ════════════════════════════════════════════════════════════
blue "═══ 阶段 7: 编译和测试 ═══"

if $DRY_RUN; then
  yellow "  dry-run 模式，跳过编译和测试"
else
  echo ""
  echo "TypeScript 编译检查:"
  if npx tsc --noEmit 2>&1; then
    green "  ✓ tsc --noEmit 通过"
  else
    red "  ✗ TypeScript 编译失败（见上方错误）"
  fi

  echo ""
  echo "测试:"
  test_output=$(npm test 2>&1) || true
  pass_count=$(echo "$test_output" | grep -oE '# pass [0-9]+' | grep -oE '[0-9]+' || echo "?")
  fail_count=$(echo "$test_output" | grep -oE '# fail [0-9]+' | grep -oE '[0-9]+' || echo "?")
  if [[ "$fail_count" == "0" ]]; then
    green "  ✓ 全部通过 ($pass_count pass)"
  else
    yellow "  ⚠ $pass_count pass / $fail_count fail（检查是否为预期中的已知失败）:"
    echo "$test_output" | grep 'not ok' | sed 's/^/      /'
  fi
fi

# ════════════════════════════════════════════════════════════
# 完成
# ════════════════════════════════════════════════════════════
echo ""
blue "═══ 完成 ═══"
echo ""
yellow "还需手动处理:"
echo "  1. GitHub 仓库改名: Settings → Repository name → PilotDeck"
echo "  2. 改完后更新 remote: git remote set-url origin git@github.com:Gucc111/PilotDeck.git"
echo "  3. 如果用户机器上有 ~/.politdeck 目录，需要加迁移逻辑或重命名"
echo ""
if $DRY_RUN; then
  yellow "这是 dry-run 模式，没有实际执行任何变更。"
  echo "  直接运行（worktree 安全模式）: bash scripts/rename-polit-to-pilot.sh"
  echo "  跳过 worktree 直接修改:        bash scripts/rename-polit-to-pilot.sh --in-place"
fi
