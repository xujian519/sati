# Agent Note: 附图标注面板评审修复批次（7 条后续中的 6 条）

Status: implemented

## Problem

PR #567 合并后，issue #566 的「已知未修」清单被拆成 #568–#574 七张票。其中六张是面板在真实使用面上会咬人的缺陷：

- 图面固有尺寸用 `parseFloat` 读 `width`/`height`，`"100%"`/`"210mm"` 的数值部分被当像素，画布与导出尺寸随之失真；
- 锚定按包围盒取最小包含盒、不看计算样式，会命中 `opacity:0`/`visibility:hidden` 的隐形辅助图元；
- `crypto.subtle` 只在安全上下文存在，局域网 http 访问时取哈希抛错，而哈希是图源就绪的前提——整块面板不可用；
- 提交时 `figure.sha256` 记的是**当前图**，提示块也没有「这些标注画在旧版图上」的信号；
- 提示块通用行说「source path 是编辑目标」，而标注引用的 source 恰恰是那张导出图，与同一块的标注纪律冲突；
- 已保存标注的异步读回会覆盖用户在读回前已经画好的内容。

## Decision

- **#572 带单位尺寸整体回退 `viewBox`**（`parsePixelLength` 只认无单位与 `px`）。不换算物理单位：面板要的是与绘制坐标自洽的参照系，`viewBox` 正是图自己的坐标系。
- **#573 命中遍历改为带可见性剪枝的 DFS**（`collectVisibleElements`）：`display:none` 剪整棵子树；`visibility` 逐元素判定、不剪子树（CSS 允许后代显式写回 `visible`，且浏览器给出的计算值已含继承）；`opacity` 不继承但沿树相乘，有效值为 0 时剪枝。遍历仍是文档顺序，「最小面积、同面积取更深」的择优规则不变。
- **#571 哈希双路径**（`figureContentHash`）：有 `crypto.subtle` 走 SHA-256，否则用纯 JS **FNV-1a 64** 指纹。文档新增可选 `figure.hashAlgo`（缺省读作 `sha256`，兼容已发出的 v1 sidecar，故不升 `FIGURE_ANNOTATION_VERSION`）；算法不同时两份摘要不可比，按「未失配」处理。
- **#568 绘制基线逐条记**：`FigureAnnotationMark.figureFingerprint`（`<algo>:<hex>`）在标注创建的那一刻盖上（`useAnnotatorState.addMark` 是唯一落章点），从 sidecar 载入的标注保留自己的基线。提示块在确有旧版标注时插一行告警，并给命中那条加行尾标记；编号恒按绘制顺序。
- **#569 提示块通用行按引用种类分派**：含标注引用时通用行带例外分句，标注引用的路径行改 `Exported figure: … (do not edit; regenerate from its generating source)`；text / cells / region 的 `Source:` 行与通用行原文不变。
- **#570 读回不覆盖**：编辑状态加 `touched`（画/删/改说明/清空置真、`seed` 归假），读回时若用户已落笔则不灌，并如实提示「已保存的 N 条未载入，重新打开图即可载入」。

## Alternatives considered

- **物理单位换算成 px（`210mm` → 794px）** — 落选。结果自洽但与 `viewBox` 无关：画布尺寸不可预测，与既有 sidecar 里那份坐标系也不可比。
- **命中判定只读元素自身的 `opacity`/`visibility` 属性** — 落选。Illustrator / Inkscape 常用 `<style>` + `class` 上色与隐藏，只读属性会漏掉写在类里的隐形。
- **纯 JS 实现真 SHA-256 作为兜底** — 落选。仓库不欢迎手写密码学实现，而这里只需要回答「文件是否变了」；带算法名的非加密指纹更诚实。代价如实记：跨算法打开旧 sidecar 会丢一次 stale 提示。
- **把基线记在文档级（`figure.sha256` 改义为「标注所依据的版本」）** — 落选。用户重新画过一遍后重开仍会一直报 stale（行为倒退），而且同一文档里可能同时存在载入的旧标注与新画的标注，文档级说不清。
- **读回与用户已画内容合并** — 落选。两侧标注 id 由不同会话生成，合并会造出不可撤销的混合清单，既不能整批撤销，也说不清每条是谁画的。
- **读回完成前阻塞交互** — 落选。为一个小概率竞态给每次打开图都加一段等待，代价大于收益。
- **干脆取消失配检测** — 落选。stale 提示是「标注 → 改生成源」这条闭环的前提，退化会让旧坐标无声地喂给模型。

## Consequences

- **测试**：`figure-dom.spec.ts`（带单位尺寸整体回退、隐形图元不抢命中，后者经反向验证——去掉剪枝即转红）、`export.spec.ts`（FNV-1a 64 参考向量、两条哈希路径）、`useSavedAnnotation.test.tsx`（同算法比摘要、跨算法不比）、`annotationReference.spec.ts` 与 `contentReference.spec.ts`（逐条基线校验、告警行与行尾标记、通用行分派）、`useAnnotatorState.test.tsx`（`touched` 与落章）。新增 `FigureAnnotator.test.tsx` 是本面板第一个视图级测试，锁的是「读回竞态不覆盖已画内容」，同样经反向验证。
- **如实记的边界**：① stale 状态下用户新画的标注会盖上当前图指纹，与载入的旧标注混在一起，提示块措辞是「部分标注基于旧版图」——对混合集合诚实，但不区分具体哪条是旧的；② stale 提交后 sidecar 的 `figure.sha256` 变为当前图，重开不再显示横幅，但旧标注自身的指纹仍在，提示词告警照旧；③ 算法不同的 sidecar 不做失配比较，跨环境打开会丢一次提示（刻意的「宁可漏报不误报」）；④ 命中判定改为逐元素 `getComputedStyle`，大图上的耗时未单独实测——命中只在 `pointerup` 触发，不在 `pointermove`；⑤ `.svg` 原区域引用入口仍缺（#574，另一个 PR）。
- **门禁联动**：未触工具 `inputSchema`（无 fixture 重录）、未触 `AgentEvent` / gateway frames（无事件矩阵改动）、未触网关协议。`figureFingerprint` 与 `hashAlgo` 均为可选字段，`FIGURE_ANNOTATION_VERSION` 不升，旧 sidecar 与旧引用载荷照常解析。
