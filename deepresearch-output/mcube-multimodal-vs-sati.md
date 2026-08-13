# M-Cube 多模态深度使用研究 × Sati 专利域对照

> 深度研究报告 | 2026 年
> 研究对象：`yycyyv/M-Cube`（M³, MIT License, 202 星）——Multi-thinking, Multimodal, Multi-verification 专利撰写助手
> 方法：GitHub 源码级拆解（`/tmp/M-Cube` 全量克隆，53 个 Python 文件）+ 领域文献（PatentVision EACL'26 / PatentLMM AAAI'25 / PatFig ICCVW'23 / 专利图分类 arXiv'25）+ Sati 本地代码对照（`src/patent/figure/`、graph/checker/evidence、模型层）

---

## 一、M-Cube 全景速览

| 维度 | 内容 |
|---|---|
| 定位 | 专利撰写助手（撰写/OA答复/现有技术对比/权利要求打磨 4 条工业级工作流） |
| 编排 | LangGraph 有向图 + 条件路由 + Checkpoint 断点续跑（HITL interrupt） |
| 技术栈 | Python 3.11 / FastAPI / Pydantic v2 / React 18 / Tauri 2 / PyMuPDF / Pillow |
| 核心三支柱 | ①Multi-thinking（多 Agent 对抗检查/链式展开/逻辑复审）②Multimodal（视觉模型读图）③Multi-verification（A33 红线 + 防幻觉锚点） |
| 多模态默认模型 | qwen-vl-plus / qwen-plus（CLI 示例），provider 可插拔（openai/qwen/doubao/kimi…） |

M-Cube 对多模态的"深度使用"不在模型本身（就是通用视觉 LLM），而在**编排层**：图像注入管线、模态自动路由、自适应提取、图文交叉验证、多级容错降级、HITL 把关。这是最值得 Sati 借鉴的部分。

---

## 二、M-Cube 多模态实现拆解（源码级）

### 2.1 图像注入与模型路由（`agents/base_agent.py` + `services/llm_factory.py`）

**图像注入三键约定**：任何 agent 只需在 context 里放 `image_paths` / `application_image_paths` / `prior_art_image_paths` 之一，基类 `_inject_image_payloads` 统一读文件 → base64 → 注入 `_image_payloads`。**provider 适配层与文件 IO 解耦**，新增视觉节点零成本。

**预算控制**：`LLM_MAX_VISION_IMAGES`（4~8 张）+ `LLM_MAX_VISION_IMAGE_BYTES`（4 MiB/张）双上限。

**格式归一化**：PNG/JPEG 直通；TIFF/BMP/WEBP 等经 Pillow 统一转 PNG（视觉端点兼容性优先）。

**⭐ 按模态自动路由模型**：`_pick_model_for_context` —— 有图像负载即切换到 `vision_model`，否则用 `text_model`。**同一上下文两模型透明切换，调用方无感**。

**⭐ 多级 provider 兼容 fallback**（实战血泪）：
1. 标准 OpenAI `image_url` 对象格式
2. 失败 → `image_url` 纯字符串格式
3. 再失败（qwen）→ 去掉 system role、schema 内联到 user text
4. **关键经验：多模态请求绝不发 `response_format=json_object`**（部分兼容端点 400），只对纯文本请求开启

**⭐ 结构化输出自愈链**（`run_structured`）：
```
LLM 原始输出
  → strict JSON 检查（去 code fence/前缀标签）
  → 失败 → 同 LLM 二次修复调用（_attempt_json_repair，带 schema+parse_error）
  → 仍失败 → 平衡括号抽取 → 启发式修复（_repair_json_text）→ ast.literal_eval
  → Pydantic 校验 → schema-drift 自愈（补默认值/丢未知键，内存重试一次）
  → 全部失败 → 确定性最小兜底结构（不中断工作流，标记"需人工复核"）
```

### 2.2 文档图像管线（`tools/doc_parser.py`）

- **PDF 内嵌图**：PyMuPDF `page.get_images` → SHA1 去重 → 跳过矢量/未知格式（jbig2/emf）→ `_is_primary_candidate` 尺寸过滤 → 落盘
- **DOCX**：`word/media/*` 遍历，同样去重+过滤
- **扫描 PDF**：文本不足阈值 → 页渲染为图 → **LLM OCR fallback**；无文本 PDF 返回稳定标记 `[NO_EXTRACTABLE_TEXT_IN_PDF]` 而非报错，让下游继续走视觉数据
- 每图带 `caption_hint`（文件名+页码），供 prompt 上下文

### 2.3 多模态 Agent 节点（四条工作流各有深度）

**① Drawing Analyzer（撰写，`agents/drawing_analyzer_agent.py`）**
- 图分类（Flowchart / Block Diagram / Mechanical View / Circuit Diagram / UI Mockup…）
- **⭐ 自适应元素提取**：机械图→附图标记+部件名；流程图→步骤号（S101）+动作；框图→模块名/数据库/服务器节点
- 关系/流向映射（物理连接、数据流、电连接、逻辑顺序）+ 整体理解
- **无图/视觉失败 → 优雅降级**：返回带 `warnings` 的空 `DrawingMap`，工作流继续（非阻塞节点设计）

**② Prior Art Visual Analyzer（OA，`oa_visual_analyzer_agent.py`）**
- 申请图（≤2 张）+ 对比文件图（≤4 张）**跨文档交叉对比**
- 输出 `PriorArtVisualDiff`：feature_name + application_evidence + prior_art_evidence + difference_assessment（结构性/连接性差异判断）
- ⭐ `DEFAULT CONCESSION` 策略：默认假定审查员结论基本正确，先确认支撑面（为修改铺"地雷图"），只对证据确凿不足时列 disputable

**③ Multimodal Prior-Art Agent（OA 定向阅读，`agents/oa_agents.py`）**
- RAG 检索对比文件段落 + 图像同时注入
- `SupportingItem`：prior_art_text_disclosure + **prior_art_visual_disclosure**（要求极细：物理形状/结构连接/相对位置）+ amendment_avoidance_warning
- `DisputableItem`：examiner_assertion + **multimodal_reality_check** + rebuttal_angle
- regex `图\s*\d+` 抽取图号引用
- ⭐ **`image_recognition_report` 审计**：提取总数 / 实际用于视觉数 / 截断数，可追溯"模型看了几张图"

**④ Prior-Art Stress Tester（红队压测，`prior_art_stress_tester_node`）**
- ⭐ **MULTIMODAL LETHALITY 协议**：每个回退特征同时经受文本+图形双重检验——**"图面强烈暗示该结构，即使无文字也判 ELIMINATED"**
- D1+D2 结合动机与显而易见性风险评估；存活者输出 rebuttal_foundation 供论证
- 内部多轮红队反思（MAX_REFLECTION_ROUNDS）

**⑤ Compare 工作流（`agents/compare_agents.py`）**
- `multimodal_draft_parser_node`：从权利要求+附图**反向工程**申请基准线，逐特征输出 **visual_anchor + visual_morphology**（物理形态+空间装配态）
- `multimodal_prior_art_node`：逐图分析对比文件，`reading_audit` 计数（input_image_count vs actually_used_image_count）防遗漏；连接关系不明确时强制输出"未明确记载连接方式"

### 2.4 多验证闭环（防幻觉/A33 红线）

| 节点 | 机制 | 亮点 |
|---|---|---|
| traceability_check_node | 逐特征 **verbatim quote** 溯源，Explicit/Implicit 分级 | 失败 → `_build_minimal_traceability_report` 确定性兜底（全标 Unsupported + 请人工复核），**不硬失败** |
| revise_claims_node | 仅手术式修复 Unsupported 特征（删除或概括到有支撑措辞） | CLAIM COUNT LOCK：禁止增删权利要求，只改措辞 |
| logic_review_node | 审查员视角 claims vs spec 语义支撑检查 | 输出精确 `patch_instruction`（告诉下游在哪加什么句子） |
| targeted_revise_spec_node | 按 review_issues 最小补丁改写 | 保留无问题章节原样 |
| human_review_node | LangGraph interrupt + API resume | 提交 approved_claims 才继续 |
| 结构性保障 | 每个 agent 层 Pydantic v2 + 自愈 | 半结构化 JSON 不再断链（PR#8 正是为此） |

### 2.5 M-Cube 工程模式的"可迁移内核"（7 条）

1. **视觉失败永不 fail-fast**：降级 + warnings + 空结构 + 继续
2. **双层 JSON 修复**：LLM 二次修复 + 确定性兜底
3. **多 provider 兼容 fallback 链** + 多模态不发 json_object
4. **图片用量审计**（用了多少/截断多少）
5. **自适应提取**：按图类型切换提取模式
6. **跨文档图对比**（申请图 vs 对比文件图）
7. **幂等键 + CLI 输入预检**

---

## 三、Sati 现有图能力对照（差距矩阵）

### 3.1 Sati 已有且**优于** M-Cube 的能力 ✅

| 能力 | Sati 实现 |
|---|---|
| 两步法分析 | `analyze.ts`：Step1 分类/整体理解（低风险先行）→ Step2 组件/连接/标记提取（PatentVision 图文对齐 + PatentLMM 领域引导落地） |
| 电学深度分析 | `analyze-electrical.ts`：GB/T 4728 符号库注入（`symbols/electrical-symbols.yaml`）→ 元件/网络/网表提取 → `validator.ts` **确定性校验闭环**（对标 RDKit 防幻觉） |
| 多图一致性 | `multi-figure-consistency.ts`：跨图标号冲突、图号连续性、**图文对齐**（权利要求引用的标号必须出现在附图中）、跨图电气网络一致性、孤立网络检测 |
| 附图检索 | `index-store.ts` + `search_patent_figure` 工具（.sati/figures-index.json） |
| 图→撰写/校验闭环 | `draft_specification`（figure_analysis→drawing_descriptions）+ `validate_specification`（附图说明标号 vs 图识别标号一致性，无漏标/无悬空） |
| 图像预处理 | `preprocess.ts`：sharp 三级级联压缩（1600px/q80→1200px/q55→800px/q40），标号可读性优先 |
| 模型层 | kimi-k3 多模态旗舰已入 catalog（1M 上下文）；流式收集、thinking 模型 temperature 处理 |

### 3.2 Sati 缺失 / 可借鉴 M-Cube 的点 ❌

| # | 差距 | M-Cube 做法 | Sati 现状 | 影响场景 |
|---|---|---|---|---|
| 1 | **对比文件（现有技术）附图分析** | `PriorArtVisualReport`：申请图 vs 对比文件图跨文档对比、图号引用抽取 | 仅单图 `analyze_patent_figure`，无"申请 vs D1/D2 附图"对比 | OA 答复、新颖性/创造性对比（A22.2/A22.3）|
| 2 | **权利要求特征→附图视觉锚点** | `visual_anchor` / `visual_morphology`（逐特征反向工程） | figure_analysis 与 claim-chart/evidence 未打通 | 特征对比表、答复论据支撑 |
| 3 | **视觉失败降级是节点级而非全局** | 非阻塞节点设计 + warnings 传播 | analyze.ts 单次降级，但工具/工作流层面未见"空 DrawingMap 继续"语义 | 批处理、多图长任务 |
| 4 | **按模态自动路由** | 有图即切 vision model | 显式指定 kimi-k3 | 用户配置成本、混合场景 |
| 5 | **图片用量审计** | image_recognition_report | 无 | 透明度、成本控制 |
| 6 | **LLM 二次 JSON 修复** | _attempt_json_repair（带 schema 让 LLM 重写） | tryParseJson + 单次重试 | 半结构化输出断链 |
| 7 | **OCR token 注入** | （M-Cube 本身未做，但 PatentLMM 证明是关键增益） | prompts 强约束标号一致性，但无显式 OCR 输入 | 标号识别率、无文字标注的图 |
| 8 | **旋转归一化** | （M-Cube 未做；PatFig/DeepSeek-OCR 实验证明是最大痛点） | preprocess 无方向处理 | 竖版扫描件、翻转 PDF |
| 9 | **多类图分类的锦标赛法** | （M-Cube 未做；arXiv'25 MC-TS 思路） | FIGURE_TYPES 8 类 | 大规模附图分类成本 |

> 注：#7/#8/#9 是 M-Cube 也未解决、但**领域文献证实**的高价值方向（详见第五节文献证据）。

---

## 四、可借鉴与优化清单（含优先级）

### P0 — 高价值（直接提升专利实务质量，建议先做）

**R1. 新增「现有技术附图对比」能力（OA/三性核心）**
- 复用 `analyze.ts`/`preprocess.ts`，新增 `compare_patent_figure` 工具：输入申请图 + 对比文件图（各 ≤4 张），输出 `PriorArtVisualDiff[]`（特征级 application/prior_art 证据 + 差异评估 + 图号引用）
- 接线：OA 答复工作流、`patent_case_search` 命中后自动带图对比；graph 域 novelty（A22.2 单独对比）与 inventiveness（A22.3 三步法）的对比节点加视觉证据

**R2. 逐特征视觉锚点（claim-chart ↔ figure 打通）**
- `claim-chart`/`evidence/claimBinding` 增加 `visualAnchor`：每个权利要求特征关联到 figure_analysis 的组件标号
- 效果：新颖性/创造性特征对比表自动带"图 2 标号 12 的 X 结构"，答复论据可落地

**R3. 图文交叉验证防幻觉门（把 figure_analysis 接入 graph 域）**
- 现状 `validate_specification` 已做附图说明一致性；扩展：
  - 说明书正文"参见图 N"引用 vs 实际存在图号校验（PatentLMM 已知失败模式）
  - graph 域的 enablement 节点可加"权利要求特征在附图中有无对应标号"检查（A26.3）

**R4. OCR token 注入（对标 PatentLMM 最大增益项）**
- PatentLMM 消融：OCR 全程注入 BLEU-4 从 19.17 → 36.66（**+91%**），无 OCR 推理时 -44%
- Sati 落地：`pdf-extract.ts` 已有基础，增加轻量 OCR（docTR/PaddleOCR/DeepSeek-OCR）提取图中文字与标号，作为结构化上下文注入 Step2/Step3 提示词
- 顺带解决"无文字标注的图"幻觉（PatentLMM 第 4 类错误）

### P1 — 工程健壮性

**R5. 模型按模态自动路由**
- Sati 模型层 `ModelRuntime` 增加：请求含 image 且当前模型无视觉能力 → 自动切 catalog 中 vision-capable 模型（或显式报错提示）
- 降低多模态工具的用户配置门槛

**R6. 图片用量审计**
- `analyze_patent_figure`/新对比工具返回 `usedImageCount / truncatedCount / imageIds`，写入 `index-store`，供成本与质量追溯

**R7. LLM 二次 JSON 修复**
- `src/patent/llm-json.ts` 的 tryParseJson 失败后，增加一次"带 schema + parse_error 的 LLM 重写"调用（M-Cube `_attempt_json_repair` 模式），再失败才降级

**R8. 旋转归一化（preprocess 增强）**
- 0/90/180/270 四向探测（低成本 probe：128 token 输出）+ **已知标号匹配打分**（说明书标号集合 vs OCR 结果，命中最多者胜）——Chyuang 实测 7/8 正确率，碾压 Tesseract OSD（4/8）与 OpenCV 文本线检测

### P2 — 场景扩展

**R9. 附图类型分类锦标赛（MC-TS）**：大类别分类时把全量选项拆子集逐轮投票（arXiv'25 证明优于开放问答，20 选项时多选题会退化，5 选项最优）

**R10. 扫描 PDF 的 LLM OCR 兜底**：文本不足阈值 → 页渲染 → 视觉模型读页（M-Cube 模式），与 R4 共用管线

**R11. 视觉降级语义标准化**：定义 `vision_warnings` 事件通道（类似 M-Cube），工具层统一"视觉失败 → 降级结构 + warnings + 可继续"，而非单点报错

---

## 五、领域文献证据链（支撑 R 建议）

**PatentVision（Samsung, EACL 2026）** — claim+diagram→specification
- 图像预处理：旋转校正 + 最长边 4096px；**分辨率与生成质量正相关**（256→4096 全程提升）
- LoRA 微调：rank 32/64/128 最优；rank 256 不收敛；Gemma 3 3 epoch 最优（4 epoch 过拟合）
- 结构化标签 `<comp_name>`/`<comp_num>`/`<fig_num>` 嵌入文本——**显式语义锚点**（与 R2/R3 同构）
- 无图描述时仍优于带描述的纯文本基线——视觉直接理解真实有效

**PatentLMM（AAAI 2025）** — 附图描述生成
- PatentMME：LayoutLMv3 初始化 + OCR token + 布局感知掩码（LAMIM/PC 损失），5 元素检测（nodes/node labels/text/arrows/figure labels）
- 关键数字：微调后 Avg BLEU 44.59 vs LLaVA-1.5 34.37；**OCR 全程注入增益 +91%**
- 5 类错误模式（Sati 校验器可直接对号入座）：
  1. 图标注幻觉（标号错读，如 Fig20→2C）
  2. 无 OCR 文本图的描述幻觉
  3. 标号↔节点关联错误（wiggly arrows 被下采样破坏）
  4. 节点标号幻觉（同前缀编号扩散，如 200→300）
  5. **跨图引用幻觉**（单图训练模型无法跨图关联）
- 未来方向 = 文档级推理（跨图）+ 外部知识库 RAG + grounded description —— 正是 Sati multi-figure-consistency 与 knowledge.db 的结合点

**PatFig（Qatent, ICCVW 2023）**
- 附图旋转是真实痛点；OCR 四库对比 docTR 最优（72%）；**已知标号匹配**可校正旋转
- 附图类型抽取：412 类 → 归一化层级

**专利图分类（TIB Hannover, arXiv 2501.12751）**
- MC-TS 锦标赛分类：5 选项子集逐轮投票，优于开放问答与全量多选；10 类 Type 达 87.98%
- 少样本（≤150/类）即可收敛——Sati 若做图分类微调成本可控

**Chyuang OCR 实测（US11423567B2，2025-03）**
- DeepSeek-OCR 裸跑：旋转文本乱码（"Accurling"→"Acquiring"）、61↔19 混淆、网格线幻觉 225 个 "+"
- 三向旋转 + Figure 标签过滤 + **已知标号匹配**：7/8 正确
- Google Vision API 一次性全对（$0.0015/张）——云端兜底选项

---

## 六、结论

1. **M-Cube 的多模态"深度"在编排层而非模型层**：图像注入管线、模态自动路由、跨文档图对比、图文交叉验证、多级容错降级、HITL 把关 —— 这套工程模式完全可迁移到 Sati 的 TS/Node 栈（成本主要在 prompt 与协议设计，不在框架）。

2. **Sati 的图能力在"单图理解深度"上已反超 M-Cube**（电学符号级+确定性校验+多图一致性是 M-Cube 没有的），最大缺口在**"跨文档图对比"（现有技术附图）**与**"图到权利要求特征的锚定"**——这两点恰好是 OA 答复与三性分析的核心实务场景。

3. **建议行动序**：R1（现有技术附图对比工具）→ R4（OCR 注入，增益最大且已具管线基础）→ R2/R3（视觉锚点+图文防幻觉门接入 graph 域）→ P1 工程健壮性四件套（路由/审计/JSON 修复/旋转归一化）。其中 R1/R4 可并行开工。

4. **文献为证**：PatentLMM 的错误模式直接映射 Sati 校验器规则清单；PatentVision 的"分辨率+结构化标签"实验支撑 preprocess 与 prompt 设计决策；MC-TS 与 OCR 匹配法为图分类/旋转问题给出低成本解。

---

*研究元数据：源码分析 53 文件（M-Cube）+ 12 文件（Sati figure 域）+ 5 篇文献（PatentVision/PatentLMM/PatFig/图分类/OCR 实测）+ GitHub issues/commits/PR 全量检视。覆盖角度：①M-Cube 多模态实现细节 ②图文交叉验证机制 ③多 Agent 编排 ④Sati 现有能力对照 ⑤可借鉴优化清单。*
