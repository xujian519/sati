# Example Ticket — "给 docs 站加搜索"

> 这是一个**虚构**但**真实可触发**的 turnkey 流程示例。junior 把下面这段话粘进 cursor agent chat（前面加 `/turnkey`），就能跑出完整的 8 阶段 funnel。
>
> 用途：让你看 turnkey 在一个具体小 ticket 上长什么样，**不**是要你去跑这个真的 ticket。

---

## ticket 文本（junior 收到的原话）

> 我们的 docs 站 (`docs/` 目录, 用 vitepress 跑) 现在没搜索, 用户找东西很痛. 你看看能不能加个搜索框, 客户端搜索就行, 不要做后端.
>
> deadline: 这周五前 PR draft 出来即可, 下周一 review.
>
> 我下周二会去找 owner 张师傅 sync 一下技术方向, 你 PR 出来就行, 不用太着急上线.

## 怎么 invoke turnkey

junior 在 cursor agent chat 里输入：

```
/turnkey 我们的 docs 站 (docs/ 目录, 用 vitepress 跑) 现在没搜索, 用户找东西很痛. 你看看能不能加个搜索框, 客户端搜索就行, 不要做后端. deadline: 周五前 PR draft 出来即可, 下周一 review. 我下周二会去找 owner 张师傅 sync 一下技术方向, 你 PR 出来就行, 不用太着急上线.
```

agent 会：

1. **bootstrap ticket**——assign id `tk-20260420-add-docs-search`、写 `~/.turnkey/runlog.json`、append `ticket_bootstrap` 行到 inbox
2. **进入 onboard**（由 turnkey 主 skill 路由到 turnkey-onboard）

## 各阶段会发生什么（剧本预演）

详见 `walkthrough.md`，下面是浓缩版：

| stage | agent 会问 / 做的关键事 | 大概产出 |
|-|-|-|
| onboard | grep 出 vitepress 配置、看 `docs/.vitepress/config.ts`、抽 lint/test/build 命令、扫近 30 天 docs/ 改动 | `00-onboard-summary.md` |
| clarify | 套 junior-questions-v0：Q1 (改 docs/) → 自答；Q2 (跑入口看看) → 让 junior 真跑 `pnpm docs:dev`；Q5 success → "搜框出现 + 输入命中标题" | `01-clarify-summary.md` |
| design | 给 3 个候选：(A) `vitepress` 自带 `local search`、(B) algolia docsearch、(C) 自己写 lunr.js | `02-design-doc.md` |
| (junior 选 A — 最快、不要 backend) | | |
| spec | 跳过（junior 没选 spec-driven） | — |
| tdd | 跳过（小改动，不写 TDD plan） | — |
| develop | 改 `docs/.vitepress/config.ts` 一处 enable `themeConfig.search.provider = 'local'`、跑 build、看结果 | `05-develop-log.md` + 1 atomic commit |
| test | 跑 `pnpm build` + 手工 visit `localhost:5173` 测搜索 | `06-test-report.md` |
| review | 自审 diff (3 行 +) → 生成 PR description | `07-pr-package.md` |
| ship | 生成 ship checklist（vitepress 没有 deploy step；docs 站 push 到 main 触发 GitHub Pages 自动 build） | `08-ship-checklist.md` + outcome funnel |

## 为什么挑这个 ticket 做 example

- **小**：3 行改动，能让你在 ~10 分钟跑完整个 funnel，看到所有 8 个 artifact 都长什么样
- **真**：vitepress local search 是真实存在的 feature，不是凭空例子
- **碰得到三盲**：
  - convention-blindness：vitepress 配置文件的命名/位置 junior 容易猜错
  - trust-blindness：agent 可能 hallucinate 配置 key 名（应该跑 build 校验）
  - context-blindness：docs 站可能有 GitHub Pages 自动 deploy，junior 不知道 push main 就会自动上线
- **覆盖 senior 异步通道**：ticket 文本明确 junior 下周二才能跟 owner sync，design 阶段会自动生成 senior async packet
