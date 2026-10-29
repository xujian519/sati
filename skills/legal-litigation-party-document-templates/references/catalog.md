# 当事人参考民事诉讼文书样式目录

最高人民法院官网“诉讼文书样式”栏目下的“当事人参考民事诉讼文书样式”，共 32 个末级类目、105 份文书（官网“非诉程序”是分组节点，其下 11 个子类目已计入）。抓取日期：2026-10-26。

- 官方入口：<https://www.court.gov.cn/susong.html>
- 本目录对应分支：**民事诉讼文书样式 → 当事人参考民事诉讼文书样式**（不是“人民法院制作民事诉讼文书样式”）
- 每份样式文件都保留官网正文与【说明】；`style-<id>.md` 中的 id 是官网详情页编号。

> **效力提示：** 这些样式于 2016-09-28 发布，正文引用的《民事诉讼法》条号是当时的文本。起草时必须用 `legal_law_verify` / `legal-citation-check` 按现行法核对，不得直接沿用样式中的旧条号。

## 按诉讼阶段快速选择

| 阶段 | 首选文书 | 类目 |
| --- | --- | --- |
| 起诉/应诉 | 民事起诉状、民事答辩状、民事反诉状 | 第一审普通程序 |
| 程序异议 | 管辖权异议书、回避申请书、简易程序/小额诉讼异议书 | 管辖、回避、简易程序、简易程序中的小额诉讼 |
| 证据 | 调查收集证据、书证提出命令、证人出庭、鉴定、证据保全 | 证据 |
| 保全/先予执行 | 诉前或诉讼财产保全、行为保全、先予执行、解除保全 | 保全和先予执行 |
| 一审后续 | 追加当事人、增加/变更诉讼请求、撤诉、恢复诉讼 | 第一审普通程序 |
| 上诉 | 民事上诉状 | 第二审程序 |
| 再审 | 民事再审申请书 | 审判监督程序 |
| 执行 | 申请执行书、执行异议书、复议申请书、提级执行 | 执行程序 |
| 非诉 | 支付令、公示催告、司法确认、担保物权、人身安全保护令、监护权 | 督促程序、公示催告程序、非诉程序各类目 |
| 涉外 | 承认和执行外国法院判决/仲裁裁决申请书 | 涉外民事诉讼程序的特别规定 |

## 已知官网冲突

以下三份样式的官网标题、【说明】与正文互相矛盾。目录保留官网原样；选型时先核对用户目标与正文请求事项，不能确认时先问用户，并在交付摘要标注冲突。不要仅凭标题选用。

| 文书 | 冲突 | 本地文件 |
| --- | --- | --- |
| 民事反诉状（法人或者其他组织） | 官网【说明】误写为“供公民提起民事诉讼用”；标题与正文均为法人反诉状。 | [style-203.md](styles/75-first-instance-ordinary/style-203.md) |
| 申请撤销宣告失踪 | 官网标题为“申请撤销宣告失踪”，但正文与【说明】均为“申请宣告失踪”，且正文与 style-402 相同。 | [style-407.md](styles/84-missing-declared-dead/style-407.md) |
| 申请确定监护人 | 官网标题为“申请确定监护人”，但正文请求事项为“撤销指定×××为×××的监护人”。 | [style-534.md](styles/89-guardianship/style-534.md) |

## 全部文书

| 类目 | 文书 | 用途 | 本地文件 | 官方原文 |
| --- | --- | --- | --- | --- |
| 管辖 | 异议书(对管辖权提出异议用) | 当事人向第一审人民法院提出管辖权异议 | [style-006.md](styles/66-jurisdiction/style-006.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/6.html) |
| 管辖 | 民事上诉状 | 被告对第一审人民法院驳回管辖权异议裁定不服提起上诉 | [style-014.md](styles/66-jurisdiction/style-014.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/14.html) |
| 回避 | 申请书(申请回避用) | 当事人向人民法院申请审判人员或者其他诉讼参与人回避 | [style-022.md](styles/67-recusal/style-022.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/22.html) |
| 回避 | 复议申请书(申请对驳回回避申请决定复议用) | 申请人对驳回回避申请决定不服的，向人民法院申请复议 | [style-026.md](styles/67-recusal/style-026.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/26.html) |
| 诉讼参加人 | 法定代表人身份证明书(法人当事人用) | 法人当事人证明法定代表人身份 | [style-033.md](styles/68-participants/style-033.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/33.html) |
| 诉讼参加人 | 主要负责人身份证明书(其他组织的当事人用) | 其他组织当事人证明代表人身份 | [style-037.md](styles/68-participants/style-037.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/37.html) |
| 诉讼参加人 | 共同诉讼代表人推选书(共同诉讼当事人推选代表人用) | 共同诉讼当事人推选代表人参加诉讼 | [style-045.md](styles/68-participants/style-045.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/45.html) |
| 诉讼参加人 | 授权委托书(公民委托诉讼代理人用) | 公民当事人、法定代理人、共同诉讼代表人委托诉讼代理人参加诉讼 | [style-051.md](styles/68-participants/style-051.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/51.html) |
| 诉讼参加人 | 授权委托书(法人或者其他组织委托诉讼代理人用) | 法人或者其他组织当事人委托诉讼代理人参加诉讼 | [style-059.md](styles/68-participants/style-059.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/59.html) |
| 诉讼参加人 | 推荐函(推荐委托诉讼代理人用) | 当事人所在社区、单位以及有关社会团体推荐符合条件的公民担任诉讼代理人 | [style-066.md](styles/68-participants/style-066.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/66.html) |
| 证据 | 申请书(申请延长举证期限用) | 当事人在举证期限届满前，向人民法院书面申请延长举证期限 | [style-074.md](styles/69-evidence/style-074.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/74.html) |
| 证据 | 申请书(申请人民法院调查收集证据用) | 当事人和其他诉讼参加人因客观原因不能自行收集的证据，申请人民法院调查收集证据 | [style-076.md](styles/69-evidence/style-076.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/76.html) |
| 证据 | 申请书(申请书证提出命令用) | 承担举证证明责任的当事人向人民法院提出书面申请，责令对方当事人提交其控制之下的书证 | [style-079.md](styles/69-evidence/style-079.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/79.html) |
| 证据 | 申请书(申请通知证人出庭作证用) | 当事人在举证期限届满前，向人民法院申请通知证人出庭作证 | [style-082.md](styles/69-evidence/style-082.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/82.html) |
| 证据 | 申请书(申请鉴定用) | 当事人在举证期限届满前，向人民法院申请鉴定以查明事实的专门性问题 | [style-087.md](styles/69-evidence/style-087.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/87.html) |
| 证据 | 申请书(申请返还鉴定费用) | 支付鉴定费用的当事人，向人民法院申请裁定拒不出庭作证的鉴定人返还鉴定费 | [style-089.md](styles/69-evidence/style-089.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/89.html) |
| 证据 | 申请书(申请通知有专门知识的人出庭用) | 当事人在举证期限届满前，向人民法院申请通知有专门知识的人出庭 | [style-091.md](styles/69-evidence/style-091.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/91.html) |
| 证据 | 申请书(申请诉前证据保全用) | 利害关系人在提起诉讼或者申请仲裁前，向人民法院申请诉前证据保全 | [style-094.md](styles/69-evidence/style-094.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/94.html) |
| 证据 | 申请书(申请诉讼证据保全用) | 当事人在诉讼过程中，向人民法院申请诉讼证据保全 | [style-098.md](styles/69-evidence/style-098.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/98.html) |
| 期间、送达 | 申请书(申请顺延期限用) | 当事人因不可抗拒的事由或者其他正当理由耽误期限的，在障碍消除后的十日内，向人民法院申请顺延期限 | [style-102.md](styles/70-periods-service/style-102.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/102.html) |
| 调解 | 意见书(离婚案件当事人出具书面意见用) | 离婚案件当事人确因特殊情况无法出庭参加调解的，向人民法院出具书面意见 | [style-109.md](styles/71-mediation/style-109.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/109.html) |
| 保全和先予执行 | 申请书(诉前或者仲裁前申请财产保全用) | 利害关系人在提起诉讼或者申请仲裁前，向人民法院申请诉前财产保全 | [style-113.md](styles/72-preservation-prior-execution/style-113.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/113.html) |
| 保全和先予执行 | 申请书(申请诉前/仲裁前行为保全用) | 利害关系人在提起诉讼或者申请仲裁前，向人民法院申请诉前行为保全 | [style-118.md](styles/72-preservation-prior-execution/style-118.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/118.html) |
| 保全和先予执行 | 申请书(申请诉讼财产保全用) | 当事人在诉讼过程中，向人民法院申请诉讼财产保全 | [style-126.md](styles/72-preservation-prior-execution/style-126.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/126.html) |
| 保全和先予执行 | 申请书(申请诉讼行为保全用) | 当事人在诉讼过程中，向人民法院申请诉讼行为保全 | [style-131.md](styles/72-preservation-prior-execution/style-131.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/131.html) |
| 保全和先予执行 | 申请书(申请解除保全用) | 当事人向人民法院申请解除保全 | [style-133.md](styles/72-preservation-prior-execution/style-133.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/133.html) |
| 保全和先予执行 | 申请书(申请变更保全标的物用) | 被保全人申请变更保全标的物 | [style-137.md](styles/72-preservation-prior-execution/style-137.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/137.html) |
| 保全和先予执行 | 申请书(申请先予执行用) | 当事人在诉讼过程中，向人民法院申请先予执行 | [style-139.md](styles/72-preservation-prior-execution/style-139.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/139.html) |
| 保全和先予执行 | 复议申请书(申请对保全或者先予执行裁定复议用) | 当事人对保全或者先予执行裁定不服的，向作出裁定的人民法院申请复议 | [style-141.md](styles/72-preservation-prior-execution/style-141.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/141.html) |
| 保全和先予执行 | 担保书(案外人提供保全或者先予执行担保用) | 案外人在保全或者先予执行中提供担保 | [style-143.md](styles/72-preservation-prior-execution/style-143.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/143.html) |
| 对妨害民事诉讼的强制措施 | 复议申请书(司法制裁复议案件用) | 当事人对拘留、罚款决定不服的，向上一级人民法院申请复议 | [style-146.md](styles/73-compulsory-measures/style-146.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/146.html) |
| 对妨害民事诉讼的强制措施 | 悔过书(司法拘留案件具结悔过用) | 被拘留人在拘留期间认错悔改的，向人民法院具结悔过 | [style-155.md](styles/73-compulsory-measures/style-155.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/155.html) |
| 诉讼费用 | 申请书(申请缓交、减交或者免交诉讼费用) | 交纳诉讼费用确有困难的当事人申请向人民法院缓交、减交或者免交诉讼费 | [style-159.md](styles/74-court-fees/style-159.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/159.html) |
| 第一审普通程序 | 口头起诉登记表(公民口头提起民事诉讼用) | 书写起诉状确有困难的公民口头提起民事诉讼 | [style-168.md](styles/75-first-instance-ordinary/style-168.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/168.html) |
| 第一审普通程序 | 民事起诉状(公民提起民事诉讼用) | 公民提起民事诉讼 | [style-181.md](styles/75-first-instance-ordinary/style-181.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/181.html) |
| 第一审普通程序 | 民事起诉状(法人或者其他组织提起民事诉讼用) | 法人或者其他组织提起民事诉讼 | [style-187.md](styles/75-first-instance-ordinary/style-187.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/187.html) |
| 第一审普通程序 | 民事反诉状(公民提起民事反诉用) | 公民提起民事反诉 | [style-196.md](styles/75-first-instance-ordinary/style-196.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/196.html) |
| 第一审普通程序 | 民事反诉状(法人或者其他组织提起民事反诉用) | 法人或者其他组织提起民事反诉 | [style-203.md](styles/75-first-instance-ordinary/style-203.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/203.html) |
| 第一审普通程序 | 民事答辩状(公民对民事起诉提出答辩用) | 公民对民事起诉提出答辩 | [style-216.md](styles/75-first-instance-ordinary/style-216.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/216.html) |
| 第一审普通程序 | 民事答辩状(法人或者其他组织对民事起诉提出答辩用) | 法人或者其他组织对民事起诉提出答辩 | [style-224.md](styles/75-first-instance-ordinary/style-224.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/224.html) |
| 第一审普通程序 | 申请书(申请追加必要的共同诉讼当事人用) | 必须进行共同诉讼的当事人没有参加诉讼的，当事人向人民法院申请追加 | [style-231.md](styles/75-first-instance-ordinary/style-231.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/231.html) |
| 第一审普通程序 | 申请书(无独立请求权的第三人申请参加诉讼用) | 无独立请求权的第三人认为案件处理结果同他有法律上的利害关系，向人民法院申请参加诉讼 | [style-235.md](styles/75-first-instance-ordinary/style-235.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/235.html) |
| 第一审普通程序 | 申请书(申请增加诉讼请求用) | 当事人向人民法院申请增加诉讼请求 | [style-241.md](styles/75-first-instance-ordinary/style-241.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/241.html) |
| 第一审普通程序 | 申请书(申请变更诉讼请求用) | 当事人向人民法院申请变更诉讼请求 | [style-250.md](styles/75-first-instance-ordinary/style-250.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/250.html) |
| 第一审普通程序 | 声明书(放弃诉讼请求用) | 当事人向人民法院声明放弃诉讼请求 | [style-264.md](styles/75-first-instance-ordinary/style-264.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/264.html) |
| 第一审普通程序 | 申请书(申请不公开审理用) | 人民法院受理民事案件后，当事人向人民法院申请不公开审理 | [style-272.md](styles/75-first-instance-ordinary/style-272.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/272.html) |
| 第一审普通程序 | 申请书(申请撤回起诉用) | 原告向人民法院申请撤回起诉 | [style-280.md](styles/75-first-instance-ordinary/style-280.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/280.html) |
| 第一审普通程序 | 申请书(申请撤回反诉用) | 被告(反诉原告)向人民法院申请撤回反诉 | [style-287.md](styles/75-first-instance-ordinary/style-287.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/287.html) |
| 第一审普通程序 | 申请书(申请恢复诉讼用) | 中止诉讼的原因消除后，当事人向人民法院申请恢复诉讼 | [style-293.md](styles/75-first-instance-ordinary/style-293.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/293.html) |
| 第一审普通程序 | 申请书(申请证明判决书或者裁定书的法律效力用) | 当事人向人民法院申请出具判决书/裁定书发生法律效力的证明 | [style-299.md](styles/75-first-instance-ordinary/style-299.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/299.html) |
| 简易程序 | 异议书(对适用简易程序提出异议用) | 当事人对案件适用简易程序有异议的，向人民法院提出 | [style-307.md](styles/76-summary-procedure/style-307.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/307.html) |
| 简易程序中的小额诉讼 | 异议书(对适用小额诉讼程序提出异议用) | 当事人对按照小额诉讼案件审理有异议的，向人民法院提出 | [style-314.md](styles/77-small-claims/style-314.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/314.html) |
| 公益诉讼 | 民事起诉状(提起公益诉讼用) | 法律规定的机关和有关组织，向人民法院提起公益诉讼 | [style-318.md](styles/78-public-interest/style-318.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/318.html) |
| 公益诉讼 | 声明书(社会组织声明无违法记录用) | 社会组织提起环境民事公益诉讼时，声明无违法记录 | [style-329.md](styles/78-public-interest/style-329.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/329.html) |
| 公益诉讼 | 申请书(其他机关和有关组织申请参加公益诉讼用) | 有权提起诉讼的其他机关和社会组织在人民法院公告之日起三十日内或者一审开庭前，向受理公益诉讼的人民法院，申请作为共同原告参加公益诉讼 | [style-335.md](styles/78-public-interest/style-335.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/335.html) |
| 公益诉讼 | 意见书(支持起诉单位提交书面意见用) | 有关单位支持提起公益诉讼，向人民法院提交书面意见 | [style-343.md](styles/78-public-interest/style-343.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/343.html) |
| 第三人撤销之诉 | 民事起诉状(提起第三人撤销之诉用) | 因不能归责于本人的事由未参加诉讼，但有证据证明发生法律效力的判决、裁定、调解书的部分或者全部内容错误，损害其民事权益的第三人，自知道或者应当知道其民事权益受到损害之日起六个月内，向作出该生效判决、裁定、调解书的人民法院提起诉讼 | [style-353.md](styles/79-third-party-revocation/style-353.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/353.html) |
| 执行异议之诉 | 民事起诉状(案外人提起执行异议之诉用) | 案外人对执行异议裁定不服的，提起执行异议之诉 | [style-361.md](styles/80-execution-objection-action/style-361.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/361.html) |
| 执行异议之诉 | 民事起诉状(申请执行人提起执行异议之诉用) | 申请执行人对执行异议裁定不服的，提起执行异议之诉 | [style-370.md](styles/80-execution-objection-action/style-370.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/370.html) |
| 第二审程序 | 民事上诉状(当事人提起上诉用) | 不服第一审人民法院民事判决或者裁定的当事人，向上一级人民法院提起上诉 | [style-379.md](styles/81-second-instance/style-379.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/379.html) |
| 选民资格案件 | 起诉书(申请确定选民资格用) | 公民不服选举委员会对选民资格的申诉所作的处理决定，在选举日的五日以前向选区所在地基层人民法院起诉 | [style-400.md](styles/83-voter-qualification/style-400.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/400.html) |
| 宣告失踪、宣告死亡案件 | 申请书(申请宣告公民失踪用) | 公民下落不明满二年的，利害关系人向下落不明人住所地基层人民法院申请宣告失踪 | [style-402.md](styles/84-missing-declared-dead/style-402.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/402.html) |
| 宣告失踪、宣告死亡案件 | 申请书(申请撤销宣告失踪用) | 官网标题为申请撤销宣告失踪；正文实为申请宣告失踪（与 style-402 相同） | [style-407.md](styles/84-missing-declared-dead/style-407.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/407.html) |
| 宣告失踪、宣告死亡案件 | 申请书(申请变更失踪人财产代管人用) | 失踪人的财产代管人经人民法院指定后，代管人向人民法院申请变更财产代管人 | [style-430.md](styles/84-missing-declared-dead/style-430.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/430.html) |
| 宣告失踪、宣告死亡案件 | 申请书(申请宣告公民死亡用) | 公民下落不明满四年，或者因意外事故下落不明满二年，或者因意外事故下落不明，经有关机关证明该公民不可能生存，利害关系人向下落不明人住所地基层人民法院申请宣告死亡 | [style-432.md](styles/84-missing-declared-dead/style-432.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/432.html) |
| 宣告失踪、宣告死亡案件 | 申请书(申请撤销宣告死亡用) | 被宣告死亡的公民重新出现后，本人或者利害关系人申请人民法院撤销宣告死亡判决 | [style-466.md](styles/84-missing-declared-dead/style-466.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/466.html) |
| 认定公民民事行为能力案件 | 申请书(申请宣告公民无民事行为能力用) | 近亲属或者其他利害关系人向该公民住所地基层人民法院申请认定无民事行为能力人 | [style-469.md](styles/85-civil-capacity/style-469.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/469.html) |
| 认定公民民事行为能力案件 | 申请书(申请宣告公民限制民事行为能力用) | 近亲属或者其他利害关系人向该公民住所地基层人民法院申请认定限制民事行为能力人 | [style-473.md](styles/85-civil-capacity/style-473.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/473.html) |
| 认定公民民事行为能力案件 | 申请书(申请宣告公民恢复限制民事行为能力用) | 被认定为无民事行为能力人或者他的监护人，向宣告无民事行为能力的基层人民法院，申请宣告恢复为限制民事行为能力人 | [style-476.md](styles/85-civil-capacity/style-476.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/476.html) |
| 认定公民民事行为能力案件 | 申请书(申请宣告公民恢复完全民事行为能力用) | 被认定为无/限制民事行为能力人或者他的监护人，申请宣告恢复为完全民事行为能力人 | [style-479.md](styles/85-civil-capacity/style-479.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/479.html) |
| 认定财产无主案件 | 申请书(申请认定财产无主用) | 公民、法人或者其他组织向财产所在地基层人民法院申请认定财产无主 | [style-485.md](styles/86-ownerless-property/style-485.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/485.html) |
| 认定财产无主案件 | 申请书(申请撤销认定财产无主用) | 原财产所有人或者继承人出现，在民法通则规定的诉讼时效期间对财产提出请求，向人民法院申请撤销认定财产无主判决 | [style-492.md](styles/86-ownerless-property/style-492.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/492.html) |
| 确认调解协议案件 | 申请书(申请司法确认调解协议用) | 当事人依照人民调解法等法律自调解协议生效之日起三十日内，共同向调解组织所在地基层人民法院申请司法确认调解协议 | [style-499.md](styles/87-mediation-agreement-confirmation/style-499.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/499.html) |
| 确认调解协议案件 | 申请书(申请撤销确认调解协议裁定用) | 当事人、利害关系人向作出确认调解协议裁定的基层人民法院，申请撤销确认调解协议裁定 | [style-507.md](styles/87-mediation-agreement-confirmation/style-507.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/507.html) |
| 实现担保物权案件 | 申请书(申请实现担保物权用) | 担保物权人以及其他有权请求实现担保物权的人依照物权法等法律，向担保财产所在地或者担保物权登记地基层人民法院申请实现担保物权 | [style-513.md](styles/88-security-interest/style-513.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/513.html) |
| 实现担保物权案件 | 异议书(对实现担保物权申请提出异议用) | 申请实现担保物权的被申请人有异议的，在收到人民法院通知后的五日内向人民法院提出异议 | [style-521.md](styles/88-security-interest/style-521.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/521.html) |
| 实现担保物权案件 | 申请书(申请撤销准许实现担保物权裁定用) | 当事人、利害关系人向作出准许实现担保物权裁定的基层人民法院，申请撤销准许实现担保物权裁定 | [style-526.md](styles/88-security-interest/style-526.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/526.html) |
| 监护权特别程序案件 | 申请书(申请确定监护人用) | 官网标题为申请确定监护人；正文实为撤销指定监护 | [style-534.md](styles/89-guardianship/style-534.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/534.html) |
| 监护权特别程序案件 | 申请书(申请变更监护人用) | 监护人或者利害关系人向基层人民法院申请变更监护人 | [style-538.md](styles/89-guardianship/style-538.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/538.html) |
| 监护权特别程序案件 | 申请书(申请撤销监护人资格用) | 有关人员或者有关单位向基层人民法院申请撤销监护人资格 | [style-545.md](styles/89-guardianship/style-545.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/545.html) |
| 确认仲裁协议效力案件 | 申请书(申请确认仲裁协议效力用) | 当事人对仲裁协议的效力有异议的，向人民法院申请确认仲裁协议效力 | [style-554.md](styles/90-arbitration-agreement-validity/style-554.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/554.html) |
| 撤销仲裁裁决案件 | 申请书(申请撤销仲裁裁决用) | 当事人自收到裁决书之日起六个月内，向仲裁委员会所在地的中级人民法院申请撤销仲裁裁决 | [style-560.md](styles/91-arbitration-award-revocation/style-560.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/560.html) |
| 撤销仲裁裁决案件 | 申请书(申请撤销劳动争议仲裁裁决用) | 用人单位自收到劳动争议仲裁裁决书之日起三十日内，向劳动人事争议仲裁委员会所在地的中级人民法院申请撤销裁决 | [style-564.md](styles/91-arbitration-award-revocation/style-564.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/564.html) |
| 人身安全保护令案件 | 申请书(申请人身安全保护令用) | 当事人或者其近亲属、相关单位向申请人或者被申请人居住地、家庭暴力发生地的基层人民法院申请人身安全保护令 | [style-571.md](styles/92-personal-safety-order/style-571.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/571.html) |
| 人身安全保护令案件 | 复议申请书(申请人对驳回人身安全保护令申请复议用) | 对驳回人身安全保护令申请的裁定不服的申请人，向作出裁定的人民法院申请复议 | [style-579.md](styles/92-personal-safety-order/style-579.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/579.html) |
| 人身安全保护令案件 | 复议申请书(被申请人对作出人身安全保护令申请复议用) | 对作出人身安全保护令裁定不服的被申请人，向作出裁定的人民法院申请复议 | [style-584.md](styles/92-personal-safety-order/style-584.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/584.html) |
| 人身安全保护令案件 | 申请书(申请撤销/变更/延长人身安全保护令用) | 申请人在人身安全保护令失效前，向作出人身安全保护令裁定的人民法院申请撤销、变更或者延长 | [style-594.md](styles/92-personal-safety-order/style-594.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/594.html) |
| 其他（非诉） | 申请书(撤回特别程序申请用) | 申请人撤回特别程序申请 | [style-602.md](styles/93-other-non-litigation/style-602.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/602.html) |
| 审判监督程序 | 民事再审申请书(申请再审用) | 当事人对已经生效的民事判决、裁定或者调解书向人民法院申请再审 | [style-613.md](styles/94-trial-supervision/style-613.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/613.html) |
| 督促程序 | 申请书(申请支付令用) | 债权人向人民法院申请支付令 | [style-616.md](styles/95-payment-order/style-616.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/616.html) |
| 督促程序 | 申请书(撤回支付令申请用) | 债权人向人民法院撤回支付令申请 | [style-622.md](styles/95-payment-order/style-622.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/622.html) |
| 督促程序 | 异议书(对支付令提出异议用) | 债务人收到支付令之日起十五日内，向人民法院提出书面异议 | [style-625.md](styles/95-payment-order/style-625.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/625.html) |
| 督促程序 | 申请书(撤回支付令异议用) | 债务人在向基层人民法院提出支付令异议后，申请撤回支付令异议 | [style-630.md](styles/95-payment-order/style-630.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/630.html) |
| 公示催告程序 | 申请书(申请公示催告用) | 按照规定可以背书转让的票据持有人，因票据被盗、遗失或者灭失，向票据支付地的基层人民法院申请公示催告 | [style-632.md](styles/96-public-summons/style-632.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/632.html) |
| 公示催告程序 | 申请书(撤回公示催告申请用) | 公示催告申请人在公示催告前，撤回申请 | [style-635.md](styles/96-public-summons/style-635.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/635.html) |
| 公示催告程序 | 申报书(利害关系人申报权利用) | 利害关系人在公示催告期间或者申报期届满后判决作出之前，向人民法院申报权利 | [style-637.md](styles/96-public-summons/style-637.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/637.html) |
| 执行程序 | 申请书(申请执行用) | 申请执行人向人民法院申请执行 | [style-639.md](styles/97-execution/style-639.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/639.html) |
| 执行程序 | 被执行人财产状况表(申请执行人提供被执行人财产状况用) | 申请执行人提供被执行人财产状况或线索 | [style-640.md](styles/97-execution/style-640.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/640.html) |
| 执行程序 | 执行异议书(当事人、利害关系人提出异议用) | 异议人向人民法院提出异议 | [style-642.md](styles/97-execution/style-642.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/642.html) |
| 执行程序 | 复议申请书(当事人、利害关系人申请复议用) | 复议申请人向人民法院申请复议 | [style-646.md](styles/97-execution/style-646.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/646.html) |
| 执行程序 | 申请书(申请提级执行用) | 申请执行人向人民法院申请提级执行 | [style-648.md](styles/97-execution/style-648.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/648.html) |
| 执行程序 | 执行异议书(案外人提出异议用) | 案外人向人民法院提出异议 | [style-651.md](styles/97-execution/style-651.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/651.html) |
| 执行程序 | 执行异议书(对财产分配方案提出异议用) | 参与分配案件中债权人或被执行人不服财产分配方案提出异议 | [style-652.md](styles/97-execution/style-652.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/652.html) |
| 执行程序 | 保证书(执行担保用) | 执行担保人向法院提供保证 | [style-653.md](styles/97-execution/style-653.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/653.html) |
| 涉外民事诉讼程序的特别规定 | 申请书(当事人申请承认和执行外国法院生效判决、裁定或仲裁裁决用) | 当事人向中华人民共和国有管辖权的中级人民法院申请承认和执行外国法院发生法律效力的判决、裁定或仲裁裁决 | [style-654.md](styles/98-foreign-related/style-654.md) | [官网](https://www.court.gov.cn/susongyangshi/xiangqing/654.html) |
