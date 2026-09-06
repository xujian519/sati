# Agent Note: provider 凭证作用域（catalog envVar 不再随自定义端点泄漏）

Status: implemented

## Problem

`parseModelConfig` 在用户未显式填写 `apiKey` 时，无条件把 catalog 的 `apiKeyEnvVar`（如 `ANTHROPIC_API_KEY`）注入为 `${VAR}` 引用。当用户把该 provider 的 `url` 改成第三方代理（自定义端点）时，本机环境变量里的官方密钥仍会被读取并发往该第三方 URL——凭证泄漏面。显式 apiKey（字面量或 `${VAR}`）是用户有意选择，不属于此问题。

移植自 PilotDeck `desktop-v2026.09.04` #546（`providerCredentialScope.ts`），按 Sati 现有结构适配。

## Decision

新增 `src/model/config/providerCredentialScope.ts`：

- `canUseCatalogCredential(input)` 纯函数：仅当解析后的协议与 url 仍与 catalog 条目一致（含 Google 官方 OpenAI 兼容端点例外）时返回 true；
- `resolveDefaultProviderUrl` 从 `parseModelConfig.ts` 迁入并导出——配置解析（默认 url）与作用域判断共用同一函数，两处判定永不漂移；
- URL 比较走 `new URL()` 规范化（协议限定 http/https、剥尾部斜杠、host 大小写归一）。

`parseProvider` 接线：作用域外（自定义 url/协议）且用户未显式填 apiKey、而 catalog 又有 `apiKeyEnvVar` 时，抛 `missing_credential`（可修复码），错误信息明确指出"不再自动套用 catalog 环境变量，请显式配置 apiKey（字面量或 `${VAR}`）"；作用域内行为不变（默认端点缺省 apiKey 仍自动注入 catalog envVar）。

**行为变化（唯一受影响组合）**：自定义 url + 未填 apiKey + 依赖 catalog envVar 的配置从"静默工作"变为启动报错。这正是要堵的泄漏路径；受影响用户显式写 `apiKey: ${ANTHROPIC_API_KEY}` 即恢复。

## Alternatives considered

- **静默跳过注入（不抛错，仅禁用 envVar）** — 落选：parse 层无 warning 通道，静默禁用会把"密钥突然失效"变成运行期 `missing_credential`，定位更难；fail-loud 与仓库既有 parse 错误风格一致。
- **按 PilotDeck 原样在 `providerCredentialScope` 内复制一份端点/协议判定** — 落选：与 `resolveDefaultProviderUrl` 形成两份平行事实，Google 例外一旦调整会漂移；迁入共享是零成本修正。
- **在请求期（`resolveApiKeyAtRequest`）再做作用域校验** — 落选：凭证注入发生在 parse 期（`apiKeyRaw` 已是 `${VAR}`），请求期无法区分"catalog 自动注入"与"用户显式引用"，校验必须在注入前。
