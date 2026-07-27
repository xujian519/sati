import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Grid3X3, MousePointer2, Quote, Scan, X } from 'lucide-react';
import type {
  ContentReferenceSelectionMode,
  ReferenceCapabilities,
} from '../../../../types/contentReference';

type ContentReferenceMenuProps = {
  capabilities: ReferenceCapabilities;
  activeMode?: ContentReferenceSelectionMode | null;
  onSelectMode: (mode: ContentReferenceSelectionMode) => void;
  onCancelMode?: () => void;
  compact?: boolean;
};

const labels: Record<ContentReferenceSelectionMode, string> = {
  text: '选择文字',
  cells: '选择单元格',
  region: '框选区域',
};

const descriptions: Record<ContentReferenceSelectionMode, string> = {
  text: '拖动选择可复制的文字',
  cells: '选择一个或多个连续区域',
  region: '一次性框选并作为图片引用',
};

const reasonLabels: Record<string, string> = {
  NO_TEXT_LAYER: '当前视图没有可选择的文字层',
  NO_CELL_MODEL: '当前视图没有单元格模型',
  SURFACE_NOT_READY: '预览仍在加载',
  CAPTURE_UNAVAILABLE: '当前视图无法截图',
  UNSUPPORTED_RENDERER: '当前预览器暂不支持',
};

const modeIcons = {
  text: Quote,
  cells: Grid3X3,
  region: Scan,
};

export default function ContentReferenceMenu({
  capabilities,
  activeMode = null,
  onSelectMode,
  onCancelMode,
  compact = false,
}: ContentReferenceMenuProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const updatePosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 240;
    setPosition({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)),
    });
  };

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const ActiveIcon = activeMode ? modeIcons[activeMode] : MousePointer2;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={activeMode ? `${labels[activeMode]}（再次点击取消）` : '添加到对话'}
        className={[
          'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] transition-colors',
          activeMode
            ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
            : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50',
        ].join(' ')}
        onClick={() => {
          if (activeMode && onCancelMode) {
            onCancelMode();
            setOpen(false);
            return;
          }
          updatePosition();
          setOpen((value) => !value);
        }}
      >
        <ActiveIcon className="h-4 w-4" strokeWidth={1.75} />
        {!compact ? <span>{activeMode ? labels[activeMode] : '引用'}</span> : null}
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[120] w-60 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-950"
          style={position}
        >
          {(Object.keys(labels) as ContentReferenceSelectionMode[]).map((mode) => {
            const capability = capabilities[mode];
            const Icon = modeIcons[mode];
            const disabled = capability.state !== 'available';
            const reason = capability.state === 'loading'
              ? '正在准备预览能力'
              : capability.reason
                ? reasonLabels[capability.reason] || capability.reason
                : descriptions[mode];
            return (
              <button
                key={mode}
                type="button"
                role="menuitem"
                disabled={disabled}
                className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-neutral-900"
                title={reason}
                onClick={() => {
                  setOpen(false);
                  onSelectMode(mode);
                }}
              >
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                    {labels[mode]}
                    {mode === capabilities.recommendedMode ? (
                      <span className="ml-1.5 text-[10px] font-normal text-blue-600 dark:text-blue-300">推荐</span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
                    {disabled ? reason : descriptions[mode]}
                  </span>
                </span>
              </button>
            );
          })}
          <div className="mt-1 border-t border-neutral-100 pt-1 dark:border-neutral-800">
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[12px] text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
              关闭菜单
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

