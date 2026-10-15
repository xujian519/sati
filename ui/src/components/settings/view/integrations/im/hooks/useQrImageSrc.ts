import { useEffect, useState } from "react";
import { requestUrlTicket } from "../../../../../../utils/api";

// Builds a ticket-authenticated <img> src for the gateway QR image endpoint.
// The session JWT is no longer appended to the URL; instead a short-lived,
// purpose-scoped ("qr") url-ticket is requested and carried as `?ticket=`.
export function useQrImageSrc(qrUrl: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!qrUrl) {
      setSrc(null);
      return undefined;
    }
    let alive = true;
    requestUrlTicket("qr")
      .then((ticket: string) => {
        if (!alive) return;
        const endpoint = `/api/gateway/qr-image?data=${encodeURIComponent(qrUrl)}`;
        setSrc(`${endpoint}&ticket=${encodeURIComponent(ticket)}`);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [qrUrl]);

  return src;
}
