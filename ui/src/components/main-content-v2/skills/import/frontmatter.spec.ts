import { describe, expect, it } from "vitest";
import { parseFrontmatterFields, stripRootPrefix } from "./frontmatter";

/**
 * 这两个纯 helper 是 `ImportFromFolder` 的取字段/去前缀逻辑：前者从 `SKILL.md` 的
 * frontmatter 里提 name/description（用于批量候选列表的展示与 slug 预填），后者把
 * `webkitRelativePath` 去掉用户选中的根目录名。
 *
 * 它们此前**零直接测试**：`SkillsV2` 与其导入子组件整体没有测试文件——切片 A 的负控制里，
 * 把 `/api/skills/validate` 改成错误端点后全量 850 条用例仍全绿，正是这个缺口的证据。
 */

describe("parseFrontmatterFields", () => {
  it("取出 name 与 description", () => {
    const content = ["---", "name: my-skill", "description: Does a thing", "---", "", "# Body"].join("\n");

    expect(parseFrontmatterFields(content)).toEqual({ name: "my-skill", description: "Does a thing" });
  });

  it("剥掉值两侧的单引号/双引号", () => {
    const double = ["---", 'name: "quoted-name"', 'description: "quoted desc"', "---"].join("\n");
    const single = ["---", "name: 'single-name'", "description: 'single desc'", "---"].join("\n");

    expect(parseFrontmatterFields(double)).toEqual({ name: "quoted-name", description: "quoted desc" });
    expect(parseFrontmatterFields(single)).toEqual({ name: "single-name", description: "single desc" });
  });

  it("只有 name 时 description 为 null（缺字段不报错）", () => {
    expect(parseFrontmatterFields(["---", "name: only-name", "---"].join("\n"))).toEqual({
      name: "only-name",
      description: null,
    });
  });

  it("没有 frontmatter 块时两者都是 null", () => {
    expect(parseFrontmatterFields("# No frontmatter\n\nname: nope")).toEqual({ name: null, description: null });
    expect(parseFrontmatterFields("")).toEqual({ name: null, description: null });
  });

  it("CRLF 行尾同样能解析（`\\s*` 吃掉 \\r）", () => {
    const content = "---\r\nname: crlf-skill\r\ndescription: from windows\r\n---\r\n";

    expect(parseFrontmatterFields(content)).toEqual({ name: "crlf-skill", description: "from windows" });
  });

  it("值里带冒号时取整行剩余部分（description 常见写法）", () => {
    expect(parseFrontmatterFields(["---", "description: Fast: does things", "---"].join("\n"))).toEqual({
      name: null,
      description: "Fast: does things",
    });
  });
});

describe("stripRootPrefix", () => {
  it("去掉以 rootName + / 开头的前缀", () => {
    expect(stripRootPrefix("my-skill/SKILL.md", "my-skill")).toBe("SKILL.md");
    expect(stripRootPrefix("root/a/b.md", "root")).toBe("a/b.md");
  });

  it("不匹配的前缀原样返回", () => {
    expect(stripRootPrefix("other/SKILL.md", "my-skill")).toBe("other/SKILL.md");
    // 只是同名前缀、并非目录边界 ⇒ 不动
    expect(stripRootPrefix("my-skill-extra/SKILL.md", "my-skill")).toBe("my-skill-extra/SKILL.md");
  });

  it("rootName 为空或路径就是 rootName 本身时原样返回", () => {
    expect(stripRootPrefix("a/b.md", "")).toBe("a/b.md");
    expect(stripRootPrefix("my-skill", "my-skill")).toBe("my-skill");
  });
});
