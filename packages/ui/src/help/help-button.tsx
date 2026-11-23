'use client';

import { TopbarIconButton } from '../shell/topbar-icon-button.tsx';
import { Icon } from '../icon/icon.tsx';
import { useHelp } from './help-context.tsx';

export interface HelpButtonProps {
  /** The visible label and the accessible name: "Help". */
  readonly label: string;
}

/**
 * The page's Help button: at a fixed place in the top bar, before Search. A round question-mark icon;
 * the label is its accessible name and tooltip.
 */
export function HelpButton({ label }: HelpButtonProps) {
  const { open, setOpen, trigger, panelId, hasContent } = useHelp();
  if (!hasContent) return null;
  return (
    <TopbarIconButton
      ref={trigger}
      label={label}
      aria-expanded={open}
      aria-pressed={open}
      aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(!open)}
    >
      <Icon name="help" />
    </TopbarIconButton>
  );
}
