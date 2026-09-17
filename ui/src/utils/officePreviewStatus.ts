import { api } from "./api";

export type OfficePreviewService = "builtin" | "libreoffice";

export type OfficePreviewStatus = {
  service: OfficePreviewService;
  libreOffice?: {
    available?: boolean;
    binaryPath?: string | null;
    version?: string;
    candidates?: Array<{
      binaryPath: string;
      available: boolean;
      version?: string;
      error?: string;
    }>;
  };
  statusError?: string;
  statusUnavailable?: boolean;
};

export function normalizeOfficePreviewService(value: unknown): OfficePreviewService {
  return String(value || "")
    .trim()
    .toLowerCase() === "libreoffice"
    ? "libreoffice"
    : "builtin";
}

type ConfigResponseBody = {
  error?: string;
  service?: unknown;
  libreOffice?: OfficePreviewStatus["libreOffice"];
  config?: {
    webui?: {
      officePreview?: {
        service?: unknown;
      };
    };
  };
  [key: string]: unknown;
};

async function readJsonBody(response: Response): Promise<ConfigResponseBody | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as ConfigResponseBody;
  } catch {
    // 响应体不是合法 JSON（后端错误页/代理 5xx 正文/截断响应）→ 此处不静默兜底：抛 Error 携带正文片段（ok 时用固定文案），交由 readOfficePreviewStatus 的 catch 降级读 config，或逃到设置页 .catch 显示为 statusError。
    throw new Error(response.ok ? "Expected JSON response for Office preview status." : text.slice(0, 160));
  }
}

async function readServiceFromConfig(): Promise<OfficePreviewStatus> {
  const response = await api.satiConfig();
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return {
    service: normalizeOfficePreviewService(body?.config?.webui?.officePreview?.service),
  };
}

export async function readOfficePreviewStatus(options: { refresh?: boolean } = {}): Promise<OfficePreviewStatus> {
  try {
    const response = await api.officePreviewStatus({ refresh: options.refresh });
    const body = await readJsonBody(response);
    if (!response.ok) {
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return {
      service: normalizeOfficePreviewService(body?.service),
      libreOffice: body?.libreOffice,
    };
  } catch {
    // 探测请求失败 → 回退读配置并标记 statusUnavailable。
    const fallback = await readServiceFromConfig();
    return {
      ...fallback,
      statusUnavailable: true,
    };
  }
}
