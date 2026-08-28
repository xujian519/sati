import { useCallback, useEffect, useRef, useState } from "react";
import type { AppTab } from "../types/app";

type UseDesktopSidebarForFilesOptions = {
  activeTab: AppTab;
  isMobile: boolean;
};

// The files workbench and the session sidebar compete for horizontal space, so
// the desktop sidebar auto-collapses while the files tab is active and is
// restored (to its pre-files state) as soon as the user leaves the tab. A
// manual toggle inside the files view rewrites the snapshot — the user's last
// explicit choice wins over the pre-entry one. Mobile is untouched: its sidebar
// is an overlay drawer driven by a separate `sidebarOpen` state.
export const useDesktopSidebarForFiles = ({ activeTab, isMobile }: UseDesktopSidebarForFilesOptions) => {
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  // Latest-value mirror so the tab-transition effect below can read the current
  // sidebar state without depending on it — putting it in deps would re-run the
  // effect on manual toggles and re-collapse the sidebar.
  const desktopSidebarOpenRef = useRef(desktopSidebarOpen);
  // `null` = no pending snapshot, i.e. the files view is not active.
  const sidebarSnapshotRef = useRef<boolean | null>(null);

  // Declared before the transition effect so the snapshot below always reads a
  // ref that is current for this commit.
  useEffect(() => {
    desktopSidebarOpenRef.current = desktopSidebarOpen;
  }, [desktopSidebarOpen]);

  useEffect(() => {
    if (isMobile) return;
    if (activeTab === "files") {
      if (sidebarSnapshotRef.current === null) {
        sidebarSnapshotRef.current = desktopSidebarOpenRef.current;
      }
      setDesktopSidebarOpen(false);
      return;
    }
    const snapshot = sidebarSnapshotRef.current;
    if (snapshot === null) return;
    sidebarSnapshotRef.current = null;
    setDesktopSidebarOpen(snapshot);
  }, [activeTab, isMobile]);

  const applyManualSidebarChange = useCallback((next: boolean) => {
    if (sidebarSnapshotRef.current !== null) {
      sidebarSnapshotRef.current = next;
    }
    setDesktopSidebarOpen(next);
  }, []);

  const collapseDesktopSidebar = useCallback(() => applyManualSidebarChange(false), [applyManualSidebarChange]);
  const openDesktopSidebar = useCallback(() => applyManualSidebarChange(true), [applyManualSidebarChange]);

  return { desktopSidebarOpen, collapseDesktopSidebar, openDesktopSidebar };
};
