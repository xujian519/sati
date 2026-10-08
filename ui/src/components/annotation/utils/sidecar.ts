/**
 * 标注 sidecar（`<文件名含扩展名>.annot.json`）的读写。
 *
 * 走项目文件接口（`ui/server` 的 `/api/projects/:name/file`），因此**不新增后端路由**：路径必须
 * 落在项目根内这件事由该接口自己保证，写作位置也就只能落在目标文件旁边。
 *
 * 传进去的路径按编辑器给的形态使用（绝对或相对项目根均可，两个接口都接受），sidecar 由它
 * 同目录同名派生，所以调用方不需要额外提供项目根。
 */
import {
  annotationSidecarCandidates,
  annotationSidecarPath,
  annotationTargetsFile,
  parseAnnotationDocument,
  type AnnotationDocument,
} from "../../../types/annotationReference";
import { isHtmlAnnotationKindWriteEnabled } from "../../../constants/config";
import { api } from "../../../utils/api";

/**
 * 读目标文件旁边的已保存标注。
 *
 * 先找带扩展名的名字，再回退 v1 的主名名字；两道都要求文档确实指向当前文件——v1 只按主名
 * 派生，同目录的 `图3.svg` / `图3.png` 共用一份 sidecar，不加这道校验就会把邻居的标注读成
 * 自己的（锚点与坐标都不成立），并且会按"文件已更新"提示用户。
 */
export async function readAnnotation(projectName: string, targetPath: string): Promise<AnnotationDocument | null> {
  for (const candidate of annotationSidecarCandidates(targetPath)) {
    const document = await readAnnotationAt(projectName, candidate);
    if (document !== null && annotationTargetsFile(document, targetPath)) return document;
  }
  return null;
}

async function readAnnotationAt(projectName: string, sidecarPath: string): Promise<AnnotationDocument | null> {
  try {
    const response = await api.readFile(projectName, sidecarPath);
    if (!response.ok) return null;
    const body = (await response.json()) as { content?: unknown };
    return typeof body.content === "string" ? parseAnnotationDocument(body.content) : null;
  } catch {
    // 读不到/读不懂都按"从未标注过"处理：让用户能重新标注，而不是预览打不开。
    return null;
  }
}

/**
 * 写回标注 sidecar。
 *
 * 写作位置带扩展名，所以不会落到同目录同名不同后缀的文件上（`图3.svg` 的标注不会写进
 * `图3.png` 的位置，反之亦然）。
 *
 * @returns 写成功时 sidecar 路径；失败抛错（调用方把原因显示给用户，不静默丢标注）。
 */
export async function saveAnnotation(
  projectName: string,
  targetPath: string,
  document: AnnotationDocument,
): Promise<string> {
  // 发布门控（D6）：所有读者升级前不写 `kind:"html"`——旧版读者会把未知 kind 视为
  // 「从未标注」，并在下一次保存时静默覆盖这份侧车（H0 #6 实测）。
  if (document.target.kind === "html" && !isHtmlAnnotationKindWriteEnabled()) {
    throw new Error("HTML annotations cannot be saved yet: the HTML annotation gate is not enabled");
  }
  const sidecarPath = annotationSidecarPath(targetPath);
  const response = await api.saveFile(projectName, sidecarPath, `${JSON.stringify(document, null, 2)}\n`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `saving the annotation failed with status ${response.status}`);
  }
  return sidecarPath;
}
