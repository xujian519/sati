# Agent Note: 会话标题采用会话路由模型

Status: implemented

补记：本 note 于 2026-10-10 补写——变更随 PR #610 于 2026-10-07 落地，当时未附 note。评估背景见 `docs/pilotdeck-2026-10-upstream-port-plan.md` 批次 C。

## Problem

同一处装配代码里两个模型口径：

- `createAgentConfig` 用 `context.modelRoute`（M4 会话级模型路由覆盖，团队成员唤醒时传快照 `modelRoute`）——正文由 routed model 作答；
- `createSessionTitleGenerator` 传的是项目默认模型 `config.agent.model`。

于是走路由的会话（最典型的是团队成员会话）**正文模型与标题模型不是同一个**：标题的语言习惯、风格与能力都来自另一个模型，同一会话里两套口径。

## Decision

标题生成器改吃「会话实际使用的模型」，并把这个解析口径收成一个共享函数：

- `src/cli/agentSessionConfig.ts` 导出 `resolveRoutedModel(route, fallback)`：`provider` 与 `model` **双字段非空**才采用路由模型，任一缺失整体回落项目默认。不做单纯的 `route ?? fallback`——WS 线协议可以直传部分字段（编译期约束管不到线协议），只判 `undefined` 会让空串路由盖掉默认模型，拼出 provider 与 model 不对应的模型对；`buildAgentSessionConfig` 原有的内联判断一并改为调用它，避免两处各写一份口径。
- `src/cli/ProjectRuntimeRegistry.ts` 创建标题生成器时传 `resolveRoutedModel(context.modelRoute, runtime.snapshot.config.agent.model)`。
- `SessionTitleGenerator` 的 `agentModel` 选项类型由完整 `PilotAgentModelSelection` 收窄为 `Pick<…, "provider" | "model">`——标题生成只消费这两个字段（不需要 `id`），收窄后可直接接路由解析结果，无需为凑类型多造字段。

## Alternatives considered

- **引入上游同 PR 的 `modelOverride` / `modelSelection` 形态** — 落选：全仓零命中，照搬等于新建第二套 per-turn 模型覆盖语义，而缺陷只需「让标题读同一个来源」。
- **把路由模型在标题生成器内部再解析一次** — 落选：`ProjectRuntimeRegistry` 才知道 `context.modelRoute`，生成器是被注入的纯函数，重新解析会把会话上下文漏进标题模块。
- **保持 `agentModel` 为完整 selection，另加一个可选 `model` 字段并在缺省时回落** — 落选：两个字段表达同一件事，且回落分支会让「传了空对象」这种半截配置悄悄退回默认模型；收窄类型让调用方必须给出完整的一对 provider/model。
- **只在团队成员路径特判** — 落选：`modelRoute` 的语义是「本会话的模型」，任何来源（含将来新增的入口）都应一视同仁。

## Consequences

- 走路由的会话，标题与正文同模型；无路由时行为完全不变（回落 `config.agent.model`）。
- `modelRoute` 的解析口径从此只有一处实现（`resolveRoutedModel`），半截路由不会再拼出错误模型对。
- 代价：`SessionTitleGenerator` 的 `agentModel` 选项不再是完整 selection。今天无人消费 `id`（该请求的 metadata 只带 `purpose`/`sessionId`/`turnId`），但将来若要按 selection 归集用量，需把类型扩回去。
