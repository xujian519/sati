# CAP09 Checker 结构化复核输出

复核结论**必须**在回复末尾附带以下 JSON（单独 ```json 代码块），便于系统自动解析：

```json
{
  "status": "pass | needs_revision | blocked",
  "summary": "一句话结论",
  "issues": [
    {
      "severity": "critical | major | minor",
      "description": "问题描述",
      "anchor": "权项号/段落号/文件路径（可选）"
    }
  ],
  "legal_basis": ["专利法第22条第3款", "审查指南…"]
}
```

## status 含义

| status | 含义 |
|--------|------|
| `pass` | 可进入下游或 HITL approve |
| `needs_revision` | 须修改后重审，非致命 |
| `blocked` | 缺关键证据/严重矛盾，不得定稿 |

正文仍须可读；JSON 须合法且字段齐全（issues 无问题时为 `[]`）。
