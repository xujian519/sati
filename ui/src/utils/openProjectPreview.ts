import { api } from "./api";

/**
 * 在新标签页打开项目 HTML 预览。
 *
 * 预览地址需要先异步申请一份预览凭据，而浏览器只允许在用户手势内打开弹窗。
 * 因此先同步开一个空白窗口保住手势，取到地址后再导航，并断开 `opener`，
 * 避免新页面回头操作应用窗口。取凭据失败时关闭这个空白窗口。
 */
export function openProjectPreviewInNewTab(projectName: string, filePath: string, projectRoot?: string | null): void {
  const previewWindow = window.open("about:blank", "_blank");
  if (!previewWindow) return;
  api
    .projectPreviewUrl(projectName, filePath, projectRoot)
    .then((previewUrl: string) => {
      previewWindow.opener = null;
      previewWindow.location.href = previewUrl;
    })
    .catch(() => {
      previewWindow.close();
    });
}
