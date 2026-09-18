/**
 * 导入流程里的两个纯文本 helper：SKILL.md frontmatter 取字段、相对路径去根前缀。
 *
 * 从 `ImportFromFolder.tsx` 搬出（#159 UI-APP-N01 切片 B）：它们是纯函数，此前**没有任何
 * 直接测试**（整个 `SkillsV2` 与其导入子组件都是零覆盖——切片 A 的负控制里，把
 * `/api/skills/validate` 改成错误端点后全量 850 条用例仍全绿）。外置后即可直测。
 */

export function parseFrontmatterFields(content: string): { name: string | null; description: string | null } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return { name: null, description: null };
  const fm = fmMatch[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : null,
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : null,
  };
}

export function stripRootPrefix(relPath: string, rootName: string): string {
  return rootName && relPath.startsWith(rootName + "/") ? relPath.slice(rootName.length + 1) : relPath;
}
