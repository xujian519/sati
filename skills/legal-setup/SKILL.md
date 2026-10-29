---
name: legal-setup
description: "初始化个人法律模式的工作区布局：把实务画像模板、共享法务参考与领域法条基线落到当前会话工作区的 .legal 目录，创建案件目录骨架，并给出下一步的冷启动访谈命令。首次使用、换工作区、或 .legal 缺失时使用。"
---

# 法律模式初始化

法律模式把所有可写状态放在**当前会话工作区**的 `./.legal` 与 `./matters` 下。这样文件沙箱（`workspace-write`）允许写入，也便于把整个工作区备份、加密或迁移。请把会话工作区设为你的法律工作根目录（例如 `~/legal-workspace`），不要直接打开某个案件子目录。

## 本机布局

| 路径（相对工作区） | 内容 | 谁写入 |
|---|---|---|
| `./.legal/company-profile.md` | 公司/个人执业层面的共享事实 | 首次冷启动访谈 |
| `./.legal/practice/<domain>.md` | 各领域实务画像（审查指引、上报矩阵、输出偏好） | 对应领域的冷启动访谈 |
| `./.legal/references/` | 共享参考（质量门禁、仪表盘、检索路由） | 本技能 |
| `./.legal/references/<domain>/` | 领域法条基线（随源领域提供的核心规则） | 本技能 |
| `./matters/<slug>/` | 案件工作区（`input/`、`work/`、`output/`、`research/`、`audit/`） | `legal-matter` |
| `./.legal/research/evidence.jsonl` | 无案件归属的检索证据 | `legal-research` |
| `./.legal/active-matter` | 当前案件 slug | `legal-matter` |

领域名与 `references/practice/*.md` 的文件名一致，覆盖 13 个专业领域（如 `commercial-legal`、`ip-legal`、`law-practice-cn`）。

## 执行步骤

1. 从本次加载的 `<skill_resources>` 读取 `Base directory for this skill:` 的绝对路径，记为 `<SKILL_DIR>`。该目录在安装包内，只读。
2. 创建目录并复制模板。**只补缺失文件**，不覆盖用户已填写的画像：

```bash
SKILL_DIR='<把上面读到的绝对路径粘贴到这里>'
mkdir -p ./.legal/practice ./.legal/references ./.legal/research ./.legal/audit ./matters

for f in "$SKILL_DIR"/references/shared/*.md; do
  [ -e "./.legal/references/$(basename "$f")" ] || cp "$f" ./.legal/references/
done

for f in "$SKILL_DIR"/references/practice/*.md; do
  domain=$(basename "$f" .md)
  mkdir -p "./.legal/references/$domain" "./.legal/$domain"
  [ -e "./.legal/practice/$domain.md" ] || cp "$f" ./.legal/practice/
done

for domain_dir in "$SKILL_DIR"/references/law/*; do
  [ -d "$domain_dir" ] || continue
  domain=$(basename "$domain_dir")
  mkdir -p "./.legal/references/$domain" "./.legal/$domain"
  for f in "$domain_dir"/*; do
    [ -e "$f" ] || continue
    [ -e "./.legal/references/$domain/$(basename "$f")" ] || cp "$f" "./.legal/references/$domain/"
  done
done

[ -e ./.legal/company-profile.md ] || cp "$SKILL_DIR"/references/company-profile-template.md ./.legal/company-profile.md
[ -e ./.legal/commercial-legal/renewal-register.yaml ] || printf 'renewals: []\n' > ./.legal/commercial-legal/renewal-register.yaml

find ./.legal -maxdepth 2 -type f | sort
```

3. 检查结果：`company-profile.md` 与各领域画像应仍含 `[PLACEHOLDER]`。这是预期状态，表示尚未访谈。
4. 告诉用户下一步（按需选择，不必全跑）：

```
/legal-commercial-cold-start-interview
/legal-ip-cold-start-interview
/legal-corporate-cold-start-interview
/legal-litigation-cold-start-interview
```

其余领域用 `/legal-<领域>-cold-start-interview`，例如 `/legal-privacy-cold-start-interview`、`/legal-regulatory-cold-start-interview`。

5. 用户若只想先试一个领域，先跑该领域的冷启动访谈；其余画像保持占位符不会影响已配置领域。

## Windows（PowerShell）

`tool-bash` 在 Windows 上不挂载，使用 `tool-pwsh` 执行等价命令：

```powershell
$skillDir = '<把 Base directory 的绝对路径粘贴到这里>'
New-Item -ItemType Directory -Force ./.legal/practice,./.legal/references,./.legal/research,./.legal/audit,./matters | Out-Null
Get-ChildItem "$skillDir/references/shared/*.md" | ForEach-Object {
  $target = "./.legal/references/$($_.Name)"
  if (-not (Test-Path $target)) { Copy-Item $_.FullName $target }
}
Get-ChildItem "$skillDir/references/practice/*.md" | ForEach-Object {
  $target = "./.legal/practice/$($_.Name)"
  if (-not (Test-Path $target)) { Copy-Item $_.FullName $target }
}
Get-ChildItem "$skillDir/references/law" -Directory | ForEach-Object {
  $domain = $_.Name
  New-Item -ItemType Directory -Force "./.legal/references/$domain","./.legal/$domain" | Out-Null
  Get-ChildItem $_.FullName -File | ForEach-Object {
    $target = "./.legal/references/$domain/$($_.Name)"
    if (-not (Test-Path $target)) { Copy-Item $_.FullName $target }
  }
}
if (-not (Test-Path ./.legal/company-profile.md)) {
  Copy-Item "$skillDir/references/company-profile-template.md" ./.legal/company-profile.md
}
New-Item -ItemType Directory -Force ./.legal/commercial-legal | Out-Null
if (-not (Test-Path ./.legal/commercial-legal/renewal-register.yaml)) {
  Set-Content ./.legal/commercial-legal/renewal-register.yaml "renewals: []"
}
```

## 约束

- 不覆盖任何已有画像、参考或案件文件。用户手改的内容是正本。
- 不把模板内容当成已配置：画像里仍有 `[PLACEHOLDER]` 时，其余技能必须先提示完成访谈。
- 工作区布局只服务单一用户，不建立多用户或权限隔离。
- 需要换工作区时，把旧的 `.legal` 与 `matters` 一起复制过去；不要把画像散落到多个根目录。

## Sati 检索接线

- 在本项目中，法条原文优先用 `law_search` 检索（宝宸知识库，含法律层级过滤与现行/失效标注）；引用成稿前用 `law_verify` 逐条做形式核验。
- `law_search` / `law_verify` 不可用或未命中时，如实标注「未检索到 / 未做形式核验」，不得以模型记忆补法条。
