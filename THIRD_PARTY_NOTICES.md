# THIRD-PARTY NOTICES — Sati

本文件列出 Sati 再分发（源码分发、DMG/安装包分发）中包含的第三方作品及其许可证义务。
This file lists third-party works distributed with Sati and their license obligations.

Sati 自身采用 **GNU Affero General Public License v3.0 (AGPL-3.0)**，完整条款见 [`LICENSE`](./LICENSE)。

---

## 1. 直接并入的第三方代码（Copied / Ported Code）

### 1.1 PilotDeck — AGPL-3.0

Sati 的代码基础源自 [PilotDeck](https://github.com/OpenBMB/PilotDeck)（最初为
[Gucc111/PilotDeck](https://github.com/Gucc111/PilotDeck)，后由清华大学 THUNLP 实验室、
面壁智能、OpenBMB 与 AI9Stars 联合研发并开源），采用 **GNU AGPL v3.0**。

按 AGPL-3.0 要求，保留原项目版权归属声明；Sati 的修改与再分发继续遵循 AGPL-3.0 条款。
Sati 基于其聚焦专利业务场景独立发展，与上游无隶属关系。

### 1.2 自有项目移植（版权归 Sati 作者）

以下模块移植自 Sati 作者自有的开源项目（版权归 **徐健 <xujian519@gmail.com>**），
并入 AGPL-3.0 项目后按 AGPL-3.0 再分发：

| 模块 | 来源项目 | 来源项目许可证 |
|---|---|---|
| `src/patent/graph/`（图引擎 SuperStep 执行引擎） | Mady（`graph/pregel.go` 等） | MIT |
| `src/rule/`（宪法规则引擎设计）、`assets/patent-rules/`、`src/tool/` 角色感知裁剪设计 | BCIP（`codex-patent-constitutional`） | MIT |
| `rules/patent/nuo-*.yaml`（确定性规则）、知识库产物接入设计 | XiaoNuo Agent（`data/rules/`） | MIT |
| `src/patent/data/nuo/`（专利数据采集层，vendor 目录） | nuo-patent / Nuo | MIT / AGPL-3.0 |

> nuo-patent 基于 [ryanlstevens/google_patent_scraper](https://github.com/ryanlstevens/google_patent_scraper)
> （MIT）重构，其 MIT 版权声明保留于 `vendor/nuo-patent/LICENSE`。

---

## 2. 主要第三方依赖（Runtime Dependencies）

以下依赖经由包管理器随 Sati 分发，其许可证以各包自带的 `LICENSE` 文件为准（本表为概述）：

| 包 | 许可证 | 用途 |
|---|---|---|
| mupdf | **AGPL-3.0-or-later** | PDF 解析/渲染（与 Sati 同为 AGPL，兼容） |
| @google/genai | Apache-2.0 | Gemini 模型接入 |
| sharp | Apache-2.0 | 图像处理 |
| pdfjs-dist | Apache-2.0 | PDF 前端渲染 |
| react / react-dom | MIT | UI 框架 |
| express | MIT | Web 服务端 |
| @modelcontextprotocol/sdk | MIT | MCP 客户端 |
| @octokit/rest | MIT | GitHub API |
| @larksuiteoapi/node-sdk | MIT | 飞书渠道 |
| @vscode/ripgrep | MIT | 全文检索 |
| better-sqlite3 | MIT | SQLite 存储 |
| i18next | MIT | 国际化 |
| exceljs | MIT | Excel 处理 |
| node-pty | MIT | 终端 |
| fuse.js | Apache-2.0 | 模糊搜索 |
| js-tiktoken / csv-parse / undici / turndown / ws | MIT | 各类基础设施 |
| yaml | ISC | YAML 解析 |
| typescript | Apache-2.0 | 构建工具（dev） |

> 完整依赖清单与许可证请参阅各包 `package.json` / `LICENSE` 及 `node_modules` 内随附文件。
> 本表仅列主要项，未穷举所有传递依赖（transitive dependencies）。

---

## 3. 合规要点（How to Comply）

1. **保留版权声明**：以上所有作品的版权与许可证声明须随再分发保留（本文件 + `LICENSE` + `vendor/nuo-patent/LICENSE`）。
2. **提供源代码**：GitHub 开源仓库即满足 AGPL-3.0 §6 的源码提供义务（对应发布版本的完整源码）。
3. **修改声明**：移植自上游的源文件头部已注明来源（如 "移植自 Mady graph/pregel.go"），满足 AGPL-3.0 §5 的显著修改声明要求。
4. **网络分发**：若第三方将 Sati 部署为 SaaS，其修改同样受 AGPL-3.0 §13 约束（须开源）。

---

© 2026 徐健 &lt;xujian519@gmail.com&gt;
