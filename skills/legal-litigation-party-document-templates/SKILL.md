---
name: legal-litigation-party-document-templates
description: "按最高人民法院《当事人参考民事诉讼文书样式》起草当事人诉讼文书——从 105 份官方样式中选型、保留官方结构、按现行法核验条号，并通过 doc-template 输出 DOCX。当用户要写起诉状、答辩状、反诉状、上诉状、再审申请书、执行申请书、保全申请、管辖异议、回避申请、授权委托书或法定代表人身份证明时使用。"
---

# 当事人诉讼文书样式

1. 加载 `./.legal/practice/litigation-legal.md`，确认案件阶段、诉讼地位与内部风格。
2. 读 `references/catalog.md`，按阶段与主体类型选出唯一主样式。
3. 读对应的 `references/styles/<类目>/style-<id>.md`，以官方正文为骨架。
4. 按本技能流程起草、核验并渲染。

---

# 当事人诉讼文书起草

## 用途

本技能把最高人民法院官网“当事人参考民事诉讼文书样式”作为当事人向法院提交文书的格式基准。它解决两个问题：文书结构不靠模型即兴发挥；官方样式里的填写位、法定要素与附件要求不被遗漏。

## 先分清两套样式

最高人民法院“诉讼文书样式”栏目下有两支，用途不同：

- **人民法院制作民事诉讼文书样式**：判决书、裁定书、调解书、通知、公告、函等法院内部文书。当事人不得套用。
- **当事人参考民事诉讼文书样式**：起诉状、答辩状、反诉状、上诉状、再审申请书、执行申请书、各类申请书/异议书、授权委托书、身份证明书等当事人提交的文书。本技能只使用这一支。

选错分支会产生格式与身份双重错误，尤其是把“民事裁定书”模板当成“管辖权异议申请书”使用。

## 来源与效力边界

- 官方入口：<https://www.court.gov.cn/susong.html>，分支为“民事诉讼文书样式 → 当事人参考民事诉讼文书样式”。
- 本地目录：`references/catalog.md` 收录 32 个末级类目、105 份样式（官网“非诉程序”是分组节点，其下 11 个子类目已计入）；每份样式保存官网正文、【说明】、详情页 URL 与抓取日期（2026-10-26）。
- 官方样式统一发布于 2016-09-28。正文引用的《民事诉讼法》条号是当时的文本；2021 年修正后条号已有变化，2023 年修正又调整了涉外程序部分。**不得把样式中的旧条号直接写进法律论证。**
- 官网个别页面的标题、【说明】与正文不一致。遇到冲突先按正文的请求事项核对用户目标；无法确认时先问用户，并在交付摘要标注。已知冲突见 `references/catalog.md` 的“已知官网冲突”一节。不要仅凭标题选型。
- 样式中的条号只作定位线索。进入交付件的每一处法条、司法解释与案号，先经 `legal-research` 打开现行官方原文，再经 `legal-citation-check` 核验；交付前运行 `law_verify` 逐条做形式核验。
- 如果官网已发布更新版本，以官网新文本为准，并在 `matters/<slug>/research/evidence.jsonl`（无案件时 `./.legal/research/evidence.jsonl`）记录抓取时间与 URL；不要混用新旧版本。

## 选型

动手前确认六件事：

1. 案件阶段：起诉、应诉、一审中、上诉、再审、执行、非诉。
2. 当事人诉讼地位：原告、被告、反诉原告、上诉人、被上诉人、申请人、被申请人、案外人等。
3. 主体类型：公民、法人、其他组织。同名样式常按主体类型分成两份。
4. 受理法院与案由。
5. 要实现的程序动作：提交诉请、答辩、提出异议、申请保全、申请执行等。
6. 是否需要配套文书：授权委托书、法定代表人身份证明、证据清单、送达地址确认书。

选型规则：

- 先读 `references/catalog.md` 的“按诉讼阶段快速选择”，再用关键词在 `references/styles/` 中检索（例如“管辖权”“保全”“支付令”“执行异议”）。
- 同一动作有多个样式时，按主体类型与阶段选；仍不确定就用 `ask_user_question` 问用户，不猜。
- 选一份主样式。配套文书分别选对应样式，不把多份样式拼成一份。
- 官方目录中位置异常的条目（例如“管辖”类目下的“民事上诉状”）是官网原样，按文书的实际用途使用，不按类目名硬套。

## 起草

1. 读选中的 `references/styles/<类目>/style-<id>.md`，保留标题、当事人段落、正文顺序、“此致”、附件、签名与日期。可以调整排版与段落，不可以删掉法定要素。
2. 把 `×××`、`……`、`(写明……)` 替换为案件事实；官方样式的填写位不得原样留在正文。不得编造姓名、金额、日期、案号、证据或送达地址。
3. 无法取得的信息写 `[待填写：具体字段]`，并在交付摘要逐项列出；提交前用 `grep` 自查，`[待填写`、`×××`、`(写明` 必须清零。不要用“略”“同上”掩盖缺口。
4. 事实与理由按“请求权基础 → 要件事实 → 证据”组织；每项关键事实对应证据编号或材料来源。
5. 诉讼请求必须可执行：给付之诉写明金额、利息起算日与计算方式；行为之诉写明作为或不作为；确认之诉写明确认对象与范围。
6. 当事人信息按官方要求写全：自然人写姓名、性别、出生日期、民族、职业、工作单位、住所、联系方式；法人或其他组织写名称、住所、法定代表人/主要负责人、职务、联系方式。
7. 签名与盖章：自然人签名或捺印；法人加盖公章并由法定代表人/主要负责人签名。授权委托书、身份证明书按对应样式另附。
8. 副本份数按样式说明和法院要求填写：起诉状通常按被告人数提交副本，上诉状按对方当事人人数提交副本，答辩状按原告人数提交副本。

## 条号与期限

样式【说明】里的期限是 2016 年文本的表述，常见包括答辩 15 日、判决上诉 15 日、裁定上诉 10 日、再审 6 个月、申请执行 2 年。起草时逐项核对现行《民事诉讼法》及司法解释，并在交付摘要写明核验结果；无法核实的标为缺口，不写成确定结论。

## 渲染与交付

1. 选中核心模板：读 `templates/` 下同名 `.md`（见下表），按模板变量表填入已核实材料。
2. 没有对应核心模板：以 `templates/legal-party-document.md` 为骨架，把按官方样式填好的正文放进正文段，文书标题放进标题位。
3. 用 `docx` 技能把填好的 Markdown 渲染为 `.docx`（Sati 无通用 doc 模板渲染工具，`render_patent_document` 只服务专利文书）。
4. 文件写入 `matters/<slug>/output/`；过程稿留在 `matters/<slug>/work/`，不覆盖 `input/`。
5. 依次运行 `legal-quality-gate`、`legal-citation-check` 与 `law_verify`，再用 `grep` 自查占位符；对外发送时用 `send_attachment` 交付。交付摘要写：文件路径、选用的样式与官网链接、未核验条号、待补字段、副本份数与附件清单。
6. 对外提交前由当事人或执业律师复核并签名。本技能只生成草案，不代替律师审查。

## 核心模板

以下模板随本技能提供（`templates/`），填入变量后即可渲染；未列出的样式走通用模板。

| 模板名 | 对应官方样式 | 变量 |
| --- | --- | --- |
| `legal-civil-complaint-natural-person` | 民事起诉状（公民） | {{plaintiff_info}}、{{legal_agent_info}}、{{agent_info}}、{{defendant_info}}、{{claims}}、{{facts}}、{{evidence}}、{{court_name}}、{{copies}}、{{signature}}、{{date}} |
| `legal-civil-complaint-organization` | 民事起诉状（法人或者其他组织） | {{plaintiff_info}}、{{legal_representative_info}}、{{agent_info}}、{{defendant_info}}、{{claims}}、{{facts}}、{{evidence}}、{{court_name}}、{{copies}}、{{signature}}、{{date}} |
| `legal-civil-answer-natural-person` | 民事答辩状（公民） | {{respondent_info}}、{{legal_agent_info}}、{{agent_info}}、{{case_reference}}、{{defense}}、{{evidence}}、{{court_name}}、{{copies}}、{{signature}}、{{date}} |
| `legal-civil-answer-organization` | 民事答辩状（法人或者其他组织） | {{respondent_info}}、{{legal_representative_info}}、{{agent_info}}、{{case_reference}}、{{defense}}、{{evidence}}、{{court_name}}、{{copies}}、{{signature}}、{{date}} |
| `legal-civil-appeal` | 民事上诉状 | {{appellant_info}}、{{legal_agent_info}}、{{agent_info}}、{{appellee_info}}、{{appellant_name}}、{{appellee_name}}、{{cause}}、{{original_court}}、{{judgment_date}}、{{case_number}}、{{judgment_type}}、{{appeal_requests}}、{{appeal_reasons}}、{{court_name}}、{{copies}}、{{signature}}、{{date}} |
| `legal-civil-retrial-application` | 民事再审申请书 | {{applicant_info}}、{{legal_agent_info}}、{{agent_info}}、{{respondent_info}}、{{original_parties_info}}、{{applicant_name}}、{{respondent_name}}、{{cause}}、{{original_court}}、{{original_judgment_date}}、{{original_case_number}}、{{original_document_type}}、{{retrial_requests}}、{{retrial_facts}}、{{court_name}}、{{copies}}、{{signature}}、{{date}} |
| `legal-execution-application` | 申请执行书 | {{applicant_info}}、{{legal_agent_info}}、{{agent_info}}、{{respondent_info}}、{{applicant_name}}、{{respondent_name}}、{{cause}}、{{issuing_authority}}、{{case_number}}、{{document_type}}、{{performance_status}}、{{execution_requests}}、{{court_name}}、{{attachments}}、{{signature}}、{{date}} |
| `legal-jurisdiction-objection` | 异议书（对管辖权提出异议用） | {{objector_info}}、{{legal_agent_info}}、{{agent_info}}、{{case_reference}}、{{target_court}}、{{objection_reasons}}、{{court_name}}、{{signature}}、{{date}} |
| `legal-recusal-application` | 申请书（申请回避用） | {{applicant_info}}、{{legal_agent_info}}、{{agent_info}}、{{case_reference}}、{{recused_person}}、{{recusal_reasons}}、{{court_name}}、{{signature}}、{{date}} |
| `legal-property-preservation-application` | 申请书（申请诉讼财产保全用） | {{applicant_info}}、{{legal_agent_info}}、{{agent_info}}、{{respondent_info}}、{{respondent_name}}、{{case_reference}}、{{preservation_measure}}、{{preservation_target}}、{{preservation_period}}、{{preservation_reasons}}、{{guarantee}}、{{court_name}}、{{signature}}、{{date}} |
| `legal-authorization-letter-natural-person` | 授权委托书（公民委托诉讼代理人用） | {{principal_info}}、{{agent_names}}、{{recipients}}、{{case_reference}}、{{authority_scope}}、{{signature}}、{{date}} |
| `legal-legal-representative-certificate` | 法定代表人身份证明书（法人当事人用） | {{representative_name}}、{{company_name}}、{{position}}、{{contact_address}}、{{contact_phone}}、{{date}} |
| `legal-party-document` | 其余任意当事人样式 | {{document_title}}、{{body}} |

## 写作纪律

- 不改官方文书的法定要素与顺序；“此致”“附”“签名/盖章”“日期”不得省略。
- 不把人民法院制作文书样式用于当事人提交。
- 不在正式文书正文加入 AI 免责声明；免责声明放在交付摘要或内部说明。
- 不引用未核验的条号、案号、案例；不把检索摘要当作原文。
- 正式提交前，文书中的 `×××`、`……`、`(写明……)` 必须替换为事实；仍无法填写的 `[待填写：……]` 必须清零，或由用户明确确认保留原因。提交前用 `grep` 排查残留的 `×××`、`(写明` 与 `[待填写]` 标记；单独的 `……` 可能是合法的引文省略，交付前需人工核对它是否只是官方空白位。

## 文件

- 总目录：`references/catalog.md`
- 官方样式：`references/styles/<类目>/style-<id>.md`
- 可渲染模板：`templates/`（由 legal preset 的 `doc-template.templateDirs` 加载）

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
