import { useEffect, useState } from "react";

export function useObjectUrl(blob: Blob | null) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setBlobUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    setBlobUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  return blobUrl;
}
