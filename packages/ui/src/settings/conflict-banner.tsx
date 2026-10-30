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
  /** Whether the list the button opens is showing (`aria-expanded`). */
  readonly compareExpanded?: boolean;
  /** The id of that list (`aria-controls`). */
  readonly compareControls?: string;
}

/** Someone saved first: the user's changes are kept and the banner says who changed what. */
export function SettingsConflictBanner({
  title,
  body,
  compareLabel,
  onCompare,
  compareExpanded,
  compareControls,
}: SettingsConflictBannerProps) {
  return (
    <Banner tone="attention" title={title}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0">{body}</p>
        {compareLabel && onCompare ? (
          <Button
            variant="secondary"
            onClick={onCompare}
            aria-expanded={compareExpanded}
            aria-controls={compareControls}
          >
            {compareLabel}
          </Button>
        ) : null}
      </div>
    </Banner>
  );
}
