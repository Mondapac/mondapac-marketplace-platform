import { Icon } from '../icon/icon.tsx';

export interface FilterChipProps {
  /** The condition in words, e.g. "Status is Active". */
  readonly label: string;
  /** Accessible name of the remove button, e.g. "Remove filter Status is Active". */
  readonly removeLabel: string;
  readonly onRemove: () => void;
}

/** Figma FilterChip (Applied): one applied condition with a button that removes it. */
export function FilterChip({ label, removeLabel, onRemove }: FilterChipProps) {
  return (
    <span className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full bg-muted ps-3 pe-1 text-sm text-fg">
      <span className="min-w-0 break-words">{label}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-icon hover:bg-surface"
      >
        <Icon name="x" />
      </button>
    </span>
  );
}
