'use client';

import { Badge, CARD_TABLE, EmptyState, FilterChip, LinkButton, Select } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstant } from '../shared/format.ts';
import {
  clearedHref,
  isFiltered,
  queueHref,
  type ChangeFilter,
  type PhotoFilter,
  type QueueParams,
} from './review-queue-params.ts';
import { REVISION_REASONS, type RevisionRow } from './types.ts';

const COLUMNS = ['product', 'change', 'seller', 'reasons', 'checks', 'waiting', 'action'] as const;
const KNOWN_REASONS: ReadonlySet<string> = new Set(REVISION_REASONS);

const go = (href: string) => window.location.assign(href);

/** The page's link to one product version review. */
export const revisionHref = (row: Pick<RevisionRow, 'productId' | 'revisionId'>): string =>
  `/review/products/${row.productId}/revisions/${row.revisionId}`;

/**
 * The filters of the Product revisions tab: change (new or update), photos, and the seller picked
 * from a row (a chip with the store name). Each choice opens the first page with that filter.
 */
export function RevisionFilters({
  params,
  sellerName,
}: {
  readonly params: QueueParams;
  /** The store name of the filtered seller, when a row of the page names it. */
  readonly sellerName: string | null;
}) {
  const t = useTranslations('catalog.queue');
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
        <div className="lg:w-56">
          <Select
            label={t('filter.change')}
            value={params.change}
            onChange={(event) =>
              go(queueHref(params, { change: event.target.value as ChangeFilter }))
            }
            options={(['all', 'new', 'update'] as const).map((value) => ({
              value,
              label: t(`filter.change-${value}`),
            }))}
          />
        </div>
        <div className="lg:w-56">
          <Select
            label={t('filter.photos')}
            value={params.photos}
            onChange={(event) =>
              go(queueHref(params, { photos: event.target.value as PhotoFilter }))
            }
            options={(['any', 'with'] as const).map((value) => ({
              value,
              label: t(`filter.photos-${value}`),
            }))}
          />
        </div>
      </div>
      <SellerChip params={params} sellerName={sellerName} />
    </div>
  );
}

/** The applied seller filter, on either tab, and the way back to the whole queue. */
export function SellerChip({
  params,
  sellerName,
}: {
  readonly params: QueueParams;
  readonly sellerName: string | null;
}) {
  const t = useTranslations('catalog.queue');
  if (!isFiltered(params)) return null;
  // No row of the page names the seller (an empty filtered page): say a seller filter is on
  // without guessing its name.
  const sellerLabel =
    params.seller === null
      ? null
      : sellerName === null
        ? t('filter.seller-picked')
        : t('filter.seller-is', { name: sellerName });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {sellerLabel === null ? null : (
        <FilterChip
          label={sellerLabel}
          removeLabel={t('filter.remove', { filter: sellerLabel })}
          onRemove={() => go(queueHref(params, { seller: null }))}
        />
      )}
      <a
        className="min-h-8 content-center text-sm font-medium text-link underline"
        href={clearedHref(params)}
      >
        {t('filter.clear')}
      </a>
    </div>
  );
}

/**
 * The pending product revisions of one page, oldest first: a table from 1024 px and a stack of
 * cards below it. A row opens its version review; the store name filters the queue by seller.
 */
export function RevisionQueueTable({
  rows,
  params,
}: {
  readonly rows: readonly RevisionRow[];
  readonly params: QueueParams;
}) {
  const t = useTranslations('catalog.queue');
  const locale = useLocale();
  const label = (col: (typeof COLUMNS)[number]) => t(`col.${col}`);
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('tab.revision')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {col === 'action' ? <span className="sr-only">{label(col)}</span> : label(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => {
            const name = row.product.name ?? row.product.productCode ?? t('unnamed-product');
            const store = row.storeName ?? t('filter.seller-unnamed');
            return (
              <tr key={row.revisionId} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} lg:min-w-48 lg:max-w-72`}>
                  <div className="break-words font-medium text-fg">{name}</div>
                  <div className="text-fg-muted">
                    {t('revision-no', { number: row.revisionNo })}
                    {row.product.productCode === null ? null : ` · ${row.product.productCode}`}
                  </div>
                </td>
                <td className={CARD_TABLE.corner}>
                  <Badge tone={row.firstPublication ? 'info' : 'neutral'}>
                    {t(row.firstPublication ? 'change.new' : 'change.update')}
                  </Badge>
                </td>
                <td className={CARD_TABLE.labelled} data-label={label('seller')}>
                  <a
                    className="break-words text-link underline"
                    href={queueHref(params, { seller: row.sellerId })}
                    aria-label={t('filter.by-seller', { name: store })}
                  >
                    {store}
                  </a>
                </td>
                <td className={CARD_TABLE.labelled} data-label={label('reasons')}>
                  <ul className="flex flex-wrap gap-1">
                    {row.reasons.map((reason) => (
                      <li key={reason}>
                        <Badge tone="neutral">
                          {KNOWN_REASONS.has(reason) ? t(`reason.${reason}`) : reason}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </td>
                <td
                  className={`${CARD_TABLE.labelled} tabular-nums lg:whitespace-nowrap`}
                  data-label={label('checks')}
                >
                  {t('checks', { count: row.requiredChecks.length })}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} lg:whitespace-nowrap`}
                  data-label={label('waiting')}
                >
                  {shortInstant(row.submittedAt, locale)}
                </td>
                <td className={`${CARD_TABLE.cell} max-lg:col-span-2 max-lg:pt-2 lg:text-end`}>
                  <LinkButton
                    variant="secondary"
                    className="max-lg:w-full"
                    href={revisionHref(row)}
                    aria-label={t('open-named', { name })}
                  >
                    {t('open')}
                  </LinkButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Nothing to show: the whole tab is empty, or the filters keep nothing. */
export function QueueEmpty({
  params,
  morePages,
}: {
  readonly params: QueueParams;
  readonly morePages: boolean;
}) {
  const t = useTranslations('catalog.queue');
  if (isFiltered(params)) {
    return (
      <EmptyState
        icon="inbox"
        title={t('empty.filtered')}
        action={
          <a className="font-medium text-link underline" href={clearedHref(params)}>
            {t('filter.clear')}
          </a>
        }
      />
    );
  }
  return (
    <EmptyState
      icon="inbox"
      title={t(
        morePages ? 'empty.page' : params.tab === 'offer' ? 'empty.offer' : 'empty.revision',
      )}
    />
  );
}
