import { isImageFile } from "../../../utils/binaryFile";

export function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function getFileTypeBadge(filename: string) {
  const extension = getExtension(filename);
  if (["doc", "docx", "wps", "odt"].includes(extension)) {
    return {
      label: "W",
      className: "bg-brand-600 text-white",
      titleKey: "fileTypes.word",
    };
  }
  if (["xls", "xlsx", "et", "ods"].includes(extension)) {
    return {
      label: "X",
      className: "bg-emerald-600 text-white",
      titleKey: "fileTypes.excel",
    };
  }
  if (["ppt", "pptx", "dps", "odp"].includes(extension)) {
    return {
      label: "P",
      className: "bg-orange-600 text-white",
      titleKey: "fileTypes.powerpoint",
    };
  }
  if (extension === "pdf") {
    return {
      label: "PDF",
      className: "bg-red-600 text-white text-[7px]",
      titleKey: "fileTypes.pdf",
    };
  }
  if (isImageFile(filename)) {
    return {
      label: "IMG",
      className: "bg-violet-600 text-white text-[7px]",
      titleKey: "fileTypes.image",
    };
  }
  return {
    label: "F",
    className: "bg-neutral-500 text-white",
    titleKey: "fileTypes.file",
  };
}
