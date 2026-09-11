import { useCallback, useEffect, useMemo, useState } from "react";
import { SatiConfigProvider } from "../../hooks/useSatiConfig";
import { authenticatedFetch } from "../../utils/api";
import type { SettingsProps } from "./shared/types";
import type { SettingsMenuKey } from "./types";
import { mapInitialTabToMenuKey } from "./navigation";
import SettingsSidebar from "./view/SettingsSidebar";
import SettingsContent from "./view/SettingsContent";

export type DesktopVersionCheckResult = {
  mode: "desktop" | "web";
  /** 有更新的版本存在（信息性）。 */
  hasUpdate: boolean;
  /** 存在更新且本平台有可安装的产物 —— 只有它为真才该提示/给出按钮。 */
  updateAvailable: boolean;
  checkUnavailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  buildTime: string | null;
};

type VersionCheckPayload = {
  hasUpdate?: boolean;
  updateAvailable?: boolean;
  checkUnavailable?: boolean;
  current?: { version?: string; buildTime?: string | null };
  latest?: { version?: string | null; publishedAt?: string | null };
  localHead?: string;
  remoteHead?: string | null;
  [key: string]: unknown;
};

function normalizeDesktopVersionResult(payload: VersionCheckPayload): DesktopVersionCheckResult {
  return {
    mode: "desktop",
    hasUpdate: Boolean(payload?.hasUpdate),
    // 服务端会滤掉「有新版本但本平台没有对应架构安装包」的情况；旧版服务端
    // 不发这个字段，回退到 hasUpdate 保持行为不变。
    updateAvailable: Boolean(payload?.updateAvailable ?? payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.current?.version ?? "unknown",
    latestVersion: payload?.latest?.version ?? null,
    latestPublishedAt: payload?.latest?.publishedAt ?? null,
    buildTime: payload?.current?.buildTime ?? null,
  };
}

function normalizeWebVersionResult(payload: VersionCheckPayload): DesktopVersionCheckResult {
  return {
    mode: "web",
    hasUpdate: Boolean(payload?.hasUpdate),
    // Web 自更新走 git 远端比较，没有「安装包」概念，可用即可动。
    updateAvailable: Boolean(payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.localHead ?? "unknown",
    latestVersion: payload?.remoteHead ?? null,
    latestPublishedAt: null,
    buildTime: null,
  };
}

function SettingsInner({ isOpen, onClose, projects = [], initialTab }: SettingsProps) {
  const isDesktopApp = typeof window !== "undefined" && !!(window as Window & { satiDesktop?: unknown }).satiDesktop;
  const initialKey = useMemo(() => mapInitialTabToMenuKey(initialTab), [initialTab]);
  const [selectedKey, setSelectedKey] = useState<SettingsMenuKey>(initialKey);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(initialKey === "general");
  const [versionInfo, setVersionInfo] = useState<DesktopVersionCheckResult>({
    mode: isDesktopApp ? "desktop" : "web",
    hasUpdate: false,
    updateAvailable: false,
    checkUnavailable: false,
    currentVersion: "unknown",
    latestVersion: null,
    latestPublishedAt: null,
    buildTime: null,
  });
  const [checkingVersion, setCheckingVersion] = useState(false);

  const checkVersion = useCallback(async () => {
    setCheckingVersion(true);
    try {
      const res = isDesktopApp
        ? await authenticatedFetch("/api/update/desktop/check", {
            method: "POST",
          })
        : await authenticatedFetch("/api/update/check", {
            method: "POST",
          });
      if (!res.ok) {
        throw new Error("Failed to check version");
      }
      const data = await res.json();
      setVersionInfo(isDesktopApp ? normalizeDesktopVersionResult(data) : normalizeWebVersionResult(data));
    } catch {
      // 版本检查请求失败 → 标记 checkUnavailable，不阻断设置页。
      setVersionInfo(prev => ({
        ...prev,
        hasUpdate: false,
        updateAvailable: false,
        checkUnavailable: true,
      }));
    } finally {
      setCheckingVersion(false);
    }
  }, [isDesktopApp]);

  useEffect(() => {
    if (!isOpen) return;
    const nextKey = mapInitialTabToMenuKey(initialTab);
    setSelectedKey(nextKey);
    setMobileNavigationOpen(nextKey === "general");
    void checkVersion();
  }, [isOpen, initialTab, checkVersion]);

  const selectMenuItem = useCallback((key: SettingsMenuKey) => {
    setSelectedKey(key);
    setMobileNavigationOpen(false);
  }, []);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-xs md:p-4">
      <div className="relative flex h-full w-full overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-7xl md:rounded-xl">
        <div className="flex h-full w-full flex-col md:flex-row">
          <SettingsSidebar
            selectedKey={selectedKey}
            onSelect={selectMenuItem}
            onClose={onClose}
            showAboutDot={versionInfo.updateAvailable}
            mobileVisible={mobileNavigationOpen}
          />
          <SettingsContent
            selectedKey={selectedKey}
            projects={projects}
            versionInfo={versionInfo}
            checkingVersion={checkingVersion}
            mobileVisible={!mobileNavigationOpen}
            onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
          />
        </div>
      </div>
    </div>
  );
}

export default function Settings(props: SettingsProps) {
  return (
    <SatiConfigProvider>
      <SettingsInner {...props} />
    </SatiConfigProvider>
  );
}
