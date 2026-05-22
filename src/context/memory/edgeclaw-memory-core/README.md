# edgeclaw-memory-core

PilotDeck 的记忆核心模块，提供会话记忆的存储、检索、提取和回顾能力。

本模块不可独立运行，由 PilotDeck 主进程通过 `createEdgeClawMemoryProviderFromConfig()` 加载。

## 目录结构

```
src/
├── core/
│   ├── types.ts              # 核心类型定义
│   ├── file-memory.ts        # 基于文件的记忆存储
│   ├── storage/sqlite.ts     # SQLite 存储后端
│   ├── skills/llm-extraction.ts  # LLM 记忆提取
│   ├── review/dream-review.ts    # 记忆回顾 (dream)
│   ├── pipeline/heartbeat.ts     # 心跳管线
│   ├── retrieval/reasoning-loop.ts # 检索推理循环
│   ├── general-projects.ts       # 通用项目管理
│   └── utils/                    # 工具函数 (id, text)
├── service.ts                # EdgeClawMemoryService 主服务
├── message-utils.ts          # 消息格式转换
└── index.ts                  # 入口 re-export
```

## 构建

```bash
npm install
npm run build      # 编译 src/ → lib/
npm run typecheck   # 仅类型检查
```

修改 `src/` 下源码后需重新执行 `npm run build`。
