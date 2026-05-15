import { useTranslation } from 'react-i18next';
import type { Project } from '../../types/app';
import AlwaysOnDashboard from './AlwaysOnDashboard';

type AlwaysOnV2Props = {
  selectedProject: Project | null;
};

export default function AlwaysOnV2({ selectedProject }: AlwaysOnV2Props) {
  const { t } = useTranslation('alwaysOn');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('emptyProject', { defaultValue: 'Pick a project to view Always-On.' })}
      </div>
    );
  }

  return (
    <div className="h-full bg-white dark:bg-neutral-950">
      <AlwaysOnDashboard />
    </div>
  );
}
