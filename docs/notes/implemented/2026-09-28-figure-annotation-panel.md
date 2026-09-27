# Agent Note: 附图标注面板（在图上圈画 → 标注图 + 逐条说明交给智能体）

Status: implemented

## Problem

专利附图的返工意见通常是「这个标号指错了」「这里少一个件」「这条线该连到那边」。用文字描述这类空间关系既慢又容易误解，而模型拿到一句话后仍要自己猜位置。Sati 已有的输入面都不覆盖它：

- `patent_figure_generate` + `figure-gate` 只管**生成与核验**（FigureSpec → SVG → 确定性规则门），不接收"图上哪一处不对"的人工意见；
- 图片预览的**区域引用**（`ImageRegionContentReference`）只能给"一张图里的一个矩形"，没有多条标注、没有逐条说明、没有"落在哪个图元上"；
- 附图默认落在 `.sati/figures/`，而该目录**同时**被文件树跳过（`fileTreeSkip.js` 的 `.sati*` 规则）与 artifact 采集判为硬内部路径（`FileArtifactCollector.isHardInternalPath`），所以"打开图来标注"这条入口本身也需要一条可点击路径。

参考实现是姊妹项目 deepseek-harness 的第三方插件 `dsh-figure-annotator`（Host 半 + Client 半的 Cordis 插件，约 2.6k 行）。它的形态**不能直接搬**：Sati 的 UI 没有插件注册表（`src/extension/` 的贡献点只有 Prompt / Router），且铁律禁止 `ui/` 导入 `src/`。

## Decision

在 UI 内建一个**附图标注面板**，接管 `.svg` 的编辑器预览，把"标注图 + 逐条说明 + 图元锚定"经**既有内容引用通路**交给智能体。

**范围与入口**：`CodeEditorBinaryFile` 里 `isSvgFigurePath(file.name)` 分支渲染新的 `FigureAnnotator`，其余图片仍走 `ImagePreview`（理由见 Alternatives：不让新面板顶掉已有的区域引用）。入口无需新造：会话里输出的附图路径本就经 `linkifyFilePathsOutsideCode` 变成可点击链接，聊天里的生成文件卡也有 Browse；两者都以 `.svg` 落到编辑器，于是自动进标注器。

**数据契约**（单一事实源：`ui/src/types/annotationReference.ts`）：

- sidecar `<图名>.annot.json`（`FIGURE_ANNOTATION_VERSION = 1`，与图同目录），含 `figure`（绝对路径 / 媒体类型 / 固有尺寸 / **内容 sha256**）、`marks[]`（`kind` / `color` / `points`(图面像素) / `text` / 可选 `anchor`）、`createdAt` / `updatedAt` / `summary`；
- 引用载荷 `FigureAnnotationContentReference`：`selectionMode: "annotation"`（新增判别式，与"可发起的选区模式" `ContentReferenceSelectionMode` **分开**——后者驱动选区菜单与 capabilities 表，混入标注会污染它们）、`locator.surface: "figure"`、`image`（审阅图，仅 composer 侧带 dataUrl）、`annotation.document` + `sidecarPath`。

**坐标不变式**：标记坐标恒为**图面像素**（原点在图左上角），与缩放、面板宽度无关——同一条标注在任何视图比例下含义相同，也让"图被重画后坐标是否失准"成为一个可判定的问题。

**锚定相对参考实现做了升级**：内置渲染器把节点写成 `<g id="n-<nodeId>" data-ref="<标号>">`，因此命中后直接产出 `{nodeId, ref}`，而不是参考实现那种"最近一个有 id 或 `<title>` 的祖先"启发式。`nodeId` 与 `ref` 正是 FigureSpec 的节点身份，智能体据此能改生成源而不必猜图面坐标。命中的是**导出的位图之外**的活 DOM：图被内联进文档（先 sanitize：删 `script`/`foreignObject`/`on*`/非 `#`/`data:` 的外部引用），因为无填充线条的浏览器原生命中会把大多数位置答成根元素。

**送达**：往 composer 派发 `ADD_CONTENT_REFERENCE_EVENT`（`sati:add-chat-reference`）——与 PDF 选区 / 表格选区 / 图片区域完全同一条通路，由用户按发送键决定何时发出。既有链路自动接住：`formatContentReferencePromptBlock` 生成智能体读的区块（图路径、sidecar 路径、标注图附件名、逐条编号标注、纪律约定、`Reference JSON`），`contentReferenceImage` 把审阅图作为图片部分送进模型。**纪律约定随消息走**（Sati 没有 system-prompt section 注册面，参考实现的那种"插件注入系统提示"在这里没有落点）：改生成源而非涂改位图、未标注处不动、逐条回应、改完复核坐标。

**不失配就不丢标注**：载入时按 sha256 与 sidecar 比对，图被重画则显示告警并**照旧载入**标注（坐标可能失准，锚定与文字仍可读）。

**不落盘审阅图**：只有 sidecar 落盘（走既有 `PUT /api/projects/:name/file`），审阅图以 data URL 挂在引用上、提交时变成多模态图片部分——因此**不新增后端路由、不动网关协议、不加工具 schema**（无 fixture 重录、无事件矩阵改动）。

## Alternatives considered

- **把 `dsh-figure-annotator` 原样作为插件搬进 Sati** — 落选。Sati 的 UI 没有插件注册表（`src/extension/` 的贡献点只有 Prompt / Router，`ui/` 侧只有 `plugins.js` 这个后端插件路由），而铁律禁止 `ui/` 导入 `src/`；参考实现的 Host 半（Cordis `ctx.get('webServer')` + `dsh-resource://` 地址 + Session 目录解析）在 Sati 里没有对应物。其 Client 主体（Canvas / render / export / sanitize）无框架依赖，故按 Sati 的 feature-folder 约定重写接线、复用其算法与不变式。

- **新增网关方法保存标注（协议 MINOR → 1.12）** — 落选（本阶段）。A 阶段只有"写 JSON + 发引用"两件事，既有文件接口与事件通路都已覆盖；引入协议变更要连带 `check:protocol-version` / 事件矩阵 / doc-claims。真正需要协议面的是"智能体主动请用户在图上标注"（HITL 审图）那一类需求，留给后续方案。

- **复用 `ImageRegionContentReference`，把标注清单塞进 `nearbyText`** — 落选。零改动很诱人，但语义借用：`nearbyText` 的契约是"该区域附近的原文"，把编号标注清单塞进去会让提示块结构与字段含义脱钩，且 `Reference JSON` 里仍缺标注数据，后续维护者无法从字段名读懂。新增一个判别式反而把"标注"变成一等引用种类。

- **标注器接管所有图片（含 PNG/JPEG）** — 落选。栅格图没有图元锚定，且会顶掉 `ImagePreview` 现有的**区域引用**能力（同一文件类型上出现两条重叠通路，还丢一个既有能力）。故只接 `.svg`；栅格图的"圈一块发给模型"继续由区域引用承担。参考实现支持栅格的部分留在常量注释里，作为后续选项。

- **由面板直接把消息投递给会话（参考实现的 `session.prompt`）** — 落选。Sati 的既有约定是"预览面板 → 引用 → 用户按发送"（`sati:add-chat-reference` / `sati:add-workspace-file-mention` 皆如此）；面板私自投递会绕开用户的发送时机与忙碌队列语义。

- **审阅图也落盘 `<图名>.annotated.png`** — 落选（本阶段）。落盘二进制要走另一条上传通路，而它的唯一消费者是模型输入（已由 data URL 覆盖）。代价是历史消息里只有一个缩略引用 + sidecar 可回看，图本身要重新导出才能看到——如实记在此处。

- **用 mtime/size 判"图已被重画"** — 落选。重画常常保持尺寸，mtime 又会被 `touch`/检出误触发；内容 sha256 才对应"我标注的那张图是否还是现在这张图"。

## Consequences

- **正向**：专利附图有了"在图面上直接圈画 + 逐条一句话 + 落到具体图元"的输入面，且标注与生成源之间是机器可读的映射（`nodeId`/`ref` → FigureSpec 节点）。端到端实测（隔离实例 + 真实渲染器产出的附图）：画箭头 → 提交 → 智能体收到 `1. arrow (137,51) -> (200,51) (node=n2, ref=34): …` 与 base64 审阅图，并按 node/ref 完成了核验、逐条回应、对被省略的第二处标注明确拒绝"猜改"。
- **实测量到的降级面**：该配置的模型**无图像输入**，它明确说明"cannot eyeball inv-fig1.annotated.png"，完全靠结构化清单 + sidecar 完成核验。这正是参考实现文档里写明的降级路径，说明"编号清单 + sidecar"必须一直是完整信息源（实现里已如此，未把信息只放在图里）。
- **代价与已知缺口**：① 只有 SVG 图能标注；② 审阅图不落盘；③ `source.relativePath` 沿用编辑器给的路径形态（绝对或相对，与既有区域引用一致），字段名与取值在此处不完全对齐；④ `.sati/figures/` 默认输出目录既不在文件树、也不进 artifact 采集，那一处附图要从会话里的可点击路径进入（用 `output_dir`/`case_id` 落到可见目录则同时有文件卡入口）。
- **门禁联动**：新增 UI 源码改变技术债基线（已同 PR `pnpm measure:update`）；未触工具 `inputSchema`（无 fixture 重录）、未触 `AgentEvent`/gateway frames（无事件矩阵改动）、未触协议（无版本变更）。文案进 `codeEditor` 命名空间（`figureAnnotator` 子对象，en + zh-CN 同键）。
- **测试**：纯函数面（标注模型与校验、mark 几何、审阅图合成、SVG sanitize/尺寸/锚定）走单测；绘制面与编辑状态走组件/hook 测（含"提交用的文案键必须是命名空间下的短键"这条——浏览器验证时正是它抓到了一次双重前缀导致的键名直显）；绘制→提交的浏览器端到端验证在隔离实例上完成。
