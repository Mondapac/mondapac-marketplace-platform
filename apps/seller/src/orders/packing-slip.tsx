'use client';

import { BackLink, Button } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useId } from 'react';
import { shortInstant } from '../catalog/format.ts';
import { shortId } from './status.ts';
import { packingSlipAvailable, remainingUnits, type SellerOrderView } from './types.ts';

/** The slip itself: reference, where it goes, what to pack. No controls, so many can share a page. */
function SlipSheet({
  order,
  heading = 'h1',
}: {
  readonly order: SellerOrderView;
  /** The title's level: one slip is the page (h1), many are sections of it (h2). */
  readonly heading?: 'h1' | 'h2';
}) {
  const uid = useId();
  const Title = heading;
  const t = useTranslations('orders.slip');
  const to = useTranslations('orders');
  const locale = useLocale();
  const zone = useTimeZone();
  const rows = order.lines
    .map((line) => ({ line, quantity: remainingUnits(order, line.lineId) }))
    .filter((row) => row.quantity > 0);
  const shipTo = order.shipTo ?? null;
  const note = order.buyerNote?.trim() ?? '';
  return (
    <>
      <header className="flex flex-col gap-1 border-b border-line pb-4">
        <Title className="text-2xl font-semibold">{t('title')}</Title>
        <p className="text-lg">{to('detail-title', { id: shortId(order.sellerOrderId) })}</p>
        <p className="text-sm text-fg-muted">
          {t('paid', { when: shortInstant(order.paidAt, locale, zone) })}
          {' · '}
          {to(`method.${order.deliveryMethod}`)}
        </p>
      </header>
      <section aria-labelledby={`${uid}-slip-ship-to`} className="flex flex-col gap-1">
        <h2 id={`${uid}-slip-ship-to`} className="text-base font-semibold">
          {t('ship-to')}
        </h2>
        {shipTo === null ? (
          <p className="text-fg-muted">{t('no-address')}</p>
        ) : (
          <address className="not-italic">
            <div>
              {shipTo.recipientFirstName} {shipTo.recipientLastName}
            </div>
            <div>{shipTo.line1}</div>
            {shipTo.line2 === null || shipTo.line2 === '' ? null : <div>{shipTo.line2}</div>}
            <div>
              {[shipTo.suburb, shipTo.region, shipTo.postcode]
                .filter((part) => part !== null && part !== '')
                .join(' ')}
            </div>
            <div>{t('phone', { phone: shipTo.phone })}</div>
          </address>
        )}
      </section>
      <section aria-labelledby={`${uid}-slip-items`} className="flex flex-col gap-2">
        <h2 id={`${uid}-slip-items`} className="text-base font-semibold">
          {t('items')}
        </h2>
        {rows.length === 0 ? (
          <p className="text-fg-muted">{t('no-items')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-start">
              <caption className="sr-only">{t('items')}</caption>
              <thead>
                <tr className="border-b border-line text-sm">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {to('line.col.item')}
                  </th>
                  <th scope="col" className="py-2 text-end font-medium">
                    {to('line.col.quantity')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ line, quantity }) => {
                  const name = line.productName?.trim() ?? '';
                  const variant = line.variantLabel?.trim() ?? '';
                  return (
                    <tr key={line.lineId} className="border-b border-line-row">
                      <td className="py-2 pe-3 break-words">
                        {name === '' ? to('line.fallback', { id: shortId(line.offerId) }) : name}
                        {variant !== '' ? ` · ${variant}` : ''}
                      </td>
                      <td className="py-2 text-end font-medium tabular-nums">{quantity}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {note === '' ? null : (
        <section aria-labelledby={`${uid}-slip-note`} className="flex flex-col gap-1">
          <h2 id={`${uid}-slip-note`} className="text-base font-semibold">
            {t('buyer-note')}
          </h2>
          <p className="break-words whitespace-pre-wrap">{note}</p>
        </section>
      )}
    </>
  );
}

/**
 * A printable packing slip of one paid order: the order reference, the units still to send and
 * where they go, as the seller detail already allows. No prices, no payment data. The screen
 * shows a Print button; the printed page shows the slip only.
 */
export function PackingSlip({ order }: { readonly order: SellerOrderView }) {
  const t = useTranslations('orders.slip');
  if (!packingSlipAvailable(order)) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 bg-surface p-6 text-fg">
        <BackLink href={`/orders/${order.sellerOrderId}`} label={t('back')} />
        <p className="text-fg-muted">{t('not-available')}</p>
      </main>
    );
  }
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 bg-surface p-6 text-fg print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <BackLink href={`/orders/${order.sellerOrderId}`} label={t('back')} />
        <Button onClick={() => window.print()}>{t('print')}</Button>
      </div>
      <SlipSheet order={order} />
    </main>
  );
}

/**
 * The packing slips of the selected orders on one printable page, one slip per sheet. Orders with
 * no slip (sent, refunded in full, not the shop's, or that could not be read) are named in a note
 * above, which does not print.
 */
export function PackingSlips({
  orders,
  skipped,
}: {
  readonly orders: readonly SellerOrderView[];
  /** How many of the selected orders have no slip. */
  readonly skipped: number;
}) {
  const t = useTranslations('orders.slip');
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 bg-surface p-6 text-fg print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <BackLink href="/orders" label={t('back-to-list')} />
        {orders.length === 0 ? null : <Button onClick={() => window.print()}>{t('print')}</Button>}
      </div>
      <div className="flex flex-col gap-1 print:hidden">
        <h1 className="text-2xl font-semibold">{t('many-title')}</h1>
        <p className="text-fg-muted">{t('many-count', { count: orders.length })}</p>
        {skipped === 0 ? null : (
          <p className="text-fg-muted">{t('many-skipped', { count: skipped })}</p>
        )}
      </div>
      {orders.map((order) => (
        <article
          key={order.sellerOrderId}
          className="flex flex-col gap-6 border-t border-line pt-6 first:border-t-0 print:break-after-page print:border-0 print:pt-0 print:last:break-after-auto"
        >
          <SlipSheet order={order} heading="h2" />
        </article>
      ))}
    </main>
  );
}
