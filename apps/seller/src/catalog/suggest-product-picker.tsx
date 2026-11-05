'use client';

import { Button, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/**
 * Step 1 of "Suggest a value": the product that needs the value. A plain GET form, so the next
 * step is a page of its own (`?product=`); a field named by the link that brought the seller here
 * is carried along.
 */
export function SuggestProductPicker({
  products,
  field,
}: {
  readonly products: readonly { readonly id: string; readonly label: string }[];
  readonly field?: string | undefined;
}) {
  const t = useTranslations('catalog.suggestions.new');
  return (
    <form method="get" action="/value-suggestions/new" className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">{t('product-help')}</p>
      <Select
        name="product"
        label={t('product')}
        placeholder={t('product-placeholder')}
        options={products.map((product) => ({ value: product.id, label: product.label }))}
        defaultValue=""
        required
      />
      {field === undefined ? null : <input type="hidden" name="field" value={field} />}
      <div>
        <Button type="submit">{t('continue')}</Button>
      </div>
    </form>
  );
}
