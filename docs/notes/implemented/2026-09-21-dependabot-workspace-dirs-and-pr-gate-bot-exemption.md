# Agent Note: dependabot 重复目录与 PR 可追溯门禁的 bot 豁免

Status: implemented

## Problem

2026-09-21 的 dependabot 周更一次性开出 10 个 npm PR，其中 7 个 CI 失败。逐条核下去，
失败**不是**依赖本身有问题，而是两个上游配置/判据缺陷：

**缺陷 1：pnpm workspace 下重复配置目录，同一依赖被开两单。**
`.github/dependabot.yml` 的 npm 条目用 `directories: ["/", "/ui", "/apps/desktop",
"/src/context/memory/edgeclaw-memory-core"]`。本仓是 pnpm workspace，**全仓只有一个
`pnpm-lock.yaml`，位于仓库根**。工作区根（`/`）这一条已经覆盖全部子包——
证据有三类：

- `#305` / `#484` / `#482` / `#485`（`/` 条目产出）都同时改了 `<子包>/package.json` 与
  根 `pnpm-lock.yaml`，且覆盖 ui 的 devDependencies（`jsdom`、`typescript`）；
- `#225` 只改 `apps/desktop/package.json` + 根 lockfile，而 `electron` **仅**声明在
  `apps/desktop/package.json` 里 ⇒ `/` 确实管到 `apps/desktop`；
- 子目录那一单（`/ui`）**只改 `ui/package.json`、从不带根 lockfile 更新** ⇒
  `pnpm install --frozen-lockfile` 必然 `ERR_PNPM_OUTDATED_LOCKFILE`。

统计上 11/11 一致：本轮开放的 `#487/#488/#489/#490`，加上历史已关闭的
`#309/#310/#311/#312`、`#231`、`#266`、`#268`，**全部只改 `ui/package.json`**；
而它们在 `/` 下的孪生兄弟（`#484/#482/#486/#485`、`#305/#308/#304`、`#262/#261`…）
都带 lockfile 并已合并。即每周固定产出约 4 个注定失败、只能手工关闭的 PR，
且 `#267` 那条是靠人工往 bot 分支补 lockfile 提交才合进去的。两个 CI job
（`Typecheck, Lint & Test` 与 `Desktop (Windows) build & lint`）都在 install 步就死。

**缺陷 2：univer 全家桶被逐包升级 ⇒ 混版假阳性。**
`ui/package.json` 里 13 个 `@univerjs/*` 全部锁死 `0.25.1`，其类型通过**跨包 interface
augmentation** 合并。`#482`（`@univerjs/core`）与 `#486`（`@univerjs/sheets-ui`）各只升一个包到
`0.25.2`，造出混版树 ⇒ `Property 'createWorkbook' does not exist on type 'FUniver'`、
`typeof UniverSheetsUIPlugin is not assignable to PluginCtor<Plugin>` 等 10+ 个
TS2339/TS2345，**全部是版本混合的产物，不是 0.25.2 的真实破坏性变更**（见 Decision 第 4 条实测）。

**缺陷 3：PR 可追溯门禁对 bot PR 的判定非确定性。**
`.github/scripts/check-pr-issue.mjs` 的第 2 条「裸引用」路径（`#123`）在 bot 生成、正文为上游
changelog 转述的 PR 上纯属撞运气：同一轮里
`#490`（`ws`，release notes 不含 `#编号`）判**失败**，
`#487`（`react-router-dom`，changelog 里恰好带 `#15498`）判**通过**。
判定结果本应与「PR 有无需求来源」无关。

> 载体：issue #491。

## Decision

1. **npm 条目只留工作区根 `"/"`**，删掉 `/ui`、`/apps/desktop`、
   `/src/context/memory/edgeclaw-memory-core` 三个重复条目（工作区根已全覆盖）。
2. **给 `@univerjs/*` 加 `groups`**，同一轮的所有 univer 升级进同一个 PR，结构性保证同版；
   同时把 `open-pull-requests-limit` 设为 10，使合并四个条目后同时开放的 PR 数不退。
3. **门禁新增第 5 条路径 `bot`**：作者命中 `^(?:dependabot|renovate(?:-preview)?)\[bot\]$`
   时直接放行。豁免面只开给 GitHub App 身份（**必须**以 `[bot]` 结尾），
   `dependabot-fan` 这类人类昵称照常判失败。`ci.yml` 注入
   `PR_AUTHOR: ${{ github.event.pull_request.user.login }}`。
4. **实测「全量同版升级」可行性**：把 13 个 `@univerjs/*` 一起升到 `0.25.2` 后，
   `ui` 的 `tsc --noEmit` **零错误**、`vitest run` 976/976 通过 ⇒ 反证 `#482/#486` 的红
   纯由混版造成，分组配置即为充分修复。
5. **判据落在单测里**：`check-pr-issue.test.mjs` 新增 6 例（3 正 3 负），
   用例 body 直接取自本轮真实 PR 文本（`#490` 的无 `#编号` 形态与 `#487` 的带 `#15498` 形态），
   并断言两者**走同一条 `bot` 路径**——把「判定不随上游 changelog 写法摆动」钉成判据。

## Alternatives considered

- **保留子目录条目，改为在 CI 里自动补 lockfile**（如加一步 `pnpm install --no-frozen-lockfile`
  或 bot 提交 lockfile）— 落选：那等于把「manifest 与 lockfile 不同步」这一真实错误信号
  关掉，且锁文件由谁写的语义变模糊；而重复条目本身没有任何收益（工作区根已覆盖）。
- **把 `@univerjs/*` 整个加进 `ignore`**（永不自动升级）— 落选：`0.25.2` 修的是
  drawing/formula maps 的原型污染，属安全修复，直接弃升不划算；分组能拿到修复而不引入混版。
- **让门禁接受 bot PR 正文里的任意 `#编号`**（即维持现状、不区分作者）— 落选：那正是
  非确定性的来源；且「上游 changelog 提到某个 issue」与「本 PR 可回溯到本仓需求」是两件事。
- **把门禁改成必需检查（required status check）** — 落选：本 PR 只修判据本身。
  是否提升为必需项属于仓库治理决策，与「修误判」无关，不夹带。
- **按正文形态识别 bot PR（而非作者身份）** — 落选：正文形态可被任何人复制，
  等于给所有 PR 开一个「粘贴 changelog 即免检」的口子；作者身份不可伪造。

## Consequences

- 每周消失约 4 个注定失败、需人工关闭的重复 PR（按 2026-09-14 与 09-21 两轮观察），
  同时省下它们各自 3 个 CI job 的消耗。
- `@univerjs/*` 的升级从此只能整组落地；代价是若某次只有部分包能升，需要人工介入
  （而这正是期望行为——混版必然类型报错）。
- 门禁对 bot 的放行是**按作者身份**的显式豁免，不再依赖 PR 正文内容；人类 PR 的判定完全不变。
- 剩余的 `#482/#486/#488/#489` 四个 PR 由本 PR 之后的依赖升级 PR 取代，
  关闭时在 PR 上留结论指向替代交付物。
