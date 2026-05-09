# 适配后 Web UI 测试文档

本目录描述 old_ui 适配 PolitDeck `src/` 后应如何测试。测试目标不是只证明页面能打开，而是证明 Web UI 与 Gateway、Session、Tool、Permission、Cron 等边界的协议稳定。

## 文档列表

- `01-test-strategy.md`：测试分层、覆盖范围和命令。
- `02-contract-and-parity-tests.md`：旧 UI contract、双实现 parity 和归一化规则。
- `03-real-environment-runbook.md`：真实本地环境下的冷启动、真实模型、工具调用和页面验收步骤。

## 基础命令

根项目当前以 `package.json` 为准：

```bash
npm run build
npm test
```

旧 UI 如仍参与兼容测试，应在 `old_ui/` 下单独运行：

```bash
npm run typecheck
npm run lint
npm run build
```

如果补充 Vitest/Playwright，应显式新增脚本，不要假设 `old_ui` 已有统一 `npm test`。
