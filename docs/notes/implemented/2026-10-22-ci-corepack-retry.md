# CI Note: corepack 安装 pnpm 增加有界重试

Status: implemented

## Problem

2026-10-22 的两条 CI（PR #702 attempt 1、main push `4f9e5fe1`）都在 `Enable pnpm (corepack)` 步骤失败，日志为 `registry.npmjs.org/pnpm/10.32.1` 返回 HTTP 503。该步骤位于 checkout 之后、install 之前，corepack 自身不做重试；同一时段的 drift / Windows 作业里 corepack 步骤成功，属于请求级偶发错误。结果是代码无关的基础设施抖动把 PR 与 main 判红，只能人工 rerun。

## Decision

执行 `corepack prepare` 的 quality 与 drift 两个作业都改为最多 5 次尝试、5/10/15/20s 退避；全部失败才 `exit 1`。`corepack enable` 与 `pnpm --version` 不变。

## Alternatives considered

- **只 rerun 失败作业** — 每次抖动仍需人工介入，main push 的红灯也会误伤合并后的信号。
- **改用 `pnpm/action-setup`** — 仍从 npm registry 下载，换 action 不消除同类网络失败，还要重新验证版本与缓存行为。
- **设置 `npm_config_fetch_retries`** — corepack 不读取该变量（只对随后的 `pnpm install` 生效），对 `corepack prepare` 无效。
- **无限重试** — registry 长时间不可用时会挂住 CI，失去红灯语义；有界重试保留失败可观测性。

## Consequences

- registry 短时抖动（累计退避 ≤50s，不含单次请求耗时）不再判红；持续不可用仍在第 5 次失败并给出明确错误。
- 工作流多出两段相同的 shell 循环，无新依赖、无新增 action。
