# Walkthrough — turnkey on the "docs search" ticket

> 这是 `examples/ticket-add-search.md` 那个 ticket 的**完整剧本**。每一步都标了：
> - 谁在说话（junior / agent / hook）
> - 哪个 skill 在驱动
> - 写出了什么文件
> - 三盲信号是否被捕捉
>
> 用途：让你**预演**一遍 turnkey 不靠想象。读完就大致知道这套东西在 cursor 里 feels like 什么。

---

## T+0:00 · ticket 进入

**junior** 在 cursor agent chat：
```
/turnkey 我们的 docs 站 ... [完整 ticket 文本]
```

**agent** (turnkey 主 skill, Phase 1 bootstrap)：
```
ok, 我把这条作为 ticket "tk-20260420-add-docs-search"。
写入 ~/.turnkey/runlog.json, 进入 onboard 阶段。
```

**hook** (turnkey-capture.js, beforeSubmitPrompt)：
- inbox.jsonl 追加：
  ```json
  {"ts":"...","type":"cursor_hook","event":"beforeSubmitPrompt","payload":{...}}
  ```

---

## T+0:30 · onboard 阶段（turnkey-onboard）

**agent** 跑：
```bash
ls / cat package.json / find docs/ -type f -name "*.md" | head
git log --since="30 days ago" -- docs/ | head -30
git log --since="30 days ago" --pretty=format:"%h %s" | head -10
cat docs/.vitepress/config.* 2>/dev/null
```

**agent** 抽到：
- 包管理：pnpm (有 `pnpm-lock.yaml`)
- docs 框架：vitepress 1.x
- lint 命令：`pnpm lint`
- test 命令：（项目无 test 配置）
- build 命令：`pnpm docs:build`
- 近 30 天 docs/ 触动文件：6 个，hot zone = `docs/guide/*`

**agent** 三盲扫描：
- ⚠️ convention-blindness signal: `docs/.vitepress/config.ts` 用 TS（不是常见的 .js）
- ⚠️ context-blindness signal: 仓库根 `.github/workflows/docs.yml` 显示 main push 触发自动 deploy 到 GitHub Pages（junior 可能不知道）

**agent** 写：`~/.turnkey/artifacts/tk-20260420-add-docs-search/00-onboard-summary.md`

**agent** print：
```
onboard 完成。重点：
- vitepress 1.x，配置在 docs/.vitepress/config.ts
- main push 自动 deploy GitHub Pages（你的 ticket 提到"不要急上线"——这跟自动 deploy 矛盾，clarify 阶段会问）
- 没有 test 套件
继续到 clarify？(y/n)
```

**junior**：`y`

---

## T+2:30 · clarify 阶段（turnkey-clarify）

**agent** 走 junior-questions-v0 模板，自答 / 兜底：

| Q | agent self-answer | 行动 |
|-|-|-|
| Q1 改哪些文件？ | `docs/.vitepress/config.ts` 改 1 处。high confidence | skip |
| Q2 跑入口看看？ | "我猜入口就是 docs 网站。请你跑 `pnpm docs:dev` 然后访问 localhost:5173, 告诉我搜索栏是不是真的没有" | **junior 必须跑** |
| Q3 consumer 是谁？ | grep `docs/.vitepress/config.ts` 没人 import；它是 vitepress 直接消费的。high confidence | skip |
| Q4 应该不动的？ | `.github/workflows/docs.yml`（自动 deploy）；`docs/CHANGELOG.md`（如有 owner）。medium confidence | "我建议这次不动 .github/workflows/，对吗？" |
| Q5 success 标准？ | 不能自答 → 给 4 选项 | junior 选 (a) "用户能看到搜框 + 输入'install'命中安装指南页" |
| Q6 epic-sized？ | 改 1 个配置文件 1 行——绝对不是 epic | skip |
| Q7 工作流？ | 默认推荐 (a) 直接写代码（改动太小不值得 spec/TDD） | junior 选 (a) |

**junior** 跑了 `pnpm docs:dev`，回报"对，搜框确实没有"。

**agent 触发的关键二问**：
> ⚠️ ticket 提到"下周一 review、下周二跟 owner sync"，但是 main push 会自动 deploy。如果你周一 PR merge → 周二张师傅看到的就是已经上线的。
> 你想：
>   (a) PR draft 状态留到下周二张师傅 sync 后才 ready-for-review/merge
>   (b) 跟张师傅在 design 阶段先 async 一下（我可以帮你打 senior packet）
>   (c) 你觉得"自动 deploy 也没关系"，按原计划

**junior** 选 (a) + (b) 都做。

**agent** 写：`01-clarify-summary.md`

---

## T+5:00 · design 阶段（turnkey-design）

**agent** 给 3 个 option：

### Option A: vitepress local search
- 改 `themeConfig.search.provider = 'local'` 一行
- pros: 0 deps、官方支持、build 时索引
- cons: 大库性能差（docs 不大，无所谓）
- 信心：high
- 估时：15 min

### Option B: Algolia DocSearch
- 注册申请、放 API key、改配置
- pros: 模糊匹配最好
- cons: 申请审批 ≥ 1 周（这周五前 PR draft 不可能）
- 信心：medium（不知道 docs 站的 owner 愿不愿意接 saas）
- 估时：1 周（含 algolia 申请）

### Option C: 自写 lunr.js
- pros: 全控
- cons: 至少 0.5 天写、未来要维护
- 估时：1 day

**agent** 推荐：A（满足 success criteria + 在 deadline 内 + 0 cost）

**junior** 选 A。

**agent**：
> 因为你选了"design 阶段先跟张师傅 async"，我帮你打了一份 senior packet：
> `02-senior-async-review.md`（≤ 200 字，附 design doc 链接）
> 你想怎么发给张师傅？
>   (a) 我打开邮件 / 飞书草稿
>   (b) 我只生成内容，你自己 copy 发
>   (c) 跳过（直接写代码）

**junior** 选 (b)。**agent** 写 packet 内容到 stdout。

**agent** 写 `02-design-doc.md` + `02-senior-async-review.md`。

**agent**：`已完成 design。spec/tdd 你刚选 skip，所以直接进 develop？(y/n)`
**junior**：`y`

---

## T+8:00 · develop 阶段（turnkey-develop）

**agent**：
```bash
git checkout -b feat/turnkey-add-docs-search
```

**agent** 拆 1 个 micro-step：
- step 1: 在 `docs/.vitepress/config.ts` `themeConfig` 下加 `search: { provider: 'local' }`

**agent** 写代码（3 行 diff，含格式化空行）。
**agent** 跑 `pnpm lint` ✅、`pnpm docs:build` ✅。

**agent** trust-check：
- "我加的 key 名是 `themeConfig.search.provider`。我刚刚 grep 了 vitepress node_modules，confirm key 名正确（不是 `themeConfig.localSearch` 等 hallucination）。同时 build 跑过了，dist/ 里能搜到 search 索引文件。"

**agent**:
```bash
git add docs/.vitepress/config.ts
git status
git diff --cached --stat
git commit -m "feat(docs): enable vitepress local search (turnkey tk-20260420-add-docs-search)"
```

**agent** 写 `05-develop-log.md`。

---

## T+10:00 · test 阶段（turnkey-test）

**agent**：
- lint ✅
- type N/A
- unit N/A
- build ✅（产出 search index 文件）
- e2e N/A

**agent** 提示：
> ⚠️ 项目没有 test 套件。建议**手工** smoke test：
> `pnpm docs:dev` → 访问 localhost:5173 → 搜 "install" → 应该命中安装页
> 你跑一下，告诉我结果

**junior** 跑了，回："命中了"。

**agent** 写 `06-test-report.md`，标记 manual smoke pass。

---

## T+12:00 · review 阶段（turnkey-review）

**agent** 跑 PR self-review checklist：
- diff size: 3 行 ✅
- 没 secret ✅
- 没 debug 残留 ✅
- 在 design 范围内 ✅
- commit message 符合 conventional commits ✅
- senior async packet 状态：未回（junior 还没发 / 还没回）⚠️

**agent**:
> senior async packet **没回**。给你的选择：
>  (a) 现在发给张师傅（我把内容贴一遍）
>  (b) PR 推 draft 状态先（GitHub auto-deploy 不会跑——因为不是 main 上的 commit）
>  (c) 等张师傅周二再继续

**junior** 选 (a) + (b)。

**agent** 写 `07-pr-package.md`，问 push 选项。**junior** 选 "(b) agent 帮我 push origin <branch>"。

**agent**：
```bash
git push -u origin feat/turnkey-add-docs-search
```

**agent** 提示：
> push done. branch URL: https://github.com/.../tree/feat/turnkey-add-docs-search
> PR 你自己开（用 07-pr-package.md 的内容当 description）。开成 draft。

---

## T+13:00 · ship 阶段（turnkey-ship）

**agent** 检测：
- CI: `.github/workflows/docs.yml`
- 平台: GitHub Pages auto-deploy on main push
- auto-deploy: ✅

**agent** 写 `08-ship-checklist.md`：
- pre-merge: 等张师傅 approve、CI 绿
- merge: squash + delete branch
- post-merge: GitHub Actions 自动 build + deploy（~3 min）
- post-deploy smoke: visit live docs site, 搜 "install"
- 7d watch: 看 docs/ 是否被 hotfix 触动

**agent** 问 7d watch 选项。**junior** 选 "(d) 啥也不做"。

**agent** 写 `08-outcome-funnel.json`：
```json
{
  "ticket_id": "tk-20260420-add-docs-search",
  "outcome_funnel": {
    "stage_1_local_works": {"status":"pass","evidence":["...06-test-report.md"]},
    "stage_2_ci_passes":   {"status":"pending"},
    "stage_3_senior_review":{"status":"pending — async packet sent, no reply yet"},
    "stage_4_merge":        {"status":"pending"},
    "stage_5_no_regression_7d":{"status":"watching"}
  }
}
```

**agent** print closeout：
```
turnkey ticket tk-20260420-add-docs-search COMPLETE
funnel: onboard ✓ clarify ✓ design ✓ develop ✓ test ✓ review ✓ ship ✓
artifacts: ~/.turnkey/artifacts/tk-20260420-add-docs-search/
PR: https://github.com/.../tree/feat/turnkey-add-docs-search (draft, awaiting senior)
```

---

## 三盲信号最终统计（写到 inbox.jsonl）

- **convention-blindness**: 1 (vitepress 用 TS 而非 JS 配置)
- **trust-blindness**: 1 (`themeConfig.search.provider` key 名 — 已通过 grep + build 校验)
- **context-blindness**: 1 (auto-deploy on main — 已在 clarify 阶段触发关键二问 + ship checklist 强调)

---

## 这个 walkthrough 暴露的设计 hole（candidate findings）

> 写到这里是为了告诉你：跑过一个 example 后才会冒出来的真实问题。这些是未来 R1/R2 研究的输入。

1. **没有 test 套件的 repo 怎么办**：手工 smoke 没法被 CI gate，turnkey-test 阶段需要新 sub-flow。candidate finding F-?-no-test-suite-fallback。
2. **draft PR 的 ship 阶段是不是太早**：这次 PR 是 draft 状态就跑了 ship checklist，但 outcome funnel 的 merge / 7d-watch 都跑不动。candidate refactor：ship 阶段是不是该等 PR ready-for-review？
3. **senior async packet 的发送通道**：agent 只能"打包内容"，发邮件 / 飞书 / slack 还是 junior 手动。是否要 v0.2 接 outlook / lark CLI？看真实 demand。
