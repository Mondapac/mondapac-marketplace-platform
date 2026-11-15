'use client';

import { BackLink, Button } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { shortInstant } from '../catalog/format.ts';
import { shortId } from './status.ts';
import { packingSlipAvailable, remainingUnits, type SellerOrderView } from './types.ts';

/**
 * A printable packing slip of one paid order: the order reference, the units still to send and
 * where they go, as the seller detail already allows. No prices, no payment data. The screen
 * shows a Print button; the printed page shows the slip only.
 */
export function PackingSlip({ order }: { readonly order: SellerOrderView }) {
  const t = useTranslations('orders.slip');
  const to = useTranslations('orders');
  const locale = useLocale();
  const zone = useTimeZone();
  if (!packingSlipAvailable(order)) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 bg-surface p-6 text-fg">
        <BackLink href={`/orders/${order.sellerOrderId}`} label={t('back')} />
        <p className="text-fg-muted">{t('not-available')}</p>
      </main>
    );
  }
  const rows = order.lines
    .map((line) => ({ line, quantity: remainingUnits(order, line.lineId) }))
    .filter((row) => row.quantity > 0);
  const shipTo = order.shipTo ?? null;
  const note = order.buyerNote?.trim() ?? '';
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 bg-surface p-6 text-fg print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <BackLink href={`/orders/${order.sellerOrderId}`} label={t('back')} />
        <Button onClick={() => window.print()}>{t('print')}</Button>
      </div>
      <header className="flex flex-col gap-1 border-b border-line pb-4">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-lg">{to('detail-title', { id: shortId(order.sellerOrderId) })}</p>
        <p className="text-sm text-fg-muted">
          {t('paid', { when: shortInstant(order.paidAt, locale, zone) })}
          {' · '}
          {to(`method.${order.deliveryMethod}`)}
        </p>
      </header>
      <section aria-labelledby="slip-ship-to" className="flex flex-col gap-1">
        <h2 id="slip-ship-to" className="text-base font-semibold">
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
      <section aria-labelledby="slip-items" className="flex flex-col gap-2">
        <h2 id="slip-items" className="text-base font-semibold">
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
        <section aria-labelledby="slip-note" className="flex flex-col gap-1">
          <h2 id="slip-note" className="text-base font-semibold">
            {t('buyer-note')}
          </h2>
          <p className="break-words whitespace-pre-wrap">{note}</p>
        </section>
      )}
    </main>
  );
}
