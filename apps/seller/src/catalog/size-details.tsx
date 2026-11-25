'use client';

import { Tabs, tabIdOf } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { formatMinor, minorOf } from '../price/money.ts';
import { formatInZone, resolveZone } from '../price/zone-time.ts';
import type { SourceView } from '../stock/types.ts';
import { stockKey, type TableRow } from './variants-table-logic.ts';

export type SizeTab = 'price' | 'stock';

/** The tabs a size's Details shows: Price with the price columns, Stock with a stock location. */
export function sizeTabsOf(showPrice: boolean, sources: readonly SourceView[]): readonly SizeTab[] {
  return [
    ...(showPrice ? (['price'] as const) : []),
    ...(sources.length > 0 ? (['stock'] as const) : []),
  ];
}

/**
 * The Details of one size of an offer, opened in place under its row (Offer page PR 3, one row
 * at a time): a Price tab and a Stock tab. The numbers the seller types stay in the row; the tabs
 * explain them and show what a row cannot (the price in force, a held price, the special price,
 * the stock held for orders and the lowest stock the seller can set). A value typed in the row and
 * not saved yet is named here too, so closing the row loses nothing.
 */
export function SizeDetails({
  id,
  offerId,
  row,
  code,
  tabs,
  tab,
  onTab,
  currency,
  priceDraft,
  sources,
  stockDrafts,
}: {
  /** The panel's id: the row's Details button controls it. */
  readonly id: string;
  readonly offerId: string;
  readonly row: TableRow;
  /** The variant code under the size name, when the page read one. */
  readonly code: string | null;
  readonly tabs: readonly SizeTab[];
  readonly tab: SizeTab;
  readonly onTab: (tab: SizeTab) => void;
  readonly currency: string;
  /** The row's price as typed, when it differs from the saved one. */
  readonly priceDraft: string | null;
  readonly sources: readonly SourceView[];
  /** Stock typed in the row and not saved, by {@link stockKey}. */
  readonly stockDrafts: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('catalog.size-details');
  const locale = useLocale();
  const zone = resolveZone(useTimeZone());
  const panelId = `${id}-panel`;
  const money = (amount: string) => formatMinor(amount, currency, locale);
  const price = row.price;
  const draftMinor = priceDraft === null ? null : minorOf(priceDraft, currency);

  return (
    <div
      id={id}
      className="flex flex-col gap-3"
      aria-label={t('label', { size: row.label })}
      role="group"
    >
      <p className="font-medium">
        {code === null ? row.label : t('heading', { size: row.label, code })}
      </p>
      <Tabs
        label={t('tabs', { size: row.label })}
        items={tabs.map((item) => ({ id: item, label: t(`tab.${item}`) }))}
        activeId={tab}
        onSelect={(next) => onTab(next as SizeTab)}
        panelId={panelId}
      />
      <div id={panelId} role="tabpanel" aria-labelledby={tabIdOf(panelId, tab)} tabIndex={0}>
        {tab === 'price' ? (
          <dl className="flex max-w-xl flex-col">
            <Line label={t('price.now')}>
              {price?.inForce == null ? (
                <span className="text-fg-muted">{t('price.none')}</span>
              ) : (
                <>
                  <span className="font-medium">{money(price.inForce.amount)}</span>
                  <span className="block text-sm text-fg-muted">
                    {t('price.since', {
                      since: formatInZone(price.inForce.effectiveFrom, zone, locale),
                    })}
                  </span>
                </>
              )}
            </Line>
            {priceDraft === null ? null : (
              <Line label={t('price.unsaved')}>
                {draftMinor === null ? priceDraft : money(draftMinor)}
              </Line>
            )}
            {price?.held == null ? null : (
              <Line label={t('price.held')}>
                {money(price.held.amount)}
                <span className="block text-sm text-fg-muted">{t('price.held-help')}</span>
              </Line>
            )}
            <Line label={t('price.special')}>
              {price?.special == null ? (
                <span className="text-fg-muted">{t('price.special-none')}</span>
              ) : (
                t(`price.special-${price.special.state}`, {
                  amount: money(price.special.amount),
                  ends: formatInZone(price.special.endsAt, zone, locale),
                })
              )}
            </Line>
            {price?.retired === true ? (
              <p className="py-2 text-sm text-fg-muted">{t('price.retired')}</p>
            ) : null}
            <p className="pt-3 text-sm">
              <a className="font-medium text-link underline" href={`/offers/${offerId}/prices`}>
                {t('price.special-link')}
              </a>
            </p>
          </dl>
        ) : (
          <div className="flex max-w-xl flex-col gap-3">
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <caption className="sr-only">{t('stock.caption', { size: row.label })}</caption>
                <thead>
                  <tr className="text-fg-muted">
                    <th scope="col" className="py-2 pe-3 text-start font-medium">
                      {t('stock.location')}
                    </th>
                    <th scope="col" className="py-2 pe-3 text-end font-medium">
                      {t('stock.in-stock')}
                    </th>
                    <th scope="col" className="py-2 pe-3 text-end font-medium">
                      {t('stock.held')}
                    </th>
                    <th scope="col" className="py-2 text-end font-medium">
                      {t('stock.lowest')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => {
                    const cell = row.stock[source.id];
                    const draft = stockDrafts[stockKey(row.variantId, source.id)];
                    const changed =
                      draft !== undefined && draft.trim() !== String(cell?.onHand ?? '');
                    return (
                      <tr key={source.id} className="border-t border-line">
                        <th scope="row" className="py-2 pe-3 text-start font-normal break-words">
                          {source.name}
                        </th>
                        <td className="py-2 pe-3 text-end tabular-nums">
                          {cell === undefined ? (
                            <span className="text-fg-muted">{'—'}</span>
                          ) : (
                            cell.onHand
                          )}
                          {changed ? (
                            <span className="block text-xs text-attention-fg">
                              {t('stock.unsaved', {
                                value: draft.trim() === '' ? '—' : draft.trim(),
                              })}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pe-3 text-end tabular-nums">{cell?.held ?? 0}</td>
                        <td className="py-2 text-end tabular-nums">{cell?.held ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-fg-muted">{t('stock.help')}</p>
            <p className="text-sm">
              <a className="font-medium text-link underline" href={`/offers/${offerId}/stock`}>
                {t('stock.link')}
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** One label and value line of the Price tab. */
function Line({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-2">
      <dt>{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}
