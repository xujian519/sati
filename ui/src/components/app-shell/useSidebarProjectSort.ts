import { useEffect, useState } from "react";
import { readProjectSortOrder, type ProjectSortOrder } from "./sidebarV2Model";

export const useProjectSortOrder = (): ProjectSortOrder => {
  const [order, setOrder] = useState<ProjectSortOrder>(() => readProjectSortOrder());
  useEffect(() => {
    const refresh = () => setOrder(readProjectSortOrder());
    const onStorage = (event: StorageEvent) => {
      if (event.key === "sati-settings") refresh();
    };
    window.addEventListener("sati-settings-changed", refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("sati-settings-changed", refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return order;
};
