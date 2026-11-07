# Agent Note: 按技能持久开关

Status: implemented

## Problem

技能清单每次都全量进入 prompt / `list_skills`，用户无法关闭当前项目用不到的技能。删除技能又会丢失文件，不是可逆的偏好。

## Decision

- `src/extension/skills/skillPreferences.ts`：
  - 文件 `~/.sati/skill-preferences.json`，结构 `{version:1, builtin, user, project}`；
  - 优先级 project（当前项目）> user > builtin，缺省启用；
  - 文件缺失/坏 JSON/不可读时 fail-open；
  - 写入临时文件 + rename，权限 0600；`refresh()` 按 mtime 重载，配置在下一轮 prompt 生效。
- `SkillManager`：
  - `SkillSummary.enabled`；
  - `list()` 返回全部技能并标注 enabled，`enabledOnly: true` 时过滤；
  - `setEnabled({ scope, slug, projectKey?, enabled })` 持久化。
- Prompt：`PromptAssemblerOptions.isSkillEnabled(slug)` 过滤 `available-skills` 与 `available-roles`；`DefaultContextRuntime` 每轮 assemble 前调用 `refresh()`。
- UI：`/api/skills/preferences` GET/POST（ui/server 侧直接读写同一文件，按边界规则不导入 `src/`）；技能列表行增加开关，禁用行半透明。
- `sessionDependencyAssembly` 为每个 context runtime 注入 `SkillPreferenceStore(pilotHome)`。

## Alternatives considered

- **新增 gateway RPC `skill_set_enabled`。** 落选。会改网关方法表与协议版本；偏好是本地 UI 状态，HTTP 端点足够。
- **删除技能目录来实现「关闭」。** 落选。不可逆、会丢文件，且用户可能只是暂时不用。
- **默认禁用新技能。** 落选。升级后技能会整体消失；缺省启用、显式关闭更安全。
- **prompt 侧按路径推断 scope。** 落选。`ContributedSkill` 只有 path/name，bundle/user/project 的路径前缀在不同宿主下不稳定；按 slug 的优先级规则更可靠。
- **每次 `isEnabled` 都 stat 文件。** 落选。prompt 组装会对每个技能调用一次；改为每轮组装前 `refresh()` 一次。

## Consequences

- 偏好文件是本地可读 JSON；写入 0600。
- 关闭 user 技能会同时关闭同 slug 的 builtin（优先级规则），project 可单独覆盖。
- 内置技能在 UI 里仍以说明块展示（不可编辑），其开关可通过 API/偏好文件设置；这是本批的 UI 取舍。
- 未改工具 `inputSchema`、网关协议或事件。
- `DefaultContextRuntime.ts` +12 行、`SkillsV2.tsx` +24 行；开关组件与写入 hook 已抽到 `skills/shared/`，剩余为接线。两处均已在 `docs/technical-debt/architecture-baseline.json` 显式追认。
- 负控制：移除 prompt 过滤 → 1 条转红；`enabled` 恒 true → 2 条转红；恢复后 7 条全绿。浏览器验证：开关写入文件、刷新后保持，验证后已删除测试偏好。
