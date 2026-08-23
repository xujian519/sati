import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SatiToolRuntimeError } from "../../protocol/errors.js";
import { statIfExists } from "./writeSnapshots.js";

export async function writeTextFile(
  filePath: string,
  content: string,
  options?: { allowOverwrite?: boolean },
): Promise<"created" | "overwritten"> {
  const existing = await statIfExists(filePath);

  if (existing && !existing.isFile()) {
    throw new SatiToolRuntimeError("file_conflict", `${filePath} exists and is not a regular file.`);
  }

  if (existing && !options?.allowOverwrite) {
    throw new SatiToolRuntimeError(
      "file_conflict",
      `${filePath} already exists. Set allow_overwrite to true to overwrite it.`,
    );
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return existing ? "overwritten" : "created";
}
