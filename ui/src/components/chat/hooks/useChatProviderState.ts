import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch } from "../../../utils/api";
import { useWebSocket } from "../../../contexts/WebSocketContext";
import { buildModelOptionsFromConfig } from "../../../shared/modelOptions";
import type { PendingApproval, PendingPermissionRequest, PermissionMode } from "../types/types";
import type { ProjectSession } from "../../../types/app";

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
}

type ModelOption = {
  value: string;
  label: string;
};

type ThinkingModelContext = {
  providerId?: string;
  providerUrl?: string;
  protocol?: string;
  modelId?: string;
  supportsThinking?: boolean;
};

const SATI_MODEL_STORAGE_KEY = "sati-model";
const DEFAULT_PERMISSION_MODE_KEY = "permissionMode-default";
const COMPOSER_PERMISSION_MODES: PermissionMode[] = ["default", "bypassPermissions"];

function readStoredPermissionMode(key: string): PermissionMode | null {
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  return COMPOSER_PERMISSION_MODES.includes(stored as PermissionMode) ? (stored as PermissionMode) : null;
}

function readAgentModelRef(config: unknown): string {
  const configRecord = config && typeof config === "object" ? (config as Record<string, unknown>) : null;
  const agent =
    configRecord?.agent && typeof configRecord.agent === "object"
      ? (configRecord.agent as Record<string, unknown>)
      : null;
  return typeof agent?.model === "string" ? agent.model.trim() : "";
}

/**
 * 将一份 sati.yaml 配置应用到模型选择状态（选项 + 当前选中 + localStorage）。
 *
 * - 无配置（空 providers）：选项清空、选中清空、移除持久化值——UI 显示
 *   "先配置模型"引导，而不是复活硬编码的假模型名。
 * - 有配置：按 agent.model（后端权威）→ 当前选中（用户先前选择）→ 首个
 *   选项 的顺序决定选中值，并写回 localStorage 保持持久化一致。
 */
function applyConfigModelState(
  config: unknown,
  setModelOptions: React.Dispatch<React.SetStateAction<ModelOption[]>>,
  setModel: React.Dispatch<React.SetStateAction<string>>,
): void {
  const options = buildModelOptionsFromConfig(config);
  const preferred = readAgentModelRef(config);
  setModelOptions(options);
  setModel(previous => {
    if (options.length === 0) {
      localStorage.removeItem(SATI_MODEL_STORAGE_KEY);
      return "";
    }
    const candidate =
      (preferred && options.some(option => option.value === preferred) && preferred) ||
      (previous && options.some(option => option.value === previous) && previous) ||
      options[0].value;
    localStorage.setItem(SATI_MODEL_STORAGE_KEY, candidate);
    return candidate;
  });
}

function readThinkingModelContext(config: unknown): ThinkingModelContext | null {
  const configRecord = config && typeof config === "object" ? (config as Record<string, unknown>) : null;
  const agent =
    configRecord?.agent && typeof configRecord.agent === "object"
      ? (configRecord.agent as Record<string, unknown>)
      : null;
  const modelRef = typeof agent?.model === "string" ? agent.model.trim() : "";
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= modelRef.length - 1) {
    return null;
  }
  const providerId = modelRef.slice(0, slashIndex);
  const modelId = modelRef.slice(slashIndex + 1);
  const modelConfig =
    configRecord?.model && typeof configRecord.model === "object"
      ? (configRecord.model as Record<string, unknown>)
      : null;
  const providers =
    modelConfig?.providers && typeof modelConfig.providers === "object"
      ? (modelConfig.providers as Record<string, unknown>)
      : null;
  const provider =
    providers?.[providerId] && typeof providers[providerId] === "object"
      ? (providers[providerId] as Record<string, unknown>)
      : null;
  const models =
    provider?.models && typeof provider.models === "object" ? (provider.models as Record<string, unknown>) : null;
  const modelDefinition =
    models?.[modelId] && typeof models[modelId] === "object" ? (models[modelId] as Record<string, unknown>) : null;
  const capabilities =
    modelDefinition?.capabilities && typeof modelDefinition.capabilities === "object"
      ? (modelDefinition.capabilities as Record<string, unknown>)
      : null;
  return {
    providerId,
    providerUrl: typeof provider?.url === "string" ? provider.url : undefined,
    protocol: typeof provider?.protocol === "string" ? provider.protocol : undefined,
    modelId,
    supportsThinking: typeof capabilities?.supportsThinking === "boolean" ? capabilities.supportsThinking : undefined,
  };
}

export function useChatProviderState({ selectedSession }: UseChatProviderStateArgs) {
  const { subscribe } = useWebSocket();
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => {
    return readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY) || "default";
  });
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [model, setModel] = useState<string>(() => {
    return localStorage.getItem(SATI_MODEL_STORAGE_KEY) ?? "";
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [thinkingModelContext, setThinkingModelContext] = useState<ThinkingModelContext | null>(null);

  useEffect(() => {
    const defaultMode = readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY);
    if (!selectedSession?.id) {
      setPermissionModeState(defaultMode || "default");
      return;
    }

    const savedMode = readStoredPermissionMode(`permissionMode-${selectedSession.id}`);
    setPermissionModeState(savedMode || defaultMode || "default");
  }, [selectedSession?.id]);

  useEffect(() => {
    setPendingPermissionRequests(previous => {
      const next = previous.filter(request => !request.sessionId || request.sessionId === selectedSession?.id);
      return next;
    });
  }, [selectedSession?.id]);

  useEffect(() => {
    // 切换会话时清掉不属于当前会话的挂起审批（与 permission 请求一致；
    // pendingIndex 每会话局部，跨会话残留会与新增挂起冲突）。
    setPendingApprovals(previous => {
      const next = previous.filter(approval => !approval.uiSessionId || approval.uiSessionId === selectedSession?.id);
      return next;
    });
  }, [selectedSession?.id]);

  useEffect(() => {
    let cancelled = false;

    // Model options are driven exclusively by /api/config below — the
    // runtime-config endpoint only carries permissions. Keeping a single
    // authoritative source avoids the race where a late runtime-config
    // response clobbers catalog-enriched options with raw pid/mid refs.
    authenticatedFetch("/api/agents/runtime-config")
      .then(response => response.json())
      .then(data => {
        if (cancelled) {
          return;
        }

        const backendMode = data?.permissions?.effectiveMode;
        if (backendMode && COMPOSER_PERMISSION_MODES.includes(backendMode as PermissionMode)) {
          const storedPerm = readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY);
          if (!storedPerm || storedPerm === "default") {
            setPermissionModeState(backendMode as PermissionMode);
            localStorage.setItem(DEFAULT_PERMISSION_MODE_KEY, backendMode);
          }
        }
      })
      .catch(error => {
        console.error("Error loading runtime config:", error);
      });

    authenticatedFetch("/api/config")
      .then(response => response.json())
      .then(data => {
        if (cancelled) {
          return;
        }
        setThinkingModelContext(readThinkingModelContext(data?.config));
        applyConfigModelState(data?.config, setModelOptions, setModel);
      })
      .catch(error => {
        console.error("Error loading Sati config:", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribe(message => {
      if (message?.type !== "config:reloaded") return;
      setThinkingModelContext(readThinkingModelContext(message?.config));
      applyConfigModelState(message?.config, setModelOptions, setModel);
    });
  }, [subscribe]);

  const setPermissionMode = useCallback(
    (nextMode: PermissionMode) => {
      const normalizedMode = COMPOSER_PERMISSION_MODES.includes(nextMode) ? nextMode : "default";

      setPermissionModeState(normalizedMode);
      localStorage.setItem(DEFAULT_PERMISSION_MODE_KEY, normalizedMode);

      if (selectedSession?.id) {
        localStorage.setItem(`permissionMode-${selectedSession.id}`, normalizedMode);
      }
    },
    [selectedSession?.id],
  );

  const cyclePermissionMode = useCallback(() => {
    const currentIndex = COMPOSER_PERMISSION_MODES.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % COMPOSER_PERMISSION_MODES.length;
    const nextMode = COMPOSER_PERMISSION_MODES[nextIndex];
    setPermissionMode(nextMode);
  }, [permissionMode, setPermissionMode]);

  return {
    model,
    setModel,
    modelOptions,
    thinkingModelContext,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    pendingApprovals,
    setPendingApprovals,
    cyclePermissionMode,
  };
}
