# 贡献指南

感谢您对 Sati 的关注与贡献！本指南帮助您了解项目的开发流程与规范。

## 开发环境

### 前置要求

| 工具 | 版本要求 |
|---|---|
| Node.js | `>= 22.13.0`（必需，依赖内置 `node:sqlite`） |
| pnpm | 10.32.x（通过 `corepack enable` 启用） |
| Git | 任意较新版本（需启用 Git LFS：`git lfs install`） |

### 安装与启动

```bash
# 1. 克隆（可跳过 LFS 演示媒体以加快速度）
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/xujian519/sati.git
cd Sati

# 2. 启用 pnpm 并安装依赖
node --version                      # 确认 v22.13.0 或更新版本
corepack enable
corepack pnpm install --frozen-lockfile

# 3. 开发模式（HMR，http://localhost:5173）
pnpm dev

# 或生产模式（http://localhost:3001）
pnpm server
```

模型提供方配置：创建 `~/.sati/sati.yaml`（可运行 `node scripts/bootstrap-sati-config.mjs` 生成），或通过 Web UI 的引导流程可视化配置。

## 工作流

### 1. 分支

从 `main` 检出功能分支，命名遵循：

```
feat/<kebab-case 描述>       # 新功能，如 feat/whitebox-memory-editor
fix/<kebab-case 描述>        # Bug 修复
docs/<kebab-case 描述>       # 文档
refactor/<kebab-case 描述>   # 重构
test/<kebab-case 描述>       # 测试
chore/<kebab-case 描述>      # 杂项
```

### 2. 提交（Conventional Commits）

格式：`<type>(<scope>): <subject>`，由 git hook 强制校验。

```bash
feat(agent): add white-box memory editor
fix: correct token counting on streaming responses
docs(ui): update chat i18n keys
```

- **类型**：`feat` `fix` `docs` `refactor` `test` `chore` `style` `perf` `ci` `build` `revert`
- **scope 建议**：`agent` `ui` `gateway` `memory` `router` `cli` `mcp` `always-on` `tool`
- subject 用祈使句，描述"做了什么"而非"做了什么后"；首字母小写，不超过 72 字符

### 3. PR

1. 从功能分支发起 PR 到 `main`
2. 按 [PR 模板](./.github/PULL_REQUEST_TEMPLATE.md) 填写描述
3. 保持 PR 小而聚焦（建议 ≤ 400 行变更）；大改动请拆分为多个 PR
4. 至少 1 名维护者批准后合并；Review 评论请尽量在 24 小时内响应

## 代码规范

### 强制项

| 项 | 规范 |
|---|---|
| 类型 | TypeScript strict；新代码避免 `any`（用 `unknown`）；禁止 `@ts-ignore`（用 `@ts-expect-error`） |
| 格式化 | **Biome**（`biome.json`），提交前运行 `pnpm format` |
| Lint | **ESLint 9**（根 `eslint.config.mjs` + `ui/eslint.config.js`），提交前运行 `pnpm lint` |
| 命名 | 文件/目录 kebab-case；类 PascalCase；组件 PascalCase；常量 UPPER_SNAKE_CASE |
| 异步 | 统一 `async/await`；事件回调不写 async |
| i18n | 新增用户可见文案必须提取到 `ui/src/i18n/locales/{en,zh-CN}/` 对应 namespace |

### 模块结构约定

- **后端模块**（`src/`）：`protocol/`（类型与契约）→ `runtime/`（实现）→ `config/`（配置加载），模块入口 `index.ts` 作为 barrel export
- **前端组件**（`ui/src/components/`）：feature-folder 模式，`view/`（UI）+ `hooks/`（逻辑）+ `types/` + `constants/` + `utils/`，入口组件在目录根
- **依赖边界**：`src/` 不得导入 `ui/`；`ui/` 通过 gateway API / WebSocket 通信，不得直接导入 `src/`
- **桌面端**：Electron 壳（`apps/desktop/`），当前维护 **macOS（DMG，arm64）** 与 **Windows（NSIS exe，x64/arm64）** 双平台构建与发布——mac 走 `apps/desktop/scripts/release.sh`（签名 + 公证），win 走 `apps/desktop/scripts/build-win.bat`（无签名）；**Linux 桌面端不维护**。macOS 专属行为（应用菜单 / About 面板 / Dock / 关闭即隐藏）在 Windows 上不可用

### 代码注释

- 公开 API 使用 JSDoc（`@param` / `@returns` / `@throws`）
- 复杂业务逻辑必须注释解释；禁止无意义注释
- TODO/FIXME 关联 Issue：`// TODO(#123): ...`

## 测试要求

| 层 | 工具 | 位置 |
|---|---|---|
| 后端单元/集成 | Node test runner | `tests/`（镜像 `src/` 结构） |
| UI 组件 | Vitest + Testing Library | `ui/src/**/*.test.tsx` |
| E2E | Playwright | `ui/e2e/` |

提交 PR 前必须：

```bash
pnpm check            # 聚合门禁：typecheck + ui typecheck + lint + format:check（门禁清单见 docs/development-standards.md 附录 A）
pnpm typecheck        # TypeScript 类型检查
pnpm lint             # ESLint
pnpm format:check     # Biome 格式检查
pnpm test             # 后端测试（先 build）
cd ui && pnpm test    # UI 测试
```

修改核心模块（`agent/` `router/` `tool/` `session/` 等）必须附相应测试。

### 视觉验证

凡涉及 UI 渲染（组件 / 样式 / 布局 / 主题 / 动画）的变更，必须在 PR 中完成**视觉验证**，不能仅以"单元测试通过"替代。PR 模板的"视觉验证"节为强制填写项，具体要求见 [PR 模板](./.github/PULL_REQUEST_TEMPLATE.md)。

要点：

- **触发条件**：改动命中 `ui/src/` 的组件、样式（Tailwind / CSS）、布局、主题（`DarkModeToggle`）、或 shadcn/ui 组件行为。
- **必附证据**：Before / After 对比截图或录屏，置于 PR"视觉验证 → 证据"折叠区。
- **双主题**：亮色 + 暗色均须无错位、无对比度问题。
- **双语言**：中文 (zh-CN) 与英文 (en) 下文案无截断 / 溢出 / 折行异常。
- **状态覆盖**：默认、hover、disabled、loading、empty、error 六态。
- **响应式**：桌面（≥1280）、平板、移动断点下布局正常。
- **桌面端**：Electron（mac / win）专属 UI 变更须在对应平台验证。
- 浏览器控制台无新增 error / warning。

### 测试注意事项（性能与调用方式）

实测基线（Apple Silicon 14 核、warm cache）：

| 命令 | 耗时 | 说明 |
|---|---|---|
| `pnpm test`（完整） | ≈ 20s | build ≈ 7s + 测试 ≈ 12s，约 2800 个用例 |
| `node --test --test-force-exit --test-timeout 60000 "dist/tests/**/*.test.js" "dist/tests/**/*.spec.js"` | ≈ 12s | 仅改测试、跳过 build 时使用 |

- **务必带 `--test-force-exit`**：部分测试会泄漏句柄/定时器（Express server、WebSocket、轮询），裸 `node --test` 不带该参数会一直等子进程自然退出——实测 3 分钟以上仍未完成。`pnpm test` 脚本已内置该参数。
- **单测必须 mock 外部网络与服务**：文献连接器、ollama probe 等一律经 `fetchImpl` 注入（参考 `tests/literature/`、`tests/model/ollamaProbe.spec.ts`）；引入真实网络依赖的测试会被 Review 打回。
- **LLM 回路级测试优先走重放 seam**（`src/test-support/llm-replay/`，无 key、CI 可跑）：不要新增依赖真实 API key 的回路测试；真实模型 fixture 更新须走显式录制流程（`scripts/record-real-fixture.ts`），不把 key 录进产物。
- **事件面改动须过事件矩阵门禁**：改 `AgentEvent` / gateway frames 等事件声明或订阅后，`pnpm check:event-matrix`（lint 自动挂接）须保持 green；必要时 `pnpm gen:event-matrix` 重新生成 `docs/event-producer-consumer.md`。
- **真实知识库只读测试很快**：`~/.sati/knowledge/knowledge.db`（约 3.5GB）的只读检索约 0.3s（SQLite mmap），不要为了"加快"把大库复制进 fixture。
- 3 个单体最慢的测试文件（`tool/read-file-large` ≈ 7.8s、`model/ollamaProbe` ≈ 5.1s、`context/tool-result-reference-error` ≈ 5.0s）是刻意的大数据量功能测试，14 核并发下拖尾影响有限，不建议为提速削减其覆盖。
- 测试中启动的 server / WebSocket / 定时器请在 `t.after()` 或 finally 中关闭，避免泄漏句柄拖慢 CI。

## 提交前自查清单

- [ ] 门禁全部通过：`pnpm check`（typecheck + ui typecheck + lint + format:check 聚合）、`pnpm test`、`cd ui && pnpm test`（完整清单见 `docs/development-standards.md` 附录 A）
- [ ] Commit 消息符合 Conventional Commits
- [ ] 新增 UI 文案已提取 i18n（en + zh-CN）
- [ ] 未引入 `any` / `@ts-ignore`
- [ ] 相关文档已更新（README、docs/ 等）
- [ ] 核心模块改动附有测试
- [ ] UI 变更已在 PR 中完成视觉验证（双主题 / 双语言 / 状态 / 响应式）

## 行为准则

请遵守开放、尊重的协作原则。本项目的沟通渠道（GitHub Issues、Discord、飞书、微信群）均适用此原则。

## 许可

通过提交代码，您同意您的贡献将以 [AGPL 3.0](LICENSE) 许可发布。
