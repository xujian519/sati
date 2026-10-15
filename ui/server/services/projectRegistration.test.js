// @vitest-environment node
/**
 * 项目注册表解析（上游 #648）。
 *
 * 这是「授权来源」的判据层：root 只能由登记推出。覆盖 id 形态、`.cwd` 标记的合法性、
 * 无标记时的 legacy 反推，以及**每次访问重新落盘读取**（登记被改指 / 删除后立刻失效）。
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectId, createCollisionResistantProjectId } from "../utils/pilotPaths.js";
import { resolveRegisteredProject } from "./projectRegistration.js";

const cleanups = [];

/**
 * legacy 反推把 id 里的 `-` 还原成 `/`，因此只对**无短横线**的路径成立；构造该夹具的前提是
 * 临时目录本身不含短横线（上游同一实现同此限制）。不成立时显式跳过，不假装通过。
 */
const tmpDirHasHyphen = tmpdir().includes("-");

afterEach(async () => {
  for (const root of cleanups.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(prefix = "sati-registration-") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanups.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace-with-dashes");
  await mkdir(workspace);
  const register = async (cwd, id = createProjectId(cwd), withMarker = true) => {
    const storage = path.join(home, "projects", id);
    await mkdir(storage, { recursive: true });
    if (withMarker) {
      await writeFile(path.join(storage, ".cwd"), cwd);
    }
    return { id, storage };
  };
  return { root, home, workspace, register };
}

describe("已注册项目的 root 解析", () => {
  it("拒绝绝对路径注入、短横线形态、空值与路径分隔符", async () => {
    const f = await fixture();
    for (const name of ["", undefined, null, {}, "/etc", f.workspace, "-etc", "..", "../home", "foo\\bar", "x\0y"]) {
      await expect(resolveRegisteredProject(name, f.home)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }
  });

  it("general 与 app home 的绝对路径都解析为 app home（由守卫据此回 403）", async () => {
    const f = await fixture();
    expect(await resolveRegisteredProject("general", f.home)).toBe(f.home);
    expect(await resolveRegisteredProject(f.home, f.home)).toBe(f.home);
  });

  it("支持当前 id 与防碰撞 id，且每次访问重新校验标记", async () => {
    const f = await fixture();
    const { id, storage } = await f.register(f.workspace);
    expect(await resolveRegisteredProject(id, f.home)).toBe(f.workspace);
    // 工作区自身的绝对路径也认（须与登记精确等值）
    expect(await resolveRegisteredProject(f.workspace, f.home)).toBe(f.workspace);

    // 登记被改指到别处 → 旧路径不再被认，新路径被认
    const other = path.join(f.root, "other");
    await mkdir(other);
    await writeFile(path.join(storage, ".cwd"), other);
    await expect(resolveRegisteredProject(f.workspace, f.home)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await resolveRegisteredProject(id, f.home)).toBe(other);

    // 登记目录被删 → id 不再被认
    await rm(storage, { recursive: true });
    await expect(resolveRegisteredProject(id, f.home)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const collision = await f.register(f.workspace, createCollisionResistantProjectId(f.workspace));
    expect(await resolveRegisteredProject(collision.id, f.home)).toBe(f.workspace);
    // 另一个 app home 下不存在这条登记
    await expect(resolveRegisteredProject(collision.id, path.join(f.root, "other-home"))).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it.skipIf(tmpDirHasHyphen)("只有存在真实登记目录时才按 legacy 编码反推 id", async () => {
    const f = await fixture("satiRegistration");
    const legacy = path.join(f.root, "legacy");
    await mkdir(legacy);
    const { id, storage } = await f.register(legacy, createProjectId(legacy), false);
    expect(await resolveRegisteredProject(id, f.home)).toBe(legacy);

    // 标记存在但内容非法（相对路径 / 空）→ 该登记失效
    for (const marker of ["", "relative"]) {
      await writeFile(path.join(storage, ".cwd"), marker);
      await expect(resolveRegisteredProject(id, f.home)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    }

    // 登记目录被换成软链 → 不认（软链可把标记引到注册表之外）
    await rm(storage, { recursive: true });
    await symlink(legacy, storage);
    await expect(resolveRegisteredProject(id, f.home)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("工作区已消失时仍按 id 解析成功（可用性由文件路由判）", async () => {
    const f = await fixture();
    const { id } = await f.register(f.workspace);
    await rm(f.workspace, { recursive: true });
    expect(await resolveRegisteredProject(id, f.home)).toBe(f.workspace);
    expect(await resolveRegisteredProject(f.workspace, f.home)).toBe(f.workspace);
  });

  // 与 src/web/server/listProjects.ts 同一条 legacy 规则：<app home>/projects 不可读时回退
  // ~/.pilotdeck/projects。不一致的症状是「侧边栏列得出项目、每个文件面都 404」。
  // `os.homedir()` 在 POSIX 下跟随 `HOME`，故用临时 home 触发，不碰真实 ~/.pilotdeck。
  it("app home 下没有 projects 目录时回退到 ~/.pilotdeck/projects", async () => {
    const f = await fixture();
    const fakeHome = path.join(f.root, "fake-user-home");
    const registered = path.join(fakeHome, ".pilotdeck", "projects", "legacy-workspace");
    await mkdir(registered, { recursive: true });
    await writeFile(path.join(registered, ".cwd"), f.workspace);

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // f.home 下刻意没有 projects 目录
      expect(await resolveRegisteredProject("legacy-workspace", f.home)).toBe(f.workspace);
      await expect(resolveRegisteredProject("not-registered", f.home)).rejects.toMatchObject({
        code: "PROJECT_NOT_FOUND",
      });
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("app home 下有 projects 目录时不看 legacy home", async () => {
    const f = await fixture();
    const fakeHome = path.join(f.root, "fake-user-home");
    const legacy = path.join(fakeHome, ".pilotdeck", "projects", "legacy-only");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, ".cwd"), f.workspace);
    await mkdir(path.join(f.home, "projects"), { recursive: true });

    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await expect(resolveRegisteredProject("legacy-only", f.home)).rejects.toMatchObject({
        code: "PROJECT_NOT_FOUND",
      });
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
