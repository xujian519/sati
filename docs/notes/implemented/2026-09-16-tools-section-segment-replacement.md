# Agent Note: Search 面板写侧不再整段替换 tools 段

Status: implemented

## Problem

设置面板「Agents → Search」的三处写路径整段替换 `tools` 而非只写自己的子键：

```
patch(config, ["tools"], { webSearch: … })     // setProvider / setField
patch(config, ["tools"], { webSearch: … })     // setCustomField
```

`patch` 是「在副本上写首段键值」，因此载荷里没有的兄弟键会被抹掉。受影响的兄弟段是
`tools.paperSearch`——面板不渲染它（只在「Advanced → Raw YAML」里可见），但配置文件里它
承载着 `paper_search` 工具的开关与连接器选择。

后果不是"面板显示不对"，而是**配置文件丢数据**：用户在面板里换个搜索 provider，
保存后 `tools.paperSearch` 整段从 `sati.yaml` 消失，`paper_search` 随之停止注册，
而 UI 上没有任何痕迹提示发生了什么。写侧链路是
`ToolsSection` → `configToYamlString` → `PUT /api/config` → `yaml.stringify`，
`undefined` 键与缺失段在落盘时都不可区分，所以丢失是静默且不可逆的（除非用户翻 git 或备份）。

同一面板的「Enable web search」开关（`patch(config, ["tools","webSearch","enabled"], …)`）
一直是子键粒度，说明整段替换是这三处的疏漏而非有意设计。

## Decision

三处统一改为写子键 `["tools", "webSearch"]`：载荷形状不变（仍是 webSearch 段本身），
变化只在于落点——`patch` 保留 `tools` 下的其它键。清空字段时分支出 `undefined`，语义是
"移除 `tools.webSearch` 这一个子键"，`yaml.stringify` 默认 `keepUndefined: false` 会省略它。

`SatiConfig["tools"]` 补上 `paperSearch` 的形状：类型此前只建模面板渲染的部分，而未建模的
键靠 `parseYaml` 原样进入对象——这正是丢失能发生的前提。补形状后，"保住兄弟段"成为
类型可见、测试可断言的不变式，而不是只能靠 code review 记住的约定。

回归锚在 `ToolsSection.test.tsx`：三条换 provider / 清 endpoint / 改自定义字段的用例
各自断言 `tools.paperSearch` 仍在载荷里。它们在修复前全红（`paperSearch: undefined`）。

## Alternatives considered

- **在面板里补一个 `paper_search` 开关** — 暂不落：面板当前定位是「web_search 的搜索服务配置」
  （描述文案即如此），加第二个工具的开关属于面板信息架构调整，与本次写侧修复无关；
  需要调整 `paper_search` 的用户仍可走 Raw YAML，而**写侧修好后 Raw YAML 的编辑不再被面板覆盖**——
  这是本修复的必要条件，独立于是否补开关。
- **让 `patch` 对 `{webSearch}` 之类的对象做深合并** — 落选：把语义塞进通用工具函数，
  其它调用点（`customEnv`、`agent`）会继承一个它们没预期的合并行为；"我这一层的载荷是否
  完整覆盖了这个段"是调用点的知识，不是 `patch` 的知识。
- **只写 `["tools"]` 但把兄弟段读回来再拼进载荷** — 落选：多一次读取等于把不变式绑在
  "记得 read-modify-write"上，与子键写相比没有收益。
- **把 `paperSearch` 提到顶层** — 落选：改磁盘格式，牵动 `parseToolsConfig` 诊断路径与
  所有既有配置文件，收益只是绕开这次 bug。

## Consequences

- 换 provider / 清字段不再影响 `tools` 下其它子键；未来在同段新增子键（如另一个搜索工具）
  不需要再改这三处。
- 代价：`SatiConfig` 类型与面板渲染范围不再一致（多了一个面板不渲染的键），类型读者需知道
  "此类型描述 YAML 形状，不是面板字段清单"。
- `paper_search` 的开关仍只有 Raw YAML 一条路径——本修复保证该路径不再被面板静默回退。
