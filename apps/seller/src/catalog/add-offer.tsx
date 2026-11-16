'use client';

import { Card, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { readable } from './format.ts';
import type { ProductOptions, ProductView } from './types.ts';

/**
 * The product the Add page starts from. Nothing exists on the server yet, so the form, the
 * variants and the draft are empty; the first Save draft creates the product (see EditForm).
 */
export const BLANK_PRODUCT: ProductView = {
  productId: '',
  productCode: '',
  typeCode: '',
  familyCode: '',
  variantModel: 'single',
  status: 'draft',
  pausedAt: null,
  variants: [],
  maxVariants: 0,
  sensitiveFields: [],
  lastChangedAt: '',
  createdAt: '',
  pendingSubmittedAt: null,
  form: { taxCategoryCodes: [], units: [], fields: [], categories: [] },
  workingCopy: null,
  published: null,
  pending: null,
};

/** The condition a new offer starts on: "new" when the Market offers it. */
export function defaultCondition(options: ProductOptions): string {
  return options.conditions.includes('new') ? 'new' : '';
}

/**
 * "Your offer": what the seller's own offer on the new product needs (type, condition, SKU).
 * Seller only; the product itself never carries them.
 */
export function YourOfferCard({
  options,
  typeCode,
  conditionCode,
  sellerSku,
  error,
  onType,
  onCondition,
  onSku,
}: {
  readonly options: ProductOptions;
  readonly typeCode: string;
  readonly conditionCode: string;
  readonly sellerSku: string;
  /** The message of a refusal per field name (`typeCode`, `conditionCode`, `sellerSku`). */
  readonly error: (path: string) => string | undefined;
  readonly onType: (value: string) => void;
  readonly onCondition: (value: string) => void;
  readonly onSku: (value: string) => void;
}) {
  const t = useTranslations();
  return (
    <Card title={t('catalog.add.offer.title')}>
      <p className="text-sm text-fg-muted">{t('catalog.add.offer.help')}</p>
      <Select
        name="typeCode"
        label={t('catalog.create.type')}
        value={typeCode}
        placeholder={t('catalog.create.choose')}
        error={error('typeCode')}
        options={options.productTypes.map((code) => ({ value: code, label: readable(code) }))}
        onChange={(event) => onType(event.target.value)}
      />
      <Select
        name="conditionCode"
        label={t('catalog.create.condition')}
        value={conditionCode}
        placeholder={t('catalog.create.choose')}
        error={error('conditionCode')}
        options={options.conditions.map((code) => ({ value: code, label: readable(code) }))}
        onChange={(event) => onCondition(event.target.value)}
      />
      <TextField
        name="sellerSku"
        label={t('catalog.create.sku')}
        help={t('catalog.create.sku-help')}
        value={sellerSku}
        error={error('sellerSku')}
        onChange={(event) => onSku(event.target.value)}
      />
    </Card>
  );
}

/**
 * A card whose content needs the saved product (its category list, product details, variants and
 * photo library are read from it): drawn empty, with one line saying when it fills.
 */
export function LaterCard({ title, help }: { readonly title: string; readonly help: string }) {
  return (
    <Card title={title}>
      <p className="text-sm text-fg-muted">{help}</p>
    </Card>
  );
}
