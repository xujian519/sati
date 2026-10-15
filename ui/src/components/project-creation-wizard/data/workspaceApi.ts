import { logError } from "../../../utils/logging";
import { api, requestUrlTicket } from "../../../utils/api";
import type {
  BrowseFilesystemResponse,
  CloneProgressEvent,
  CreateFolderResponse,
  CreateWorkspacePayload,
  CreateWorkspaceResponse,
  CredentialsResponse,
  FolderSuggestion,
  TokenMode,
} from "../types";

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

export const fetchGithubTokenCredentials = async () => {
  const response = await api.get("/settings/credentials?type=github_token");
  const data = await parseJson<CredentialsResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || "Failed to load GitHub tokens");
  }

  return (data.credentials || []).filter(credential => credential.is_active);
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const endpoint = `/browse-filesystem?path=${encodeURIComponent(pathToBrowse)}`;
  const response = await api.get(endpoint);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || "Failed to browse filesystem");
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || "Failed to create folder");
  }

  return data.path || folderPath;
};

export const createWorkspaceRequest = async (payload: CreateWorkspacePayload) => {
  const response = await api.createWorkspace(payload);
  const data = await parseJson<CreateWorkspaceResponse>(response);

  if (!response.ok) {
    throw new Error(data.details || data.error || "Failed to create workspace");
  }

  return data.project;
};

const buildCloneProgressQuery = ({
  workspacePath,
  githubUrl,
  tokenMode,
  selectedGithubToken,
  newGithubToken,
}: CloneWorkspaceParams) => {
  const query = new URLSearchParams({
    path: workspacePath.trim(),
    githubUrl: githubUrl.trim(),
  });

  if (tokenMode === "stored" && selectedGithubToken) {
    query.set("githubTokenId", selectedGithubToken);
  }

  if (tokenMode === "new" && newGithubToken.trim()) {
    query.set("newGithubToken", newGithubToken.trim());
  }

  return query.toString();
};

export const cloneWorkspaceWithProgress = async (params: CloneWorkspaceParams, handlers: CloneProgressHandlers) => {
  // EventSource cannot send custom headers; use a short-lived, path-bound url-ticket (#626)
  // instead of appending the session JWT. The ticket binds to the workspace path, which
  // clone-progress also carries as `?path=`, so the generic auth binding check accepts it.
  const ticket = await requestUrlTicket("sse", { path: params.workspacePath.trim() });
  return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const query = buildCloneProgressQuery(params);
    const eventSource = new EventSource(`/api/projects/clone-progress?${query}&ticket=${encodeURIComponent(ticket)}`);
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onmessage = event => {
      try {
        const payload = JSON.parse(event.data) as CloneProgressEvent;

        if (payload.type === "progress" && payload.message) {
          handlers.onProgress(payload.message);
          return;
        }

        if (payload.type === "complete") {
          settle(() => resolve(payload.project));
          return;
        }

        if (payload.type === "error") {
          settle(() => reject(new Error(payload.message || "Failed to clone repository")));
        }
      } catch (error) {
        logError("Error parsing clone progress event:", error);
      }
    };

    eventSource.onerror = () => {
      settle(() => reject(new Error("Connection lost during clone")));
    };
  });
};
