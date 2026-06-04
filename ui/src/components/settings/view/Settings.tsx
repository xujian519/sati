import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  FileCog,
  GitCommit,
  Globe2,
  MessageSquare,
  Palette,
  RefreshCw,
  Server,
  Shield,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import { useTheme } from '../../../contexts/ThemeContext';
import { languages } from '../../../i18n/languages';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useSettingsController } from '../hooks/useSettingsController';
import { useGitVersion } from '../../../hooks/useGitVersion';
import type {
  CodeEditorSettingsState,
  ProjectSortOrder,
  SettingsProps,
} from '../types/types';
import { cn } from '../../../lib/utils';
import SettingsCard from './SettingsCard';
import SettingsRow from './SettingsRow';
import SettingsSection from './SettingsSection';
import SettingsToggle from './SettingsToggle';
import PilotDeckConfigTab from './tabs/PilotDeckConfigTab';
import McpServersTab from './tabs/McpServersTab';
import PermissionsSettingsTab from './tabs/PermissionsSettingsTab';

type SettingsPage = 'main' | 'config' | 'mcp' | 'permissions' | 'chatInput' | 'codeEditor';
type ThemeMode = 'system' | 'light' | 'dark';

const pageFromInitialTab = (tab: string): SettingsPage => {
  if (tab === 'config') return 'config';
  if (tab === 'mcp') return 'mcp';
  if (tab === 'permissions') return 'permissions';
  return 'main';
};

function Settings({ isOpen, onClose, projects = [], initialTab = 'appearance' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const {
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
  } = useSettingsController({ isOpen, initialTab });
  const [page, setPage] = useState<SettingsPage>(() => pageFromInitialTab(initialTab));

  useEffect(() => {
    if (!isOpen) return;
    setPage(pageFromInitialTab(initialTab));
  }, [isOpen, initialTab]);

  if (!isOpen) {
    return null;
  }

  const title = {
    main: t('title'),
    config: t('mainTabs.config'),
    mcp: t('mcpConfig.title'),
    permissions: t('mainTabs.permissions'),
    chatInput: t('settingsHome.chatInput.title'),
    codeEditor: t('appearanceSettings.codeEditor.title'),
  }[page];

  const maxWidth = page === 'config' ? 'max-w-[820px]' : 'max-w-[760px]';

  return (
    <div className="modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-sm md:p-4">
      <div className="relative flex h-full w-full flex-col overflow-hidden border border-border bg-background shadow-2xl md:h-[90vh] md:max-w-4xl md:rounded-xl">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="absolute right-4 top-4 z-20 h-9 w-9 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
          aria-label={t('settingsHome.close')}
        >
          <X className="h-4 w-4" />
        </Button>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className={cn('mx-auto w-full px-5 py-7 md:px-8 md:py-8', maxWidth)}>
            {page !== 'main' && (
              <button
                type="button"
                onClick={() => setPage('main')}
                className="mb-6 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
                {t('settingsHome.back')}
              </button>
            )}

            <div className="mb-7 flex items-center justify-between gap-6 pr-10">
              <h2 className="text-[26px] font-semibold leading-tight tracking-normal text-foreground">{title}</h2>
              {saveStatus === 'success' && (
                <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
              )}
            </div>

            {page === 'main' && (
              <SettingsHome
                projectSortOrder={projectSortOrder}
                onProjectSortOrderChange={setProjectSortOrder}
                onOpenPage={setPage}
              />
            )}

            {page === 'config' && <PilotDeckConfigTab projects={projects} />}
            {page === 'mcp' && <McpServersTab projects={projects} />}
            {page === 'permissions' && <PermissionsSettingsTab />}
            {page === 'chatInput' && <ChatInputSettingsPage />}
            {page === 'codeEditor' && (
              <CodeEditorSettingsPage
                settings={codeEditorSettings}
                onWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                onShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                onLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                onFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

type SettingsHomeProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  onOpenPage: (page: SettingsPage) => void;
};

function SettingsHome({ projectSortOrder, onProjectSortOrderChange, onOpenPage }: SettingsHomeProps) {
  const { t, i18n } = useTranslation('settings');
  const { themeMode = 'system', setThemeMode } = useTheme() as {
    themeMode?: ThemeMode;
    setThemeMode?: (mode: ThemeMode) => void;
  };

  const currentLanguage = languages.some((language) => language.value === i18n.language)
    ? i18n.language
    : 'en';

  return (
    <div className="space-y-8">
      <SettingsGroup title={t('settingsHome.basics')} description={t('settingsHome.configRequiredDescription')}>
        <GroupedCard>
          <NavigationRow
            icon={FileCog}
            title={t('mainTabs.config')}
            detail={t('settingsHome.config.detail')}
            onClick={() => onOpenPage('config')}
          />
          <NavigationRow
            icon={Server}
            title={t('mcpConfig.title')}
            detail={t('settingsHome.mcp.detail')}
            onClick={() => onOpenPage('mcp')}
          />
        </GroupedCard>
      </SettingsGroup>

      <SettingsGroup title={t('settingsHome.application')}>
        <GroupedCard divided>
          <MenuRow
            icon={Palette}
            title={t('settingsHome.appearanceMode.title')}
            detail={t('settingsHome.appearanceMode.detail')}
          >
            <SelectControl
              value={themeMode}
              onChange={(value) => setThemeMode?.(value as ThemeMode)}
              options={[
                { value: 'system', label: t('settingsHome.appearanceMode.system') },
                { value: 'light', label: t('settingsHome.appearanceMode.light') },
                { value: 'dark', label: t('settingsHome.appearanceMode.dark') },
              ]}
              className="w-40"
            />
          </MenuRow>
          <MenuRow
            icon={Globe2}
            title={t('account.languageLabel')}
            detail={t('account.languageDescription')}
          >
            <SelectControl
              value={currentLanguage}
              onChange={(value) => void i18n.changeLanguage(value)}
              options={languages.map((language) => ({
                value: language.value,
                label: language.nativeName,
              }))}
              className="w-40"
            />
          </MenuRow>
          <MenuRow
            icon={ArrowUpDown}
            title={t('appearanceSettings.projectSorting.label')}
            detail={t('appearanceSettings.projectSorting.description')}
          >
            <SelectControl
              value={projectSortOrder}
              onChange={(value) => onProjectSortOrderChange(value as ProjectSortOrder)}
              options={[
                { value: 'name', label: t('appearanceSettings.projectSorting.alphabetical') },
                { value: 'date', label: t('appearanceSettings.projectSorting.recentActivity') },
              ]}
              className="w-44"
            />
          </MenuRow>
        </GroupedCard>
      </SettingsGroup>

      <SettingsGroup title={t('settingsHome.workflow')}>
        <GroupedCard divided>
          <NavigationRow
            icon={MessageSquare}
            title={t('settingsHome.chatInput.title')}
            detail={t('settingsHome.chatInput.detail')}
            onClick={() => onOpenPage('chatInput')}
          />
          <NavigationRow
            icon={Code2}
            title={t('appearanceSettings.codeEditor.title')}
            detail={t('settingsHome.codeEditor.detail')}
            onClick={() => onOpenPage('codeEditor')}
          />
        </GroupedCard>
      </SettingsGroup>

      <SettingsGroup title={t('settingsHome.advanced')}>
        <GroupedCard>
          <NavigationRow
            icon={Shield}
            title={t('mainTabs.permissions')}
            detail={t('settingsHome.permissions.detail')}
            onClick={() => onOpenPage('permissions')}
          />
        </GroupedCard>
      </SettingsGroup>

      <VersionUpdateSection />
    </div>
  );
}

function ChatInputSettingsPage() {
  const { t } = useTranslation('settings');
  const { preferences, setPreference } = useUiPreferences();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('quickSettings.sections.toolDisplay')}>
        <SettingsCard divided>
          <SettingsRow label={t('quickSettings.autoExpandTools')}>
            <SettingsToggle
              checked={preferences.autoExpandTools}
              onChange={(value) => setPreference('autoExpandTools', value)}
              ariaLabel={t('quickSettings.autoExpandTools')}
            />
          </SettingsRow>
          <SettingsRow label={t('quickSettings.showRawParameters')}>
            <SettingsToggle
              checked={preferences.showRawParameters}
              onChange={(value) => setPreference('showRawParameters', value)}
              ariaLabel={t('quickSettings.showRawParameters')}
            />
          </SettingsRow>
          <SettingsRow label={t('quickSettings.showThinking')}>
            <SettingsToggle
              checked={preferences.showThinking}
              onChange={(value) => setPreference('showThinking', value)}
              ariaLabel={t('quickSettings.showThinking')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('quickSettings.sections.viewOptions')}>
        <SettingsCard>
          <SettingsRow label={t('quickSettings.autoScrollToBottom')}>
            <SettingsToggle
              checked={preferences.autoScrollToBottom}
              onChange={(value) => setPreference('autoScrollToBottom', value)}
              ariaLabel={t('quickSettings.autoScrollToBottom')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('quickSettings.sections.inputSettings')}>
        <SettingsCard>
          <SettingsRow
            label={t('quickSettings.sendByCtrlEnter')}
            description={t('quickSettings.sendByCtrlEnterDescription')}
          >
            <SettingsToggle
              checked={preferences.sendByCtrlEnter}
              onChange={(value) => setPreference('sendByCtrlEnter', value)}
              ariaLabel={t('quickSettings.sendByCtrlEnter')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

type CodeEditorSettingsPageProps = {
  settings: CodeEditorSettingsState;
  onWordWrapChange: (value: boolean) => void;
  onShowMinimapChange: (value: boolean) => void;
  onLineNumbersChange: (value: boolean) => void;
  onFontSizeChange: (value: string) => void;
};

function CodeEditorSettingsPage({
  settings,
  onWordWrapChange,
  onShowMinimapChange,
  onLineNumbersChange,
  onFontSizeChange,
}: CodeEditorSettingsPageProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={settings.wordWrap}
              onChange={onWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={settings.showMinimap}
              onChange={onShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={settings.lineNumbers}
              onChange={onLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <SelectControl
              value={settings.fontSize}
              onChange={onFontSizeChange}
              options={['10', '11', '12', '13', '14', '15', '16', '18', '20'].map((size) => ({
                value: size,
                label: `${size}px`,
              }))}
              className="w-28"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

function SettingsGroup({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[15px] font-semibold leading-5 text-foreground">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function GroupedCard({ children, divided }: { children: ReactNode; divided?: boolean }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-card/60',
        divided && 'divide-y divide-border',
      )}
    >
      {children}
    </div>
  );
}

function MenuRow({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[66px] items-center gap-3.5 px-5 py-3">
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-5 text-foreground">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function NavigationRow({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[66px] w-full items-center gap-3.5 px-5 py-3 text-left transition-colors hover:bg-accent/35 active:bg-accent/50"
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-5 text-foreground">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div>
      </div>
      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </button>
  );
}

function SelectControl({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'h-9 rounded-lg border border-transparent bg-muted px-3 text-[13px] font-medium text-foreground outline-none transition-colors',
        'hover:bg-accent focus:border-ring focus:bg-card focus:ring-1 focus:ring-ring',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function VersionUpdateSection() {
  const { info, loading, triggerUpdate, triggerRestart, fetchVersion } = useGitVersion();
  const [phase, setPhase] = useState<'idle' | 'updating' | 'success' | 'error'>('idle');
  const [logs, setLogs] = useState<string[]>([]);

  const handleUpdate = async () => {
    setPhase('updating');
    setLogs([]);
    const result = await triggerUpdate();
    if (result.success) {
      setLogs(result.lines);
      setPhase('success');
    } else {
      setLogs(result.lines.length > 0 ? result.lines : ['Update failed']);
      setPhase('error');
    }
  };

  const handleRestart = async () => {
    document.title = 'Restarting PilotDeck...';
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh';
    document.body.innerHTML = `
      <div style="text-align:center;font-family:system-ui,-apple-system,sans-serif">
        <svg style="width:40px;height:40px;margin-bottom:16px;animation:spin 1s linear infinite" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
        <p style="color:#ccc;font-size:1.1rem;margin:0 0 8px">Restarting PilotDeck...</p>
        <p style="color:#666;font-size:0.8rem;margin:0">Page will reload automatically when server is ready.</p>
      </div>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
    triggerRestart().catch(() => {});
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/health');
        if (res.ok) { clearInterval(poll); window.location.reload(); }
      } catch { /* still down */ }
    }, 2000);
  };

  if (!info) return null;

  return (
    <SettingsGroup title="About">
      <GroupedCard divided>
        <div className="flex min-h-[66px] items-center gap-3.5 px-5 py-3">
          <GitCommit className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-5 text-foreground">Version</div>
            <div className="mt-0.5 text-xs leading-5 font-mono text-muted-foreground">
              {info.currentCommit} · {info.branch}
            </div>
          </div>
          {info.hasUpdate && phase === 'idle' && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
              {info.behindCount} update{info.behindCount > 1 ? 's' : ''}
            </span>
          )}
        </div>

        {info.hasUpdate && phase === 'idle' && (
          <div className="px-5 py-3">
            {info.newCommits.length > 0 && (
              <ul className="mb-3 space-y-1">
                {info.newCommits.slice(0, 5).map((commit, i) => (
                  <li key={i} className="truncate text-xs font-mono text-muted-foreground">
                    {commit}
                  </li>
                ))}
                {info.newCommits.length > 5 && (
                  <li className="text-xs text-muted-foreground">
                    ... and {info.newCommits.length - 5} more
                  </li>
                )}
              </ul>
            )}
            <button
              type="button"
              onClick={handleUpdate}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
            >
              <Download className="h-3.5 w-3.5" />
              Update Now
            </button>
          </div>
        )}

        {phase === 'updating' && (
          <div className="px-5 py-3">
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
              <span className="text-sm font-medium text-foreground">Updating...</span>
            </div>
            <div className="max-h-32 overflow-y-auto rounded bg-neutral-900 p-2">
              {logs.map((line, i) => (
                <div key={i} className="text-[11px] font-mono text-neutral-300 leading-relaxed">{line}</div>
              ))}
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="px-5 py-3 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-green-700 dark:text-green-400">Update complete!</span>
            </div>
            <button
              type="button"
              onClick={handleRestart}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Restart to Apply
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="px-5 py-3">
            <p className="text-sm font-medium text-red-700 dark:text-red-400 mb-2">Update failed</p>
            <div className="max-h-24 overflow-y-auto rounded bg-neutral-900 p-2">
              {logs.slice(-3).map((line, i) => (
                <div key={i} className="text-[11px] font-mono text-red-300 leading-relaxed">{line}</div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => { setPhase('idle'); fetchVersion(); }}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        )}
      </GroupedCard>
    </SettingsGroup>
  );
}

export default Settings;
