---
name: legal-execution-application
title: 申请执行书
category: litigation
description: 最高人民法院当事人参考样式中的申请执行书。
domain: legal
version: "1.0"
language: zh-CN
use_when: 申请执行人依据生效法律文书向法院申请强制执行时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: applicant_info
    type: multiline
    required: false
    description: "申请执行人的身份信息"
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
    description: "被执行人的身份信息"
  - name: applicant_name
    type: string
    required: false
    description: "申请执行人姓名或名称"
  - name: respondent_name
    type: string
    required: false
    description: "被执行人姓名或名称"
  - name: cause
    type: string
    required: false
    description: "案由"
  - name: issuing_authority
    type: string
    required: false
    description: "生效法律文书的作出机关"
  - name: case_number
    type: string
    required: false
    description: "生效法律文书案号，不含括号"
  - name: document_type
    type: string
    required: false
    default: "民事判决"
    description: "生效法律文书类型"
  - name: performance_status
    type: string
    required: false
    default: "未履行"
    description: "被执行人的履行情况：未履行或者未全部履行"
  - name: execution_requests
    type: multiline
    required: false
    description: "请求执行的内容"
  - name: court_name
    type: string
    required: false
    description: "受理执行申请的法院全称"
  - name: attachments
    type: string
    required: false
    default: "生效法律文书1份"
    description: "附件清单"
  - name: signature
    type: string
    required: false
    description: "申请执行人签名或盖章"
  - name: date
    type: string
    required: false
    description: "申请日期"
---

# 申请执行书

申请执行人：{{applicant_info}}

法定代理人/指定代理人：{{legal_agent_info}}

委托诉讼代理人：{{agent_info}}

被执行人：{{respondent_info}}

申请执行人{{applicant_name}}与被执行人{{respondent_name}}{{cause}}一案，{{issuing_authority}}（{{case_number}}）{{document_type}}已发生法律效力。被执行人{{respondent_name}}{{performance_status}}生效法律文书确定的给付义务，特向你院申请强制执行。

请求事项：

{{execution_requests}}

此致

{{court_name}}

附：{{attachments}}

申请执行人（签名或盖章）：{{signature}}

{{date}}
