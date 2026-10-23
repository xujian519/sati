import { AlertTriangle } from "lucide-react";
import type { Project } from "../../../types/app";
import { Markdown } from "../../chat/view/subcomponents/Markdown";

export function ErrorMessageRow({
  formattedContent,
  selectedProject,
  onFileOpen,
}: {
  formattedContent: string;
  selectedProject: Project | null;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
        <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5 text-[14px] leading-relaxed text-red-500">
        <Markdown projectName={selectedProject?.name} onFileOpen={onFileOpen}>
          {formattedContent}
        </Markdown>
      </div>
    </div>
  );
}
