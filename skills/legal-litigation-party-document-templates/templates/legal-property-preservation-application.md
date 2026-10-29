---
name: legal-property-preservation-application
title: 申请书（诉讼财产保全）
category: litigation
description: 最高人民法院当事人参考样式中的诉讼财产保全申请书。
domain: legal
version: "1.0"
language: zh-CN
use_when: 诉讼中申请查封、扣押或冻结被申请人财产时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: applicant_info
    type: multiline
    required: false
    description: "申请人的身份信息"
  - name: legal_agent_info
    type: multiline
    required: false
    default: "无"
    description: "法定代理人/指定代理人信息；没有则填“无”"
  - name: agent_info
    type: multiline
    required: false
    default: "无"
    description: "委托诉讼代理人信息；没有则填“无”"
  - name: respondent_info
    type: multiline
    required: false
    description: "被申请人的身份信息"
  - name: respondent_name
    type: string
    required: false
    description: "被申请人姓名或名称"
  - name: case_reference
    type: multiline
    required: false
    description: "案号、当事人和案由，例如：××人民法院（2026）……号原告×××诉被告×××……一案"
  - name: preservation_measure
    type: string
    required: false
    default: "查封"
    description: "保全措施：查封、扣押或者冻结"
  - name: preservation_target
    type: multiline
    required: false
    description: "保全财产的名称、性质、数量、数额、所在地等"
  - name: preservation_period
    type: string
    required: false
    description: "保全期限，例如：一年"
  - name: preservation_reasons
    type: multiline
    required: false
    description: "申请诉讼财产保全的事实和理由"
  - name: guarantee
    type: multiline
    required: false
    description: "担保财产的名称、性质、数量、数额、所在地等"
  - name: court_name
    type: string
    required: false
    description: "受诉法院全称"
  - name: signature
    type: string
    required: false
    description: "申请人签名或盖章"
  - name: date
    type: string
    required: false
    description: "申请日期"
---

# 申请书

申请人：{{applicant_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

被申请人：{{respondent_info}}

请求事项：

{{preservation_measure}}被申请人{{respondent_name}}的{{preservation_target}}，期限为{{preservation_period}}。

事实和理由：

{{case_reference}}，{{preservation_reasons}}

申请人提供{{guarantee}}作为担保。

此致

{{court_name}}

申请人（签名或者盖章）：{{signature}}

{{date}}
