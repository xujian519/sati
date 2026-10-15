import { useEffect, useState } from "react";
import { api } from "../../../../../utils/api";

/**
 * 异步解析一份带短期 URL 票据的文件下载链接（#626）。
 *
 * `api.fileDownloadUrl` 现为异步（先申请票据，再把 `?ticket=` 拼进 URL），此 hook 把它收敛成可直接
 * 渲染的字符串。未就绪或失败时返回 null——下载入口暂时不渲染，避免拼出无凭据或含会话 JWT 的链接。
 */
export function useDownloadUrl(projectName: string | undefined, filePath: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!projectName || !filePath) {
      setUrl(null);
      return undefined;
    }
    let alive = true;
    api
      .fileDownloadUrl(projectName, filePath)
      .then((next: string) => {
        if (alive) setUrl(next);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [projectName, filePath]);

  return url;
}
