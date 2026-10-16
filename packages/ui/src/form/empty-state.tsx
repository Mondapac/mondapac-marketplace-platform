import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';

export interface EmptyStateProps {
  readonly icon: IconName;
  readonly title: string;
  readonly body?: string;
  /** An optional next step, such as a button or a link. */
  readonly action?: ReactNode;
}

/** Figma EmptyState: an icon tile, a title, a line of help and an optional action. */
export function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface px-6 py-10 text-center">
      <span className="flex size-(--mp-size-control-lg) items-center justify-center rounded-full bg-muted text-icon">
        <Icon name={icon} />
      </span>
      <p className="font-medium text-fg">{title}</p>
      {body === undefined ? null : <p className="max-w-prose text-sm text-fg-muted">{body}</p>}
      {action ?? null}
    </div>
  );
}
