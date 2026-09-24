# Agent Note: 插件信任门整树哈希的报告路径 memo + `blocked` 原因结构化（#538）

Status: implemented

## Problem

`docs/open-issues-remediation-plan.md` §3.6 ② 的 `#538`（TD-EXTENSION-N07）。两个面：

1. **性能面（issue 主诉）**：`evaluateProjectHookTrust` 对每个声明 hook 的项目插件调
   `computeHookBundleDigest`——把插件目录整棵树 `readdir` + `stat` + `readFile` 后逐字节
   sha256，**无任何缓存**。实测 **166–189ms/次**（1990 文件 / 7.96 MB），而它落在
   `ProjectRuntimeRegistry.resolveTrustedHookSettings`（`:571`）这条**新会话装配的关键路径**
   上被 `await`；同一进程内重复评估（再开会话、再开面板）也毫无加速。
2. **功能死角面**：上限 `HOOK_BUNDLE_MAX_FILES=2000` / `HOOK_BUNDLE_MAX_BYTES=8MiB` 一旦
   越过即 `blocked`，而 `blocked` 在 `hookTrustService.decide`（`:124`）被拒 ⇒ 带
   `node_modules/`、`.git/` 的插件（clone 安装的常态）**永远无法授权**，且用户只看到一个
   笼统的 `blocked`，无从判断是「太大」还是「内容不安全」，也就无从处置。

「信任单位 = 整树内容摘要」「超限即 blocked、不留静默通过路径」是 hook 信任门 1.2a/1.2b
的既有决策（`hookBundleDigest.ts` 头注 + `docs/notes/implemented/2026-09-21-project-hook-trust-gate.md`），
本条**不改这两点**。「同一份内容在同一进程里被哈希 N 遍」无任何文档依据，属遗漏；`blocked`
那条是既有决策的副作用未被识别为功能死角。

## Decision

### ① memo **只**落在报告/面板的可见性路径，强制路径继续用纯内容哈希

这是本条最关键、且**刻意偏离 plan 字面**的决定。plan §3.6 line 322 的措辞是「memo +
`decide` 路径绕过 memo 重算」，把「会话装配」与「面板 list」一并当成可 memo 的读路径。
但实测代码后判定：**会话装配不是读路径，是强制路径**——

- `ProjectRuntimeRegistry.resolveTrustedHookSettings`（`:571`）的评估结果直接喂给
  `retainTrustedHookMatchers(hooks, evaluation)`（`:577`），**决定哪些 hook 真正装载执行**；
  失败即 fail-closed（`:580` 用空评估，禁用全部项目 hook）。
- memo 的失效键是 walk 签名 `sha256(rel + size + mtimeMs)`——**不含内容**（含内容就等于把
  昂贵的 `readFile`+哈希又做了一遍，memo 失去意义）。
- 于是「**内容被改、但 size 与 mtime 都被回填成原值**」这一形态会命中陈旧摘要。若 memo 在
  强制路径上：攻击者改 hook 脚本内容后回填 mtime → memo 返回旧 digest → 与授权记录里的
  digest 相符 → 判定 `trusted` → **被改过的恶意 hook 照常装载执行**。

这与 `hookBundleDigest.ts` 头注（`:4-7`）「mtime 不是信任判据、`touch` 能伪造变更、git
操作会重写 mtime」的取舍**直接冲突**。信任门恰好是安全边界，陈旧摘要在这里不是「显示过期」
而是「放行恶意」。

⇒ **落点**：新增 `computeHookBundleDigestForReport`（进程内 memo，按 walk 签名失效），
**只**注入到 `hookTrustService.list`（`:50-57`，面板可见性——横幅只展示状态，不装载任何
hook）。会话装配（`:571`）与授权 `decide`（`:124`、`:142`）**保持默认纯
`computeHookBundleDigest`**。`evaluateProjectHookTrust` 的 `computeDigest` 形参**默认即纯
哈希**，memo 是显式 opt-in，强制路径无从误用。

性能取舍：会话装配的 ~130ms 未被 memo 消除（它是安全边界，本就该每次按当前磁盘内容重算）。
被消除的是**面板重复打开**与**同进程内 list 的重复评估**——这正是「打开面板就重算一遍」的
体验痛点，且不牺牲强制路径的安全性。

memo 的三条约束（plan line 322 + §6.1 line 489，全部落实）：**仅进程内**（`reportDigestCache`
是模块级 `Map`，不落盘、不跨进程）、**只缓存 `hashed` 结果**（`blocked`/读盘失败是瞬时态，
缓存下来会把插件永久钉死成 blocked）、**签名变即重算**。

### ② `blocked` 原因结构化 + 面板分类提示

`HookBundleDigest` 的 blocked 分支由 `{ kind, detail }` 扩成
`{ kind, reason: HookBundleBlockedReason, detail }`，`reason` 二分：

- `over_limit`：目录超出 2000 文件 / 8MiB 上限 ⇒ 处置是「给插件目录瘦身」。
- `unsafe_content`：声明越界 / 符号链接 / 非普通文件 / 读盘失败 ⇒ 处置是「人工评审目录内容」。

`reason` 一路透传：`hookBundleDigest` → `HookTrustEntry.blockedReason`（`protocol.ts`）→
`GatewayHookTrustEntry.blockedReason`（`gateway/protocol/types.ts`）→ UI
`HookTrustEntry.blockedReason`（`ui/.../types/types.ts`，`useHookTrust.ts` 用白名单
`parseBlockedReason` 收窄）→ 横幅 `HookTrustBanner.tsx` 渲染
`t(\`blockedReason.${reason}\`)`。`decide` 的拒绝 `reason` 同步细化为
`blocked_over_limit` / `blocked_unsafe_content`（原笼统 `blocked`）。新文案进
`ui/src/i18n/locales/{en,zh-CN}/hookTrust.json` 的 `blockedReason.{over_limit,unsafe_content}`，
en/zh-CN 键对齐（过 `check:i18n-namespaces`）。

死角面到此**从「不可处置」变为「可诊断」**：用户看到 `blocked` 时知道是太大还是不安全。

### ③ **不**跳过 `node_modules` / `.git` 的哈希（§6.1 分叉 6 = b）

plan §6.1 分叉 6 建议 (b)：只做 memo + `blocked` 原因结构化，**不做** (a)「跳过子目录哈希」。
理由照搬：决策记录 `2026-09-21-project-hook-trust-gate.md` 把「整树内容摘要」定为信任单位
（hook 的 `command` 可引用目录内任意脚本，只哈希声明文件会漏掉「声明没变、被执行的脚本换了」），
跳过 `node_modules` 会推翻该决策、重新打开「恶意脚本藏在被跳过的子目录里」的口子；且
「clone 安装的插件是常态」**在本仓无证据**（`src/extension/` 无插件 install 通道）。
⇒ 死角通过 ②「原因可区分 + 面板提示」解决，而非通过放宽哈希范围。

## Alternatives considered

- **memo 也覆盖会话装配（plan line 322 字面）** — **否决**。见 Decision ①：会话装配经
  `retainTrustedHookMatchers` 是强制路径，memo 签名不含内容 ⇒「mtime 回填 + 内容变」会让
  被改过的 hook 蒙混装载。这是安全边界上的无声弱化，不可接受。M1 测试正是为钉死这条边界。
- **memo 失效键纳入内容（让强制路径也能安全 memo）** — **否决**。算签名就得 `readFile`
  全部内容，等于把昂贵的哈希又做一遍，memo 毫无收益。
- **跳过 `node_modules`/`.git` 子目录的哈希（分叉 6 = a）** — **否决**。见 Decision ③：
  推翻「整树内容摘要 = 信任单位」的 1.2a 决策，重开「脚本藏在被跳过目录」的口子。
- **`blocked` 不结构化、只在 `detail` 文案里区分** — 落选。`detail` 是给开发者看的英文串，
  面板无法据此选 i18n 文案；结构化 `reason` 才能让 UI 做分类提示，也让 `decide` 的拒绝码
  可被前端区分。
- **把 `over_limit` 的上限调高以容纳 `node_modules`** — 落选。上限的存在是防「插件目录塞进
  大资产树后每次装配无谓全量读盘」（`hookBundleDigest.ts:29`）；调高只是把死角推后，且加重
  ①的性能问题。正解是让 `blocked` 可诊断（②）+ 面板告诉用户瘦身（③）。

## Consequences

- **正向**：① 面板重复打开 / 同进程内 list 重复评估由 166–189ms 降为一次 `readdir`+`stat`
  （个位数 ms）；强制路径（会话装配、授权）一寸未松，仍按当前磁盘内容逐字节哈希。
  ② `blocked` 从笼统状态变为 `over_limit` / `unsafe_content` 二分，面板给出对应处置提示，
  `decide` 拒绝码细化为 `blocked_over_limit` / `blocked_unsafe_content`。
- **行为边界（刻意）**：会话装配的 ~130ms **未**被消除——它是安全边界，本就该每次重算。
  memo 只服务可见性。带 `node_modules` 的插件**仍**会 `blocked`（不放宽哈希范围），但用户
  现在知道**为什么**（`over_limit`）以及**怎么办**（瘦身插件目录）。
- **护栏（测试）**：
  - `tests/extension/plugins/hook-trust-report.spec.ts`（node --test）新增 3 条 memo 用例：
    **M1**「内容变但 size 与 mtime 都回填 → 报告路径命中陈旧摘要、纯哈希路径仍识破」（用
    `utimes` 把 mtime 钉回固定值，断言 `computeHookBundleDigestForReport` 返回旧 digest 而
    `computeHookBundleDigest` 返回不同 digest——**这条直接钉死 Decision ① 的安全边界**）；
    **M2**「size 或 mtime 真实变化 → 签名失效 → 重算」；**M3**「blocked 不写缓存——目录恢复
    后立即重新算出 hashed」。既有 blocked 用例扩成断言 `reason`（escape/linked =
    `unsafe_content`、big = `over_limit`）+ entry 级 `blockedReason`。
  - `tests/cli/hook-trust-service.spec.ts`：`decide` 对越界插件拒为 `blocked_unsafe_content`；
    新增「超限插件 → decide 拒为 `blocked_over_limit`、list 标 `over_limit`」。
  - `ui/src/components/hook-trust/view/HookTrustBanner.test.tsx`（vitest）：新增 blockedReason
    渲染断言（`over_limit` / `unsafe_content` 各自映射到对应 i18n 文案）。
  - **负控制（plan line 462）**：memo 不按签名失效 ⇒ M2「内容变化后重算」用例红；M1 若把
    memo 误接到强制路径 ⇒「纯哈希识破」断言红。
- **门禁联动**：`blockedReason` 是 result/entry 的**可选新增字段**，不改 `WsGatewayMethod`
  联合（method 名）也不改版本账本 ⇒ **不触发 protocol-version bump**（`check:protocol-version`
  绿）。本批文件无事件 emit ⇒ 事件矩阵 `file:line` 不受影响。新 i18n 键 en/zh-CN 对齐 ⇒
  `check:i18n-namespaces` 绿。行数变动跑 `pnpm measure:update`。`outputSchema` 无关 ⇒
  不触发 llm-replay 重录。

## 相关

- 议题：`#538`（TD-EXTENSION-N07）。同批 PR 另含 `#532`（工具注册表严格位 + MCP 豁免），
  两条决策独立、各自成提交（plan §5），共用一条「缓存不得伪装成新鲜」的主题。
- 代码：`src/extension/plugins/trust/hookBundleDigest.ts`（walkBundle/hashFiles 拆分 +
  `HookBundleBlockedReason` + `computeHookBundleDigestForReport` memo + `clearHookBundleDigestCache`
  + `walkSignature`）· `protocol.ts` / `evaluateHookTrust.ts` / `index.ts`（透传 `reason` 与
  可注入 `computeDigest`）· `src/cli/hookTrustService.ts`（list 注入 memo、decide 保持纯哈希、
  拒绝码细化）· `src/gateway/protocol/types.ts` · `ui/src/components/hook-trust/*`（types /
  useHookTrust / HookTrustBanner）· `ui/src/i18n/locales/{en,zh-CN}/hookTrust.json`。
- 证据点：`ProjectRuntimeRegistry.ts:571/:577/:580`（会话装配 = 强制路径，默认纯哈希）·
  `hookTrustService.ts:50-57`（list 注入 memo）/`:124`/`:142`（decide 纯哈希）·
  `hookBundleDigest.ts:4-7`（mtime 不是信任判据）/`:29`（上限的存在理由）。
- 决策依据：`docs/notes/implemented/2026-09-21-project-hook-trust-gate.md`（整树内容摘要 =
  信任单位）· 方案 `docs/open-issues-remediation-plan.md` §3.6 ② · §6.1 分叉 6（不跳过
  `node_modules`）· §6.1 line 489（memo 无声弱化信任判据的风险与缓解）。
