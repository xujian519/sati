import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createPolitDeckTempWorkspace(files: Record<string, string | Buffer>): Promise<{
  cwd: string;
  read(filePath: string): Promise<string>;
  write(filePath: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "politdeck-tool-"));
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(cwd, filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }

  return {
    cwd,
    read: (filePath) => readFile(path.join(cwd, filePath), "utf8"),
    write: async (filePath, content) => {
      const absolutePath = path.join(cwd, filePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}
