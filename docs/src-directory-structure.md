# Sati 源码目录现状说明（src/）

> **定位**：本文件是 `src/` 目录的**现状体检说明**，不是新增规范。它回答一个问题——「源码目录为什么长这样？哪些是有意为之、哪些才真正值得动？」
>
> **与现有文档的关系**：本文件是 `CLAUDE.md`（不入库）「目录结构」与「编码规范」两节的**现状补充**——记录抽象规范在实际代码库里的**遵循情况 + 有意例外**。它**不引入任何新约束**，只记录事实与「为什么这里没按表面规范做」。

---

## 一、顶层总览

`src/` 当前为 **29 个功能模块** + 两个根级文件（`env.ts` 环境常量、`version.ts` 版本号）。每个模块自带 barrel（`index.ts`），入口为 `src/cli/sati.ts`，无顶层 `index.ts`。

## 二、模块组织模式：三派并存（且都合理）

| 模式 | 特征 | 模块 |
|---|---|---|
| **分层式** | `protocol/`（类型契约）+ `runtime/`（实现）+ `config/`（配置），模块内 `index.ts` barrel | agent, always-on, cron, lifecycle, literature, methodology, mcp, rule, task, workflow |
| **功能子域式** | 按业务语义拆出多个子目录，子目录内再各自组织 | adapters（channel/web）, patent（20+ 子域）, knowledge, model, session, context, tool, gateway, permission, router, cli, web |
| **扁平式** | 仅一两个文件，不做子目录 | fs, network, status, telemetry, browser（backend/）, test-support（llm-replay/）, shared（env/paths/retry） |

**为什么允许三派并存**：分层式是「重逻辑」模块的标准骨架；扁平式是「轻量工具」模块（fs/network 就是几个纯函数，套三层反而拉低可读性）；功能子域式用于「一个域内有明显语义切分」的模块（patent 域最重，20+ 子域）。这符合「重的域多分层、轻的工具扁平」的自然规律，**强制统一反而有害**。

## 三、命名规范遵循情况与实际例外

CLAUDE.md 规定的「目录 kebab-case、类文件 PascalCase、普通文件 kebab-case」在代码库里得到较高遵循，例如 `adapters/channel/` 下每个渠道统一为 `Channel.ts`（Pascal）+ `SessionMapper.ts`（Pascal）+ `-render.ts`（kebab）。

已识别、但**有意保留**的例外：

- **缩写大小写风格不一**（`adapters/channel/`）：`WeCom` / `QQ` / `WeChat` / `Tui` 等缩写写法不统一。属「品牌缩写选择」，不影响功能与阅读理解，统一会引入大量无收益的 import diff。
- **中文文件名卡片**：见 §五，属生成数据而非源码。

## 四、有意缺 `index.ts` barrel 的模块

`src/browser/`、`src/fs/`、`src/shared/`、`src/test-support/`、`src/web/` **没有**顶层 `index.ts`。经核实（全库 grep），这 5 个模块**无任何处按模块名导入**——`browser` 被按 `backend/` 深度路径加载，`test-support` 被 `tests/` 而非 `src/` 引用。缺 barrel 是**有意设计**（避免为无人消费的模块提供伪入口），不是疏漏。补齐反而制造一个"无人调用、看似统一"的误导性入口。

## 五、数据资产与源码的边界（整理时必须区分）

`src/knowledge/patent/wiki/patent-cards/` 下有 1500+ 篇**中文文件名**的 markdown 卡片。这些是运行时生成的知识卡片——**git 未跟踪（已核实为 0 条）**，属数据资产而非源码。

**整理源码目录时严禁当作源码处理这批文件**（不得移动/重命名/删除）。它们的命名、内容由生成流程决定。

## 六、已识别但未列入本轮的行动清单

以下点在体检中识别到，但按「浅层清理」力度保留不动，记此以供后续评估：

- `.DS_Store`（macOS 元数据）——已清理，见 §七，且已被 `.gitignore` 全局忽略（第 178-179 行）。
- 各模块子目录命名（`adapters/channel/qq` vs 类名 `QQ`）——纯风格，未动。

## 七、本轮已处理

- 清理 `src/` 下 4 个 `.DS_Store`（`./`、`knowledge/`、`knowledge/patent/`、`knowledge/patent/wiki/`）。因已被 `.gitignore` 忽略且未跟踪，删除不影响 git 与功能。

---

## 结论

`src/` 已遵循既有规范，**无系统性硬伤**。未来若做更大的「整洁化」重构，应先依据本说明判断目标是否属于「有意例外」——避免对已有意设计（扁平模块、无 barrel 模块、生成数据）做无收益的重构。
