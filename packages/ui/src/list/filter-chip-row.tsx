import type { ReactNode } from 'react';
import { Button } from '../form/button.tsx';
import { FilterChip } from '../form/filter-chip.tsx';
import { Icon } from '../icon/icon.tsx';

export interface FilterChipRowChip {
  readonly key: string;
  readonly label: string;
  readonly removeLabel: string;
  readonly onRemove: () => void;
}

export interface FilterChipRowProps {
  readonly chips: readonly FilterChipRowChip[];
  /** "Clear all"; omitted when nothing is filtered. */
  readonly clearAll?: { readonly label: string; readonly onClick: () => void };
  /** "Save filter…"; omitted when the list cannot be saved or is already a saved view. */
  readonly save?: { readonly label: string; readonly onClick: () => void };
  /** The live result count ("12 products match"), announced to screen readers. */
  readonly status: ReactNode;
}

/**
 * The row under a list's toolbar: the removable chips, a thin divider, Clear all (neutral text) and
 * Save filter… (small outline button with a star), and the result count at the end. Chips, buttons
 * and divider share one 32 px height. One component for every super list.
 */
export function FilterChipRow({ chips, clearAll, save, status }: FilterChipRowProps) {
  const actions = clearAll !== undefined || save !== undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <FilterChip
          key={chip.key}
          label={chip.label}
          removeLabel={chip.removeLabel}
          onRemove={chip.onRemove}
        />
      ))}
      {chips.length > 0 && actions ? (
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />
      ) : null}
      {clearAll === undefined ? null : (
        <Button variant="quiet" size="sm" onClick={clearAll.onClick}>
          {clearAll.label}
        </Button>
      )}
      {save === undefined ? null : (
        <Button variant="secondary" size="sm" onClick={save.onClick}>
          <Icon name="star" />
          {save.label}
        </Button>
      )}
      <p role="status" className="text-sm font-medium text-fg-secondary sm:ms-auto">
        {status}
      </p>
    </div>
  );
}
