---
name: legal-party-document
title: 当事人诉讼文书（通用）
category: litigation
description: 用于承接未单独建模的最高人民法院当事人参考样式。
domain: legal
version: "1.0"
language: zh-CN
use_when: 当事人文书样式没有对应的专用 doc-template，或需要按官方样式自由排版时。
formats:
  - markdown
  - html
  - docx
vars:
  - name: document_title
    type: string
    required: false
    description: "文书标题，例如：申请书、异议书、民事起诉状"
  - name: body
    type: multiline
    required: false
    description: "按官方样式填写完成的正文，不含一级标题"
---

# {{document_title}}

{{body}}
