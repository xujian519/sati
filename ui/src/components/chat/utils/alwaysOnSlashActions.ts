import type { ExecuteDiscoveryPlanResponse } from '../../../types/app';
import type { ChatMessage } from '../types/types';

export type AlwaysOnSlashCommandData = {
  mode?: 'message' | 'run-plan';
  content?: string;
  execution?: ExecuteDiscoveryPlanResponse | null;
};

type HandleAlwaysOnSlashActionArgs = {
  data?: AlwaysOnSlashCommandData | null;
  addMessage: (message: ChatMessage) => void;
  onLaunchAlwaysOnPlanExecution?: ((execution: ExecuteDiscoveryPlanResponse) => void | Promise<void>) | null;
};

export async function handleAlwaysOnSlashAction({
  data,
  addMessage,
  onLaunchAlwaysOnPlanExecution,
}: HandleAlwaysOnSlashActionArgs): Promise<void> {
  if (typeof data?.content === 'string' && data.content.trim().length > 0) {
    addMessage({
      type: 'assistant',
      content: data.content,
      timestamp: Date.now(),
    });
  }

  if (data?.mode !== 'run-plan') {
    return;
  }

  if (!data.execution) {
    throw new Error('Always-On plan execution payload is missing.');
  }

  if (!onLaunchAlwaysOnPlanExecution) {
    throw new Error('Always-On plan execution is unavailable in this view.');
  }

  await onLaunchAlwaysOnPlanExecution(data.execution);
}
