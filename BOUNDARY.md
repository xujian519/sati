# PilotDeck 开源/产品边界规范

> **规则只有一条**：如果一个功能只有某个客户需要，代码必须放 `products/<customer>/` 里；
> 如果两个以上客户都需要，就下沉到 `src/` 作为开源功能。

---

## 1. 目录约定

```
src/                              ← 开源核心，任何人都能贡献
  extension/                      ← 贡献点（Contribution Point）定义
  extension/plugins/builtin/      ← 随开源发布的内置插件
  adapters/                       ← 频道适配器（CLI / TUI / Web / Feishu）
  context/memory/                 ← MemoryResolver 接口 + 内置实现
  model/                          ← LLM 提供商抽象 + 协议
  pilot/config/                   ← 配置系统
  ...                             ← 其他核心模块

products/                         ← 产品定制目录（不随开源发布）
  <customer-id>/                  ← 每个客户/行业一个子目录
    plugins/                      ← 客户专属插件（plugin.json + hooks/commands）
    config/                       ← pilotdeck.yaml 覆盖配置
    brand/                        ← Logo、主题覆盖
    memory/                       ← 自定义 MemoryResolver 实现（如需）
    README.md                     ← 客户需求说明
  _shared/                        ← 多个客户共享但不适合开源的代码
    plugins/                      ← 共享的产品级插件

src/context/memory/edgeclaw-memory-core/  ← 独立包：记忆系统实现（可被 products/ 替换）
ui/                               ← Web UI（独立工作区）
```

---

## 2. 贡献点清单

贡献点是 `src/` 暴露给 `products/` 的稳定接口。产品定制代码**只能通过贡献点**与核心交互，不能直接修改 `src/` 下的代码。

### 2.1 已稳定的贡献点

| 贡献点 | 接口位置 | 产品侧使用方式 | 稳定性 |
|-------|---------|--------------|--------|
| **工具 (Tool)** | `src/tool/protocol/types.ts` → `PilotDeckToolDefinition` | MCP manifest 声明，或 `ToolRegistry.register()` | 稳定 |
| **MCP 服务** | `plugin.json` → `mcpServers` 字段 | 在 plugin.json 中声明 MCP server | 稳定 |
| **生命周期钩子 (Hook)** | `src/extension/hooks/protocol/` | plugin.json 的 `hooks` 字段或 `hooks/hooks.json` | 稳定 |
| **命令 / 技能 (Command/Skill)** | `src/extension/plugins/loading/PluginCommandLoader.ts` | plugin.json 的 `commands` / `skills` 字段 | 稳定 |
| **Prompt 注入** | `src/extension/contributions/PromptContribution.ts` | plugin.json + programmatic contribution | 半稳定 |
| **权限规则** | `src/extension/contributions/PermissionRuleContribution.ts` | Hook 或配置 | 稳定 |

### 2.2 待补齐的贡献点

| 贡献点 | 现状 | 目标 | 优先级 |
|-------|------|------|--------|
| **记忆提供商 (MemoryProvider)** | 硬编码 `provider: "edgeclaw"` | 支持通过配置注册自定义 provider | P0 |
| **品牌配置 (BrandConfig)** | TUI/Web 各自硬编码主题 | 统一 `brand` 配置节，支持覆盖 | P1 |
| **消息元数据 (MessageMetadata)** | usage 数据存在但不透传到 UI | 在 gateway 事件中标准化 usage 透传 | P2 |

---

## 3. 产品插件规范

### 3.1 目录结构

一个产品插件的最小结构：

```
products/<customer>/plugins/<plugin-name>/
  plugin.json          ← 必须：插件清单
  hooks/
    hooks.json         ← 可选：钩子配置
    pre-tool-use.sh    ← 可选：钩子脚本
  commands/
    my-command.md      ← 可选：自定义命令
  skills/
    my-skill.md        ← 可选：自定义技能
```

### 3.2 plugin.json 示例

```json
{
  "name": "customer-a-compliance",
  "version": "1.0.0",
  "description": "Customer A 合规审计插件",
  "hooks": "hooks/hooks.json",
  "commands": ["commands/audit-log.md"],
  "mcpServers": {
    "customer-a-kb": {
      "command": "node",
      "args": ["./mcp-servers/kb-server.js"],
      "env": {
        "KB_ROOT": "/data/customer-a/knowledge-base"
      }
    }
  }
}
```

### 3.3 加载方式

产品插件不需要修改核心代码。PilotDeck 从以下路径发现插件：

1. `~/.pilotdeck/plugins/` — 全局插件（所有项目共享）
2. `<projectRoot>/.pilotdeck/plugins/` — 项目级插件

**产品部署时**，将 `products/<customer>/plugins/` 下的插件软链接或复制到上述路径之一即可生效。

可选：在 `products/<customer>/config/pilotdeck.yaml` 中配置：

```yaml
# 产品覆盖配置示例
memory:
  enabled: true
  provider: "edgeclaw"           # 将来支持更多 provider
  captureStrategy: "full_session"

# brand 配置（待贡献点补齐后生效）
# brand:
#   name: "CustomerA Platform"
#   theme: "customer-a-dark"
```

---

## 4. 判断规则：代码放哪里？

遇到新功能时，按此决策树判断：

```
这个功能是否只有一个客户需要？
  ├── 是 → 放 products/<customer>/
  │        用插件 / 钩子 / 配置覆盖实现
  │        如果现有贡献点不够 → 先在 src/ 补贡献点，再在 products/ 用
  │
  └── 否（两个以上客户需要）
        ├── 功能与行业无关 → 放 src/，作为开源功能
        └── 功能与行业有关但通用 → 放 products/_shared/
            在第三个客户也需要时，考虑下沉到 src/
```

### 4.1 "补贡献点"的判断标准

当 `products/` 下的代码需要修改 `src/` 才能工作时，这不是"改核心"，而是"补贡献点"。
补贡献点的代码属于 `src/`，但动机来自产品需求。

**补贡献点的条件**：
1. 新增的是一个接口/注册机制，不是具体实现
2. 开源用户也能通过这个接口扩展功能
3. 不引入任何客户特定的业务逻辑

---

## 5. 配置分层

PilotDeck 配置按优先级从低到高加载：

```
src/ 内的默认值
  ↓ 覆盖
~/.pilotdeck/pilotdeck.yaml（全局配置）
  ↓ 覆盖
<projectRoot>/.pilotdeck/pilotdeck.yaml（项目配置）
  ↓ 覆盖
环境变量 PILOT_*
```

产品定制配置放在 `products/<customer>/config/pilotdeck.yaml`，部署时复制到目标环境的 `~/.pilotdeck/pilotdeck.yaml` 或项目级 `.pilotdeck/pilotdeck.yaml`。

---

## 6. Git 与 CI 约定

### 6.1 分支策略

```
main                ← 开源主分支，所有核心功能在这里
  ├── feature/*     ← 开源功能分支
  └── (不 fork)     ← 产品代码在 products/ 目录，不是独立分支
```

**不使用长期产品分支**。所有产品代码在 `main` 分支的 `products/` 目录下。

### 6.2 发布时排除

开源发布（npm publish / GitHub release）时，通过 `.npmignore` 或构建脚本排除：

```
products/
src/context/memory/edgeclaw-memory-core/    # 如果记忆系统单独发布
```

### 6.3 CI 矩阵

```yaml
# 示例 CI 配置思路
jobs:
  core-tests:        # 跑 src/ 的测试（每个 PR 都跑）
  product-a-tests:   # 跑 products/customer-a/ 的测试（仅当 products/customer-a/ 或 src/ 有变更时）
  product-b-tests:   # 同上
```

---

## 7. AI 协作规范

### 7.1 AI 可以完全主导的事

- 编写 `products/` 下的插件代码（plugin.json、hooks、commands、MCP servers）
- 编写 `src/` 下的功能代码（在接口设计已确定的前提下）
- 当开源 `src/` 更新后，检查 `products/` 下的插件是否需要适配，并生成适配 PR
- 跑测试、CI、回归

### 7.2 AI 辅助但人类拍板的事

- 贡献点接口设计（AI 提方案，人类 review 类型定义）
- 判断一个功能放 `src/` 还是 `products/`（AI 可以建议，人类决定）
- 新增 `PilotDeckExtensionContributionKind`（扩展贡献点类型枚举）

### 7.3 给 AI 的上下文

将以下文件加入 AI 的上下文：

| 文件 | 用途 | 何时读 |
|------|------|--------|
| `BOUNDARY.md`（本文件） | 目录约定、代码放哪里 | 新功能立项时 |
| `docs/extension-protocol.md` | 7 个接口的技术定义 | 写 `products/` 代码时 |
| `.cursor/rules/product-boundary.mdc` | AI 编码检查清单 | 自动加载（`src/` 和 `products/` 目录） |
| `.cursor/rules/extension-protocol.mdc` | 接口协议速查 | 自动加载（`products/` 目录） |

确保：
- AI 在写产品代码时自动遵守目录约定
- AI 在改核心代码时检查是否影响产品插件
- AI 在补贡献点时遵循"只加接口，不加业务逻辑"原则

---

## 8. 从现有代码到产品线的迁移路径

### Phase 0：画线（本周）
- [x] 创建本文件 `BOUNDARY.md`
- [ ] 创建 `.cursor/rules/product-boundary.mdc`
- [ ] 创建 `products/` 目录结构
- [ ] 将 `products/` 加入 `.npmignore`（开源发布排除）

### Phase 1：第一个客户交付（本月）
- [ ] 补齐 MemoryProvider registry（`src/pilot/config/types.ts` 中 `provider` 字段支持自定义值）
- [ ] 在 `products/<customer-a>/` 下创建客户专属插件
- [ ] 配置覆盖：客户的 `pilotdeck.yaml`
- [ ] 验证：客户插件通过标准发现机制加载，无需改动 `src/`

### Phase 2：品牌与 UI 定制（下月）
- [ ] 在 `PilotConfig` 中添加 `brand` 配置节
- [ ] TUI theme 从 `PilotConfig.brand` 读取，回退到默认主题
- [ ] Web UI theme 从 API 获取 `brand` 配置

### Phase 3：第二个客户 + 产品沉淀（下季度）
- [ ] 第一个客户的通用功能下沉到 `src/`
- [ ] `products/_shared/` 中沉淀跨客户共享的产品级代码
- [ ] 建立"开源新版本 → 产品适配"的 AI 自动化流程
