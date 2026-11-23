'use client';

import { Icon } from '../icon/icon.tsx';
import { useHelp } from './help-context.tsx';

export interface HelpButtonProps {
  /** The visible label and the accessible name: "Help". */
  readonly label: string;
}

/**
 * The page's Help button: at a fixed place in the top bar, before Search. A question-mark icon
 * with the label from 640 px; on phones the icon alone, with the same accessible name and a 44 px
 * touch target.
 */
export function HelpButton({ label }: HelpButtonProps) {
  const { open, setOpen, trigger, panelId, hasContent } = useHelp();
  if (!hasContent) return null;
  return (
    <button
      ref={trigger}
      type="button"
      aria-expanded={open}
      aria-pressed={open}
      aria-controls={open ? panelId : undefined}
      aria-label={label}
      onClick={() => setOpen(!open)}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border-line-control px-2 text-sm font-medium hover:text-fg focus-visible:outline-2 focus-visible:outline-focus sm:px-3 md:min-h-10 md:border ${open ? 'border border-line-input bg-selected text-fg' : 'text-fg-secondary hover:bg-muted md:bg-subtle'}`}
    >
      <Icon name="help" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
