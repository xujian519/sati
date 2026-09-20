import { useCallback, useEffect, useState } from "react";
import { readOfficePreviewStatus, type OfficePreviewStatus } from "../../../../../utils/officePreviewStatus";

export function useOfficePreviewService() {
  const [status, setStatus] = useState<OfficePreviewStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    readOfficePreviewStatus()
      .then(nextStatus => {
        setStatus(nextStatus);
      })
      .catch(() => {
        // Probe failure — treat the service as unavailable.
        setStatus(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { status, loading, reload };
}
