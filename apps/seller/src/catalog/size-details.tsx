'use client';

import { Tabs, tabIdOf } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { formatMinor, minorOf } from '../price/money.ts';
import { formatInZone, resolveZone } from '../price/zone-time.ts';
import type { ReceiveEstimate } from '../price/receive-estimates.ts';
import type { SourceView } from '../stock/types.ts';
import { stockKey, type TableRow } from './variants-table-logic.ts';

export type SizeTab = 'price' | 'stock' | 'cost';

/**
 * The tabs a size's Details shows: Price with the price columns, Stock with a stock location, and
 * Cost (Offer page PR 7-UI) for a seller with `pricing.cost.view`, beside the prices.
 */
export function sizeTabsOf(
  showPrice: boolean,
  sources: readonly SourceView[],
  showCost = false,
): readonly SizeTab[] {
  return [
    ...(showPrice ? (['price'] as const) : []),
    ...(sources.length > 0 ? (['stock'] as const) : []),
    ...(showPrice && showCost ? (['cost'] as const) : []),
  ];
}

/**
 * The Details of one size of an offer, opened in place under its row (Offer page PR 3, one row
 * at a time): a Price tab and a Stock tab. The numbers the seller types stay in the row; the tabs
 * explain them and show what a row cannot (the price in force, a held price, the special price,
 * the stock held for orders and the lowest stock the seller can set). A value typed in the row and
 * not saved yet is named here too, so closing the row loses nothing. The Price tab opens with what
 * the seller receives for one unit (Offer page PR 4): what the customer pays now, the platform
 * commission and "You receive (est.)", worked out by the API as the ledger will. The special price
 * is set and ended in the Price tab too (Offer page PR 6): the table hands it in as `special`. A
 * seller with `pricing.cost.view` also gets a private Cost tab (Offer page PR 7-UI), handed in as `cost`.
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
  receive = null,
  special = null,
  cost = null,
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
  /** "What you receive"; null when the seller may not see it (no price or ledger key). */
  readonly receive?: ReceiveView | null;
  /** The size's special price and its fields (Offer page PR 6), under the price lines. */
  readonly special?: React.ReactNode;
  /** The size's private Cost and Estimated profit (Offer page PR 7-UI), in the Cost tab. */
  readonly cost?: React.ReactNode;
}) {
  const t = useTranslations('catalog.size-details');
  const locale = useLocale();
  const zone = resolveZone(useTimeZone());
  const panelId = `${id}-panel`;
  const money = (amount: string) => formatMinor(amount, currency, locale);
  const price = row.price;
  const draftMinor = priceDraft === null ? null : minorOf(priceDraft, currency);

  return (
    <div id={id} className="flex flex-col gap-3" aria-labelledby={`${id}-heading`} role="group">
      <h3 id={`${id}-heading`} className="font-medium">
        {code === null ? row.label : t('heading', { size: row.label, code })}
      </h3>
      <Tabs
        label={t('tabs', { size: row.label })}
        items={tabs.map((item) => ({
          id: item,
          label: t(`tab.${item}`),
          ...(item === 'cost' ? { icon: 'lock' as const } : {}),
        }))}
        activeId={tab}
        onSelect={(next) => onTab(next as SizeTab)}
        panelId={panelId}
      />
      <div id={panelId} role="tabpanel" aria-labelledby={tabIdOf(panelId, tab)} tabIndex={0}>
        {tab === 'price' && receive !== null ? (
          <ReceiveBreakdown id={`${id}-receive`} view={receive} money={money} />
        ) : null}
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
            {priceDraft === null || receive?.source === 'typed' ? null : (
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
          </dl>
        ) : null}
        {tab === 'price' && price?.retired === true ? (
          <p className="max-w-xl py-2 text-sm text-fg-muted">{t('price.retired')}</p>
        ) : null}
        {tab === 'price' ? (
          special
        ) : tab === 'cost' ? (
          cost
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
                        <td className="py-2 text-end tabular-nums">
                          {cell?.held ?? 0}
                          <span className="block text-xs text-fg-muted">{t('stock.held')}</span>
                        </td>
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

/** What the Price tab shows of "You receive (est.)" for the size. */
export interface ReceiveView {
  /** The estimate for the price customers pay now; null while it is read or when there is none. */
  readonly estimate: ReceiveEstimate | null;
  /**
   * Where the customer price comes from: a running special, a typed price or the saved one;
   * `unfinished` while the typed text is not an amount yet, `none` without any price.
   */
  readonly source: 'special' | 'typed' | 'saved' | 'unfinished' | 'none';
  /** The day a running special ends, shown under its price ("Special · ends 30 Nov"). */
  readonly specialEnds?: string | null;
  /** `unavailable`: the read failed; `no-category`: the product is not published yet. */
  readonly state: 'ready' | 'unavailable' | 'no-category';
}

/**
 * Customer pays, the platform commission and "You receive (est.)" of one unit, in three lines, and
 * the note that the commission is the most it can be. No rate and no platform name are shown.
 */
function ReceiveBreakdown({
  id,
  view,
  money,
}: {
  readonly id: string;
  readonly view: ReceiveView;
  readonly money: (amount: string) => string;
}) {
  const t = useTranslations('catalog.size-details.receive');
  const { estimate } = view;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mb-4 flex max-w-xl flex-col border-b border-line pb-4"
    >
      <h4 id={`${id}-title`} className="font-semibold">
        {t('title')}
      </h4>
      {view.source === 'none' || view.source === 'unfinished' ? (
        <p className="py-2 text-sm text-fg-muted">{t(view.source)}</p>
      ) : view.state !== 'ready' ? (
        <p className="py-2 text-sm text-fg-muted">{t(view.state)}</p>
      ) : estimate === null ? (
        <p className="py-2 text-sm text-fg-muted" role="status">
          {t('pending')}
        </p>
      ) : (
        <>
          <dl className="flex flex-col">
            <Line label={t('customer-pays')}>
              <span className="tabular-nums">{money(estimate.customerPaysMinor)}</span>
              {view.source === 'saved' ? null : (
                <span className="block text-sm text-fg-muted">
                  {view.source === 'special'
                    ? t('special', { ends: view.specialEnds ?? '-' })
                    : t('typed')}
                </span>
              )}
            </Line>
            <Line label={t('commission')}>
              <span className="tabular-nums">
                {t('commission-value', { amount: money(estimate.commissionMinor) })}
              </span>
            </Line>
            <Line label={<span className="font-semibold">{t('you-receive')}</span>}>
              <span className="font-semibold tabular-nums">
                {t('you-receive-value', { amount: money(estimate.youReceiveMinor) })}
              </span>
            </Line>
          </dl>
          <p className="pt-2 text-sm text-fg-muted">
            {t(estimate.taxInclusive ? 'note' : 'note-before-tax')}
          </p>
        </>
      )}
    </section>
  );
}

/** One label and value line of the Price tab. */
function Line({
  label,
  children,
}: {
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-line py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <dt className="shrink-0">{label}</dt>
      <dd className="sm:text-end">{children}</dd>
    </div>
  );
}
