# old_ui 与 src 适配方案

本目录描述 `old_ui/` 如何适配当前 PolitDeck `src/`。方案分为两条线：

- 改写或重写 `old_ui`：把旧 UI 的页面和交互迁到 PolitDeck Gateway。
- 补齐或调整 `src`：为 Web UI 暴露稳定协议，而不是让 UI 读取 runtime 内部实现。

## 文档列表

- `01-target-boundaries.md`：Web UI 应对接的 `src` 边界和禁止跨越的内部边界。
- `02-rewrite-old-ui-plan.md`：重写/改写旧 UI 的阶段计划。
- `03-src-change-plan.md`：为了适配 Web UI，`src` 建议新增或调整的能力。
- `04-parity-matrix.md`：旧 UI 能力到新项目能力的状态矩阵。

## 总体建议

第一阶段不要直接搬运 `old_ui/server/index.js`。应以当前 `src/gateway` 为核心，把旧 UI 的聊天、会话、Cron/Always-On 等功能改为 Gateway client；文件、Git、Shell 等项目操作通过明确 adapter 或 Gateway 扩展进入。

推荐阶段：

```text
Phase 0: 固化旧 UI 行为清单与 contract 测试
Phase 1: 建立 PolitDeck Web Gateway client 和消息适配层
Phase 2: 迁移 Chat / Sessions / Projects 主流程
Phase 3: 迁移 Files / Git / Shell / Settings
Phase 4: 迁移 Always-On / Cron / Memory / Plugins
Phase 5: 删除旧 Express/provider adapter 依赖或降级为兼容层
```
