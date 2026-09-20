import { useRef, useState } from "react";
import {
  createImageRegionContentReference,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from "../../../../../types/contentReference";
import type { CodeEditorFile } from "../../../types/types";
import { useFileBlob } from "../hooks/use-file-blob";
import { useObjectUrl } from "../hooks/use-object-url";
import ContentReferenceMenu from "../../subcomponents/ContentReferenceMenu";
import RegionSelectionOverlay, { type CapturedRegion } from "../../subcomponents/RegionSelectionOverlay";
import FallbackContent from "./atoms/FallbackContent";
import PreviewSpinner from "./atoms/PreviewSpinner";

export default function ImagePreview({
  projectName,
  file,
  title,
  message,
  onClose,
}: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  message: string;
  onClose: () => void;
}) {
  const { blob, errorMessage, loading } = useFileBlob(projectName, file.path, true);
  const blobUrl = useObjectUrl(blob);
  const [imgError, setImgError] = useState(false);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  if (loading && !blobUrl) return <PreviewSpinner />;
  if (errorMessage || imgError || !blobUrl) {
    return <FallbackContent title={title} message={message} onClose={onClose} />;
  }

  const capabilities: ReferenceCapabilities = {
    text: { state: "unavailable", reason: "NO_TEXT_LAYER" },
    cells: { state: "unavailable", reason: "NO_CELL_MODEL" },
    region: { state: "available" },
    recommendedMode: "region",
  };
  const handleRegionCommit = (capture: CapturedRegion) => {
    const reference = createImageRegionContentReference({
      selectionMode: "region",
      source: {
        projectName,
        relativePath: file.path,
        fileName: file.name,
        ...(blob ? { revision: { size: blob.size } } : {}),
      },
      renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
      locator: { surface: "page", pageNumber: 1, rect: capture.rect },
      image: {
        name: `reference-${file.name}-${Date.now()}.png`,
        mimeType: "image/png",
        width: capture.width,
        height: capture.height,
        dataUrl: capture.dataUrl,
      },
    });
    window.dispatchEvent(new CustomEvent("sati:add-chat-reference", { detail: reference }));
    setReferenceMode(null);
  };

  return (
    <div className="flex h-full w-full flex-col bg-neutral-50 dark:bg-neutral-900">
      <div className="flex h-11 shrink-0 items-center justify-end border-b border-neutral-200 bg-white px-3 dark:border-neutral-800 dark:bg-neutral-950">
        <ContentReferenceMenu
          capabilities={capabilities}
          activeMode={referenceMode}
          onSelectMode={mode => setReferenceMode(mode === "region" ? mode : null)}
          onCancelMode={() => setReferenceMode(null)}
        />
      </div>
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          ref={imageRef}
          src={blobUrl}
          alt={file.name}
          className="max-h-full max-w-full rounded object-contain"
          onError={() => setImgError(true)}
        />
        <RegionSelectionOverlay
          active={referenceMode === "region"}
          hostRef={viewportRef}
          resolveTarget={element => {
            const image = element?.closest<HTMLImageElement>("img");
            if (!image || image !== imageRef.current) return null;
            return { element: image, surface: "page", pageNumber: 1 };
          }}
          onCommit={handleRegionCommit}
          onCancel={() => setReferenceMode(null)}
        />
      </div>
    </div>
  );
}
