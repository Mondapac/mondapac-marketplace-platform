import { Banner } from '../form/banner.tsx';
import { Button } from '../form/button.tsx';

export interface SettingsConflictBannerProps {
  /** "Sara K. saved these settings 1 minute ago" */
  readonly title: string;
  /** "Your 2 changes are kept. Review what changed, then save again." */
  readonly body: string;
  /** With `onCompare`, a button that shows what changed. */
  readonly compareLabel?: string;
  readonly onCompare?: () => void;
}

/** Someone saved first: the user's changes are kept and the banner says who changed what. */
export function SettingsConflictBanner({
  title,
  body,
  compareLabel,
  onCompare,
}: SettingsConflictBannerProps) {
  return (
    <Banner tone="attention" title={title}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0">{body}</p>
        {compareLabel && onCompare ? (
          <Button variant="secondary" onClick={onCompare}>
            {compareLabel}
          </Button>
        ) : null}
      </div>
    </Banner>
  );
}
