# Agent Note: PR traceability gate and issue templates

Status: implemented

## Problem

PR 模板虽内置「关联 Issue: #」字段（`.github/PULL_REQUEST_TEMPLATE.md` 首行与
CONTRIBUTING「TODO/FIXME 关联 Issue」约定），但没有任何机器校验，PR 可以完全不提
issue 就合入，导致需求来源无法回溯。与此同时仓库 `.github/` 下没有 issue 模板，
issue 的字段（影响 scope / 契约影响 / i18n / 视觉验证）全靠各人自觉，质量参差，
容易遗漏「改 tool inputSchema 需重录 fixture」「改 AgentEvent 需重生成事件矩阵」
这类会拖垮 CI 的信息。

## Decision

1. 新增 `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md` 与 `config.yml`，
   字段对齐仓库现有规范：影响 scope（对齐提交 scope）、契约影响（inputSchema /
   AgentEvent / 网关协议 / i18n / 视觉验证）、备选方案、验收标准。
2. 新增 `.github/scripts/check-pr-issue.mjs`，并在 `.github/workflows/ci.yml` 增加
   `pr-traceability` job（仅 `pull_request` 事件触发），强制 PR 关联一个 issue
   （`Closes #N` / `关联 Issue: #N` / 裸 `#N` 引用），或显式声明「无关联 issue」。

## Alternatives considered

- **只靠 PR 模板自觉，不加门禁** — 落选；模板字段可被随意删除，「必须回溯」
  停留在纸上规则，与仓库「铁律必须有门禁」的既有主张（见
  `docs/notes/implemented/2026-08-23-harden-standards-gates.md`）相悖。
- **门禁必须写 `Closes #N` 且不提供豁免** — 落选；会卡死确无对应 issue 的小修复
  （如 typo fix），收益不抵摩擦，故保留「无关联 issue」显式豁免通道。
- **把校验放到本地 pre-commit hook** — 落选；本地 hook 可被绕过，且 PR 描述此时
  尚未写成（PR 上下文只存在于远端），只能改在 CI 侧强制。
- **是否允许裸 `#N` 作为兜底** — 采用宽松策略：关键词 + 编号、裸 `#N`、豁免三者
  任一命中即通过；裸 `#N` 可能被十六进制颜色等偶发误判，属可接受的宽松权衡，
  注释中已标注收紧方法（删 `BARE_NUMBER` 判定）。

## Consequences

- 现在每个 PR 要么关联一个 issue，要么显式声明「无关联 issue」；需求可回溯性提升。
- 代价：新增一个约 5s 的 CI job，PR 作者需维护「Closes #N」或豁免声明。
- issue 模板让 bug/feature 在创建时就暴露契约影响，减少后期 CI 才发现的返工。
- 本门禁不在本地 `pnpm check` 范围内，只作用于远端 CI；本地开发不受影响。
