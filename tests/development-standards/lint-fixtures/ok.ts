// 负控制正例：合规用法，断言不被误报。
// execFile（数组参数、不经 shell）允许；await 被允许。
import { execFile } from "node:child_process";

export async function run(): Promise<void> {
  await execFile("git", ["status"]);
}
