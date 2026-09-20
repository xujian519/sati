import { useCallback, useState } from "react";
import type { ReloadOptions } from "../types";

/** Shared force-reload request state (monotonic cache-busting key) for the preview data hooks below. */
export function usePreviewReloadRequest() {
  const [reloadRequest, setReloadRequest] = useState({ key: 0, force: false });
  const reload = useCallback((options: ReloadOptions = {}) => {
    setReloadRequest(value => ({
      key: value.key + 1,
      force: Boolean(options.force),
    }));
  }, []);
  return { reloadRequest, reload };
}
