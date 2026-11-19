import { Icon } from '../icon/icon.tsx';
import { Button } from './button.tsx';

export interface UnsavedBarProps {
  /** "Unsaved changes", or "2 fields need fixing" in the error state. */
  readonly label: string;
  /** The save was refused: error colours, and Save is disabled until the fields are fixed. */
  readonly error?: boolean;
  /** Name of the bar's landmark. */
  readonly region: string;
  readonly discardLabel: string;
  /** "Save draft", or "Save revision" on a published product. */
  readonly saveLabel: string;
  readonly saving?: boolean;
  readonly onDiscard: () => void;
}

/**
 * The bar at the top of a long form while there are unsaved changes: what is wrong or pending,
 * Discard, and Save (a submit button, so the bar belongs inside the form). It sticks under the
 * top bar of the panel, so Save stays in reach on a phone as well.
 */
export function UnsavedBar({
  label,
  error = false,
  region,
  discardLabel,
  saveLabel,
  saving = false,
  onDiscard,
}: UnsavedBarProps) {
  return (
    <div
      role="region"
      aria-label={region}
      className={`sticky top-(--mp-size-topbar-phone) z-[5] flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-2.5 md:top-(--mp-size-topbar) ${
        error
          ? 'border-critical-border bg-critical-bg text-critical-fg'
          : 'border-info-border bg-info-banner text-fg'
      }`}
    >
      <p
        role={error ? 'alert' : 'status'}
        className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold"
      >
        <Icon name={error ? 'alert-circle' : 'info'} />
        <span className="min-w-0 break-words">{label}</span>
      </p>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <Button variant="secondary" disabled={saving} onClick={onDiscard}>
          {discardLabel}
        </Button>
        <Button type="submit" disabled={error} loading={saving}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
