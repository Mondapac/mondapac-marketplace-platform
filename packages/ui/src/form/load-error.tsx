'use client';

import { Banner } from './banner.tsx';
import { Button } from './button.tsx';

export interface LoadErrorProps {
  /** The body under the title, in the reader's words ("Try again. If it keeps happening, ..."). */
  readonly message: string;
  readonly retryLabel: string;
  /** Called by the button. Without it the page is reloaded (server-rendered pages). */
  readonly onRetry?: () => void;
  /** Around the banner; the default adds page padding. */
  readonly className?: string;
  /** The banner's bold first line: what could not be loaded ("Delivery settings could not be loaded"). */
  readonly title?: string;
}

/**
 * A load error: a critical banner with what failed (title), what to do (body) and a "try again"
 * button. One place for every page that can fail to load.
 */
export function LoadError({ message, retryLabel, onRetry, className, title }: LoadErrorProps) {
  return (
    <div className={className ?? 'p-6'}>
      <Banner tone="critical" title={title}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0">{message}</p>
          <Button variant="secondary" onClick={onRetry ?? (() => window.location.reload())}>
            {retryLabel}
          </Button>
        </div>
      </Banner>
    </div>
  );
}
