'use client';

import { Badge, CARD_TABLE, Icon, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { dayInZone } from '../shared/format.ts';
import { numberFormat } from '../shared/intl.ts';
import type { OptionalColumn, ProductRow, Status } from './products-types.ts';

const TONE: Record<Status, BadgeTone> = {
  published: 'success',
  unpublished: 'neutral',
  withdrawn: 'neutral',
  retired: 'neutral',
  matched: 'info',
};

/** The primary photo, or a package tile when there is none or it cannot be shown. */
function Thumb({ row }: { readonly row: ProductRow }) {
  const [failed, setFailed] = useState(false);
  if (row.primaryImageId === null || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-icon"
      >
        <Icon name="package" />
      </span>
    );
  }
  return (
    // The relay serves the photo from the same origin, with the admin session.
    <img
      src={`/api/catalog/admin/products/${row.productId}/images/${row.primaryImageId}/thumb`}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      onError={() => setFailed(true)}
      className="size-10 shrink-0 rounded-md bg-muted object-cover"
    />
  );
}

/**
 * The rows of one page: image and title (with the code under it), status, main category, then the
 * optional columns the admin chose. From 1024 px a table; below it each row is a card with
 * labelled lines (CARD_TABLE). A text column starts where its header starts; the Offers count is
 * a number, so its header and cells end together.
 */
export function ProductsTable({
  rows,
  columns,
  timeZone,
  empty,
}: {
  readonly rows: readonly ProductRow[];
  readonly columns: readonly OptionalColumn[];
  readonly timeZone: string;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
}) {
  const t = useTranslations('catalog.products');
  const locale = useLocale();
  const { cell, corner, labelled } = CARD_TABLE;
  const count = 3 + columns.length;
  const numeric = (column: OptionalColumn) => column === 'offers';

  const content = (column: OptionalColumn, row: ProductRow): ReactNode => {
    switch (column) {
      case 'code':
        return <span className="break-all">{row.productCode}</span>;
      case 'offers':
        return numberFormat(locale, {}).format(row.offerCount);
      case 'updated':
        return (
          <span className="whitespace-nowrap">{dayInZone(row.updatedAt, locale, timeZone)}</span>
        );
      case 'created':
        return (
          <span className="whitespace-nowrap">{dayInZone(row.createdAt, locale, timeZone)}</span>
        );
      case 'type':
        return <span className="break-words">{row.typeCode}</span>;
      case 'scope':
        return t(`scope.${row.scope}`);
      case 'seller':
        return row.scope === 'PLATFORM' ? (
          <span className="text-fg-muted">{t('seller-platform')}</span>
        ) : (
          <span className="break-words">{row.ownerStoreName ?? t('seller-unknown')}</span>
        );
    }
  };

  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table
        className={`${CARD_TABLE.table} ${columns.length > 4 ? 'lg:min-w-360' : columns.length > 2 ? 'lg:min-w-300' : columns.length > 0 ? 'lg:min-w-240' : 'lg:min-w-160'}`}
      >
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium lg:min-w-72">
              {t('col.product')}
            </th>
            <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
              {t('col.category')}
            </th>
            <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
              {t('col.status')}
            </th>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className={`whitespace-nowrap px-4 py-3 font-medium ${numeric(column) ? 'text-end' : ''}`}
              >
                {t(`col.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.length === 0 && empty !== undefined ? (
            <tr className="max-lg:block">
              <td colSpan={count} className="max-lg:block">
                {empty}
              </td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <tr key={row.productId} className={CARD_TABLE.row}>
              <td className={`${cell} lg:min-w-72`}>
                <div className="flex min-w-0 items-center gap-3">
                  <Thumb row={row} />
                  <div className="min-w-0">
                    <div className="break-words font-medium text-fg">
                      {row.name ?? <span className="text-fg-muted">{t('unnamed')}</span>}
                    </div>
                    <div className="break-words text-xs text-fg-muted">{row.productCode}</div>
                  </div>
                </div>
              </td>
              <td
                className={`${labelled} lg:min-w-(--mp-size-data-label)`}
                data-label={t('col.category')}
              >
                {row.categoryName ?? <span className="text-fg-muted">{t('no-category')}</span>}
              </td>
              {/* On a phone the status sits beside the title, where the eye starts. */}
              <td className={corner}>
                <Badge tone={TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
              </td>
              {columns.map((column) => (
                <td
                  key={column}
                  className={`${labelled} ${numeric(column) ? 'lg:text-end lg:tabular-nums' : ''}`}
                  data-label={t(`col.${column}`)}
                >
                  {content(column, row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
