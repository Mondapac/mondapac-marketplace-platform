'use client';

import { Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { CHECKBOX } from './sku-field.tsx';

export interface SizeItem {
  readonly variantId: string;
  /** The variant label, or its code when it has none. */
  readonly label: string;
  readonly checked: boolean;
  /** The last size still on sale: it cannot be unticked. */
  readonly locked: boolean;
}

/** The note shown while only one size is on sale: it cannot be switched off. */
export function LastSizeHint({ id }: { readonly id: string }) {
  const t = useTranslations();
  return (
    <p
      id={id}
      className="flex items-start gap-2 rounded-md bg-info-bg px-3 py-2 text-sm text-info-fg"
    >
      <span className="mt-0.5 size-4 shrink-0">
        <Icon name="info" className="size-4" />
      </span>
      <span>{t('catalog.variants-table.units.last-hint')}</span>
    </p>
  );
}

/**
 * "Sizes you sell" (variants V5), shown on a PLATFORM product: one checkbox per variant of the
 * product. It drives the same On sale state as the table's On sale column, so a size is on or off
 * in one place only. At least one size stays ticked; the last one is disabled with a hint. A
 * fieldset with a legend for assistive technology, drawn as a card section.
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
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <legend className="mb-1 p-0 text-sm font-semibold text-fg">
        {t('catalog.variants-table.units.sizes')}
      </legend>
      <p className="text-sm text-fg-muted">{t('catalog.variants-table.units.sizes-help')}</p>
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {items.map((item) => (
          <li key={item.variantId}>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={item.checked}
                disabled={disabled || item.locked}
                aria-describedby={item.locked ? hintId : undefined}
                onChange={(event) => onChange(item.variantId, event.target.checked)}
              />
              <span>{item.label}</span>
            </label>
          </li>
        ))}
      </ul>
      {hasLocked ? <LastSizeHint id={hintId} /> : null}
    </fieldset>
  );
}
