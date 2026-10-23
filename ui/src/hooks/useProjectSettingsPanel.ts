import { useCallback, useState } from "react";

export function useProjectSettingsPanel() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState("appearance");

  const openSettings = useCallback((tab = "appearance") => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  return { showSettings, setShowSettings, settingsInitialTab, openSettings };
}
