'use client';

import { Button } from './button.tsx';

export interface LoadErrorProps {
  /** What went wrong, in the reader's words. */
  readonly message: string;
  readonly retryLabel: string;
  /** Called by the button. Without it the page is reloaded (server-rendered pages). */
  readonly onRetry?: () => void;
  readonly className?: string;
}

/** A load error with a "try again" button: one place for every page that can fail to load. */
export function LoadError({ message, retryLabel, onRetry, className }: LoadErrorProps) {
  return (
    <div role="alert" className={className ?? 'flex flex-col items-start gap-3 p-6'}>
      <p className="text-fg-muted">{message}</p>
      <Button variant="secondary" onClick={onRetry ?? (() => window.location.reload())}>
        {retryLabel}
      </Button>
    </div>
  );
}
