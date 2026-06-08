// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlwaysOnDashboardEvent, AlwaysOnSubTab, AppTab, Project, ProjectSession } from '../../types/app';
import { api } from '../../utils/api';
import MainAreaV2 from './MainAreaV2';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('../main-content/view/MainContent', () => ({
  default: ({ onAlwaysOnSubTabChange }: { onAlwaysOnSubTabChange?: (tab: AlwaysOnSubTab) => void }) => (
    <div data-testid="main-content">
      <button type="button" onClick={() => onAlwaysOnSubTabChange?.('dashboard')}>
        mock dashboard
      </button>
      <button type="button" onClick={() => onAlwaysOnSubTabChange?.('plans-cron')}>
        mock plans cron
      </button>
    </div>
  ),
}));

vi.mock('../../utils/api', () => ({
  api: {
    alwaysOnDashboardEvents: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function makeResponse(events: AlwaysOnDashboardEvent[]) {
  return {
    ok: true,
    json: async () => ({ events }),
  } as Response;
}

function makeEvent(
  phase: AlwaysOnDashboardEvent['phase'],
  overrides: Partial<AlwaysOnDashboardEvent> = {},
): AlwaysOnDashboardEvent {
  return {
    eventId: `${phase}-event`,
    runId: 'run-1',
    projectKey: '/tmp/other-project',
    projectName: 'other-project',
    projectDisplayName: 'Other Project',
    phase,
    timestamp: '2026-06-08T10:00:00.000Z',
    ...overrides,
  };
}

function renderMainArea({
  activeTab = 'chat',
  selectedProject = null,
}: {
  activeTab?: AppTab;
  selectedProject?: Project | null;
} = {}) {
  return render(
    <MainAreaV2
      projects={[]}
      selectedProject={selectedProject}
      selectedSession={null}
      activeTab={activeTab}
      setActiveTab={() => {}}
      ws={null}
      sendMessage={() => {}}
      latestMessage={null}
      isMobile={false}
      onMenuClick={() => {}}
      isLoading={false}
      onInputFocusChange={() => {}}
      onSessionActive={() => {}}
      onSessionInactive={() => {}}
      onSessionProcessing={() => {}}
      onSessionNotProcessing={() => {}}
      processingSessions={new Set<string>()}
      onReplaceTemporarySession={() => {}}
      onNavigateToSession={() => {}}
      onStartNewSession={() => {}}
      onShowSettings={() => {}}
      externalMessageUpdate={0}
    />,
  );
}

function getAlwaysOnTab() {
  return screen.getByRole('tab', { name: /tabs\.alwaysOn/i });
}

function getBadge() {
  return getAlwaysOnTab().querySelector('span[aria-hidden="true"]');
}

describe('MainAreaV2 Always-On event badge', () => {
  it('shows the badge for a global plan produced event', async () => {
    vi.mocked(api.alwaysOnDashboardEvents).mockResolvedValue(
      makeResponse([makeEvent('plan_produced')]),
    );

    renderMainArea({ activeTab: 'chat' });

    await waitFor(() => expect(getBadge()).not.toBeNull());
  });

  it('shows the badge for a global report produced event', async () => {
    vi.mocked(api.alwaysOnDashboardEvents).mockResolvedValue(
      makeResponse([makeEvent('report_produced')]),
    );

    renderMainArea({ activeTab: 'chat' });

    await waitFor(() => expect(getBadge()).not.toBeNull());
  });

  it('ignores dashboard events that are not plan or report production', async () => {
    vi.mocked(api.alwaysOnDashboardEvents).mockResolvedValue(
      makeResponse([
        makeEvent('discovery_started'),
        makeEvent('no_plan', { eventId: 'no-plan-event', timestamp: '2026-06-08T10:01:00.000Z' }),
        makeEvent('run_completed', { eventId: 'run-completed-event', timestamp: '2026-06-08T10:02:00.000Z' }),
      ]),
    );

    renderMainArea({ activeTab: 'chat' });

    await waitFor(() => expect(api.alwaysOnDashboardEvents).toHaveBeenCalled());
    expect(getBadge()).toBeNull();
  });

  it('clears the badge when the Always-On Dashboard subtab is open', async () => {
    vi.mocked(api.alwaysOnDashboardEvents).mockResolvedValue(
      makeResponse([makeEvent('plan_produced')]),
    );

    renderMainArea({ activeTab: 'always-on' });

    await waitFor(() => expect(api.alwaysOnDashboardEvents).toHaveBeenCalled());
    await waitFor(() => expect(getBadge()).toBeNull());
  });

  it('clears the badge when Always-On is open on Plans & Cron Jobs', async () => {
    let resolveEvents: (response: Response) => void = () => {};
    vi.mocked(api.alwaysOnDashboardEvents).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveEvents = resolve;
      }),
    );

    renderMainArea({ activeTab: 'always-on' });
    fireEvent.click(screen.getByRole('button', { name: 'mock plans cron' }));
    resolveEvents(makeResponse([makeEvent('report_produced')]));

    await waitFor(() => expect(getBadge()).toBeNull());
  });

  it('shows the badge again after leaving Always-On when a newer plan or report event appears', async () => {
    vi.useFakeTimers();
    vi.mocked(api.alwaysOnDashboardEvents)
      .mockResolvedValueOnce(makeResponse([
        makeEvent('plan_produced', { eventId: 'plan-1', timestamp: '2026-06-08T10:00:00.000Z' }),
      ]))
      .mockResolvedValueOnce(makeResponse([
        makeEvent('report_produced', { eventId: 'report-1', timestamp: '2026-06-08T10:05:00.000Z' }),
      ]));

    const { rerender } = renderMainArea({ activeTab: 'always-on' });

    await act(async () => {
      await Promise.resolve();
    });
    expect(api.alwaysOnDashboardEvents).toHaveBeenCalledTimes(1);
    expect(getBadge()).toBeNull();

    rerender(
      <MainAreaV2
        projects={[]}
        selectedProject={null}
        selectedSession={null}
        activeTab="chat"
        setActiveTab={() => {}}
        ws={null}
        sendMessage={() => {}}
        latestMessage={null}
        isMobile={false}
        onMenuClick={() => {}}
        isLoading={false}
        onInputFocusChange={() => {}}
        onSessionActive={() => {}}
        onSessionInactive={() => {}}
        onSessionProcessing={() => {}}
        onSessionNotProcessing={() => {}}
        processingSessions={new Set<string>()}
        onReplaceTemporarySession={() => {}}
        onNavigateToSession={() => {}}
        onStartNewSession={() => {}}
        onShowSettings={() => {}}
        externalMessageUpdate={0}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(getBadge()).not.toBeNull();
  });
});
