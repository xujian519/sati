/**
 * 标注 sidecar（`<图名>.annot.json`）的读写。
 *
 * 走项目文件接口（`ui/server` 的 `/api/projects/:name/file`），因此**不新增后端路由**：路径必须
 * 落在项目根内这件事由该接口自己保证，写作位置也就只能落在图旁边。
 *
 * 传进去的图路径按编辑器给的形态使用（绝对或相对项目根均可，两个接口都接受），sidecar 由它
 * 同目录同名派生，所以调用方不需要额外提供项目根。
 */
import {
  figureAnnotationSidecarPath,
  parseFigureAnnotationDocument,
  type FigureAnnotationDocument,
} from "../../../types/annotationReference";
import { api } from "../../../utils/api";

/** 读图旁边的已保存标注。 */
export async function readFigureAnnotation(
  projectName: string,
  figurePath: string,
): Promise<FigureAnnotationDocument | null> {
  try {
    const response = await api.readFile(projectName, figureAnnotationSidecarPath(figurePath));
    if (!response.ok) return null;
    const body = (await response.json()) as { content?: unknown };
    return typeof body.content === "string" ? parseFigureAnnotationDocument(body.content) : null;
  } catch {
    // 读不到/读不懂都按"从未标注过"处理：让用户能重新标注，而不是预览打不开。
    return null;
  }
}

/**
 * 写回标注 sidecar。
 *
 * @returns 写成功时 sidecar 路径；失败抛错（调用方把原因显示给用户，不静默丢标注）。
 */
export async function saveFigureAnnotation(
  projectName: string,
  figurePath: string,
  document: FigureAnnotationDocument,
): Promise<string> {
  const sidecarPath = figureAnnotationSidecarPath(figurePath);
  const response = await api.saveFile(projectName, sidecarPath, `${JSON.stringify(document, null, 2)}\n`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `saving the annotation failed with status ${response.status}`);
  }
  return sidecarPath;
}
