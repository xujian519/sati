# Agent Note: 专利执行链补齐（答复、检索补检、无效证据模式、程序清单）

Status: implemented

## Problem

撰写链已有清晰度门、检索质量门、反套话门与附图门，但四类日常判断仍停在提示词层：

1. `patent_oa_response_v1` 的起草阶段没有原子。自动执行路径对无原子阶段回显整份输入，意见陈述书模板要求的「修改前 / 修改后 / 修改依据」没有代码核对。
2. 撰写链的 `search` 阶段只查一次；覆盖度判断只存在于创造性图。检索质量门检查报告里有没有 X/Y/A 标记和 IPC，不检查特征是否真的被文献覆盖。
3. 无效清单的新颖性、创造性没有原子，自动路径同样回显输入。直接接整张创造性图会执行检索，把请求人指定的证据换掉。
4. 复审与无效没有程序事项核验；复审期限算术已在 `deadline/`，但没有接到清单上。

## Decision

新增纯函数层与四个原子，全部由现有状态驱动，不新增工具入参：

- `src/patent/anchor/`：归一化只做全角/半角、空白折叠与中英文标点统一，保留到原文的偏移；命中是连续子串，同义改写不命中。
- `src/patent/oa/grounds.ts`：按法条与常用表述把理由分成新颖性、创造性、清楚、公开、超范围、单一性、未归类。
- `src/patent/oa/amendment-diff.ts`：从 `text` 的 `## original_application` 与 `## proposed_limitations` 两段逐条核对；缺段记 `not_checked`，不产出 `anchored`。
- `draft-oa`：只汇编对照表、缺口、理由与差分，不重新检索、不重新拆权利要求；引用不存在的要素或限定的争辩段落被丢弃并计数。
- `search-recall`：首轮检索后用与创造性图相同的提示词判断覆盖度，不足时按「旧查询 OR 缺特征」有界补检；轮次用尽仍缺记 `uncovered`，模型失败记 `not_evaluated`。质量门把这两种状态判失败。
- `invalidity-analysis`：图以 `evidence: "supplied"` 构建，不注册检索链；证据取自 claim-chart 的 `targets` 与 `rows`。空目标直接返回「未提供证据目标，已拒绝改为自行检索」，不编译图。
- `procedure-checklist`：清单第一行固定声明「不是复审请求书，也不是无效宣告请求书」；复审期限只取 `reexamination-request` 一条，待定时抄 `reason`，不渲染同次求值的其它条目；无效写「无对应期限条目」。
- `draft-oa` 在 `provider.caseId` 存在时把本轮产物写到 `data/cases/<caseId>/oa-rounds/round-N/`，只追加不覆盖。

## Alternatives considered

- **把整张创造性图接成无效清单的一个阶段。** 落选。图内有检索节点和自己的审批门，会替换请求人证据并造成双重停住；证据模式要在图构建选项上显式表达。
- **靠删除注册表里的 search handler 表示证据模式。** 落选。开关不在类型里，后续调用方换一个注册表就会静默恢复检索。
- **答复结束时调用 `recordRevision`。** 落选。`answered` 为空或对不上未决缺口都会抛 `DocketError`；自动跑完一轮不等于人已回答缺口。
- **为原申请文本新增工具字段。** 落选。会改 `inputSchema`，触发 llm-replay 重录；改用 `input` 内的两段固定标题。
- **撰写检索失败时沿用创造性图的放行口径。** 落选。审查分析里模型失败仍放行是既有行为，本计划不改；撰写侧新增的补检采用相反口径（失败即未评估），两套口径并存并在此记录，避免以后「顺手统一」。
- **中国附图字高提升到 3.5 mm。** 落选。`figuregen/check.ts` 已记载 3.5 mm 是纸件申请正文的要求，不是附图专有条文；cnipa 继续用 2.0 mm 的实践下限。

## Consequences

- 答复链多了两个阶段（`classify_grounds`、`amendment_diff`），`draft` 改为原子。旧断点与未完成运行对不上新阶段，需要重跑。
- `search-recall` 替换了撰写清单 `search` 阶段的 `patent-search-commander` worker：补检输出与 worker 的检索式字段契约不同，保留会变成永真的校验失败。
- 内置原子从 19 增至 25；`tests/patent/atoms.spec.ts` 与 `docs/code-facts.md` 由生成器同步。
- 锚点是保守判据：合理的上位概括会被判 `unsupported`，由人工确认，不自动改写限定。这是有意的。
