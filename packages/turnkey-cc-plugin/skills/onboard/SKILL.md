---
name: turnkey:onboard
description: Phase 0 of turnkey workflow — codebase 体检 + 三盲基线扫描. 给一个 30 分钟内可完成的"我现在站在哪"的快照, 包含技术栈识别 / 测试入口 / lint 配置 / 关键 entry point / 最近变更热区 / convention 信号清单. 不做需求理解, 不写代码. 触发: turnkey 主 skill 路由到 onboard, 或用户直接调用 /turnkey:onboard.
---

# turnkey-onboard — 阶段 0

> 目的：给 junior 一个**可信的代码库快照**，让后续 clarify / design 不至于撞 convention-blindness。
> 时间预算：≤ 30 分钟（机器跑 + junior 看摘要）

## Context Inputs

> 见 `CONTEXT-PROTOCOL.md`。这是 funnel 的第 0 阶段，几乎没有 prior artifact——只读 runlog + ticket text。

| # | path | 为什么 |
|---|------|--------|
| 1 | `~/.turnkey/runlog.json` | `ticket_id` / `raw_ticket_text` / `current_stage` / `context_budget.level` |
| 2 | (none — 这是第一阶段) | — |

**Budget pre-flight**：onboard 阶段 budget 通常仍是 `green`，因为是第一阶段。如果发现 ≥ `yellow`（例：resume 已超大的 ticket），**先**回主 `turnkey/SKILL.md` Phase 0.5 处理，再开始本阶段。**不要**回滚 chat scrollback 重新读 ticket 文本——直接读 runlog 的 `raw_ticket_text` 字段。

## Phase 1: 技术栈识别（machine-driven，junior 不用看）

```bash
cd $(pwd)  # cursor 的 workspace root
TICKET_ID="$(jq -r .ticket_id ~/.turnkey/runlog.json)"
OUT="${HOME}/.turnkey/artifacts/${TICKET_ID}/00-onboard-summary.md"
mkdir -p "$(dirname "${OUT}")"

# 检测语言 / 包管理 / 框架
ls -la                                          # 看根目录文件
[[ -f package.json ]] && cat package.json | jq '{name,scripts,deps:.dependencies|keys}'
[[ -f pyproject.toml ]] && head -50 pyproject.toml
[[ -f Cargo.toml ]] && head -30 Cargo.toml
[[ -f go.mod ]] && head go.mod
[[ -f Gemfile ]] && head Gemfile
[[ -f composer.json ]] && head composer.json
[[ -f pom.xml ]] && head -50 pom.xml

# 测试入口
ls test/ tests/ __tests__/ spec/ 2>/dev/null
grep -l "test\|jest\|vitest\|pytest\|rspec\|go test" package.json pyproject.toml 2>/dev/null

# CI 配置
ls .github/workflows/ .gitlab-ci.yml .circleci/ Jenkinsfile 2>/dev/null

# Lint 配置
ls .eslintrc* .prettierrc* ruff.toml .rubocop.yml golangci.yml 2>/dev/null
```

把识别结果写进 `${OUT}` 的 §技术栈 段。

## Phase 2: 入口 & 拓扑（machine-driven）

```bash
# 找 main / index / app / cmd 文件
find . -maxdepth 3 -type f \
  \( -name "main.*" -o -name "index.*" -o -name "app.*" -o -name "cli.*" -o -name "server.*" \) \
  ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" \
  | head -20

# 找 README / CONTRIBUTING / CHANGELOG
ls README* CONTRIBUTING* CHANGELOG* CLAUDE* AGENTS* 2>/dev/null

# 模块切分（heuristic）
find . -maxdepth 2 -type d ! -path "*/node_modules*" ! -path "*/.git*" \
  ! -path "*/dist*" ! -path "*/build*" ! -path "*/__pycache__*" | head -30
```

把入口和模块清单写进 `${OUT}` 的 §拓扑 段。

## Phase 3: 最近变更热区（context-blindness 的 antidote）

```bash
# 最近 50 个 commit 触动了哪些文件，按文件出现频率排
git log --pretty=format: --name-only -50 \
  | grep -v '^$' | sort | uniq -c | sort -rn | head -20

# 最近 30 天的 contributor
git shortlog -sne --since="30 days ago" | head -10

# 看 ticket 文本里提到的关键词在 codebase 里的分布
TICKET_TEXT="$(jq -r .ticket_text ~/.turnkey/runlog.json)"
# 从 ticket 抽 3-5 个名词性 keyword（你 agent 自己判断），分别 grep
```

把热区文件 / 活跃 contributor / 关键词命中写进 `${OUT}` 的 §最近变更 段。

## Phase 4: 三盲基线扫描

针对 `assumptions/baseline-v2.md` B-05 的三类盲点，**每类至少抓 1 条 signal** 写进 `${OUT}`：

### convention-blindness signals

- 看 .editorconfig / lint config，把里面的"非默认"配置列出来（例：行长 100 而不是 80、引号是单引号、import 顺序自定义）
- 看任何一个最近的 PR 模板 / CODEOWNERS / commit message convention（conventional commits？）
- 看测试目录的命名约定（`test_*.py` vs `*_test.py` vs `*.spec.ts`）

→ 把"如果 junior 不知道这些，他几乎一定会被 review 打回"的清单写出来。

### trust-blindness signals

- 看代码库里有没有"AI 生成代码痕迹但写错了"的例子（注释里有 TODO from AI、或函数命名特别 generic 例如 `processData`）
- 列出本 ticket 涉及的 API / 库版本 —— 如果是小众库或近期改 API 的库，agent **几乎一定**会写过时的用法
- 标出 codebase 里的 `eslint-disable` / `# noqa` / `// @ts-ignore` 集中区——这些是"前人也搞不定"的高风险地

→ 写出"在 develop 阶段对这些区域的 AI 输出要二次校验"的标记。

### context-blindness signals

- 看 ticket 涉及的核心模块/接口，最近 3 次改动是谁、commit message 写了什么
- 如果 commit message 提到 "fix"/"revert"/"hotfix"，**优先**抓出来——这是业务历史的爆点
- 看相关测试文件的最近改动（测试用例往往隐含业务规则）

→ 写出"在 design 阶段必须 ask senior or read these PRs"的清单。

## Phase 5: 体检报告输出

最终 `${OUT}` 的结构（用 `templates/onboard-summary.md` 作模板）：

```markdown
# Onboard Summary — ticket <ticket_id>

## 技术栈
- 语言: ...
- 包管理: ...
- 测试框架: ...
- CI: ...
- Lint: ...

## 入口 & 拓扑
- main entry: ...
- modules: ...
- doc files: ...

## 最近变更热区
- top 5 changed files (last 50 commits): ...
- active contributors: ...
- ticket keyword hits: ...

## 三盲扫描
### convention-blindness signals (N 条)
- ...

### trust-blindness signals (N 条)
- ...

### context-blindness signals (N 条)
- ...

## 给 clarify 阶段的输入
（从上述信号里挑出来 3-5 条"junior 必须先回答的问题"，传递给 turnkey-clarify）
```

## Phase 6: 写 inbox + 推进 stage

```bash
# 写一条 stage_exit 信号
node -e '
const fs = require("fs");
const line = JSON.stringify({
  ts: new Date().toISOString(),
  type: "stage_exit",
  stage: "onboard",
  data: {
    artifact: process.env.OUT,
    convention_signals_count: parseInt(process.env.CV || "0", 10),
    trust_signals_count: parseInt(process.env.TR || "0", 10),
    context_signals_count: parseInt(process.env.CT || "0", 10)
  }
}) + "\n";
fs.appendFileSync(`${process.env.HOME}/.turnkey/inbox.jsonl`, line);
'

# 把 runlog.current_stage 推进到 clarify
# 用 jq 或者 node 改 runlog.json
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.turnkey/runlog.json`;
const r = JSON.parse(fs.readFileSync(path, "utf8"));
r.funnel.onboard.status = "done";
r.funnel.onboard.ended = new Date().toISOString();
r.funnel.onboard.artifacts = [process.env.OUT];
r.current_stage = "clarify";
fs.writeFileSync(path, JSON.stringify(r, null, 2));
'
```

回到主 turnkey/SKILL.md 的 Phase 2 让 stage-gate 判定。

## 不要做

- ❌ 不要在这个阶段读 ticket **之外**的需求（不要去问 senior 业务，那是 clarify 阶段的事）
- ❌ 不要写代码（哪怕看起来 ticket 很小）
- ❌ 不要触碰 git / 文件修改（这阶段是只读的）
- ❌ 不要假装看完了——任何"我已检查"的声明必须有对应 grep/find 输出贴进 artifact

## 三盲扫描钩子（给 R1/R2 研究用）

每条 signal 都要带 `evidence`（命令 + 输出片段），写到 `runlog.json.three_blindness_scan` 对应数组。
