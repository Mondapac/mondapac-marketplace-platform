'use client';

import { useTranslations } from 'next-intl';

export interface SizeItem {
  readonly variantId: string;
  /** The variant label, or its code when it has none. */
  readonly label: string;
  readonly checked: boolean;
  /** The last size still on sale: it cannot be unticked. */
  readonly locked: boolean;
}

/**
 * "Sizes you sell" (variants V5), shown on a PLATFORM product: one checkbox per variant of the
 * product. It drives the same Selling state as the table's Selling column, so a size is on or off in
 * one place only. At least one size stays ticked; the last one is disabled with a hint.
 */
export function SizesYouSell({
  items,
  disabled,
  hintId,
  onChange,
}: {
  readonly items: readonly SizeItem[];
  readonly disabled: boolean;
  /** The id of the hint, so the disabled checkbox can point to it. */
  readonly hintId: string;
  readonly onChange: (variantId: string, on: boolean) => void;
}) {
  const t = useTranslations();
  const hasLocked = items.some((item) => item.locked);
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-line p-4">
      <legend className="px-1 text-sm font-semibold">
        {t('catalog.variants-table.units.sizes')}
      </legend>
      <p className="text-sm text-fg-muted">{t('catalog.variants-table.units.sizes-help')}</p>
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {items.map((item) => (
          <li key={item.variantId}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={item.checked}
                disabled={disabled || item.locked}
                aria-describedby={item.locked && hasLocked ? hintId : undefined}
                onChange={(event) => onChange(item.variantId, event.target.checked)}
              />
              <span>{item.label}</span>
            </label>
          </li>
        ))}
      </ul>
      {hasLocked ? (
        <p id={hintId} className="text-sm text-fg-muted">
          {t('catalog.variants-table.units.last-hint')}
        </p>
      ) : null}
    </fieldset>
  );
}
