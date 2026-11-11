import { BackLink } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../pricing/format.ts';
import { formatInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import { PrintButton } from './print-button.tsx';
import type { Money, SellerPart } from './types.ts';

/** The order document of the API (presentation/documents.dto.ts OrderDocumentBody). */
export interface OrderDocument {
  readonly kind: string;
  readonly documentNumber: string | null;
  readonly orderId: string;
  readonly paidAt: string;
  readonly parts: readonly {
    readonly sellerId: string;
    readonly lines: readonly {
      readonly lineId: string;
      readonly variantId: string;
      readonly quantity: number;
      readonly unitPrice: Money;
      readonly lineAmount: Money;
      readonly taxInclusive: boolean;
      readonly tax: Money | null;
    }[];
    readonly subtotal: Money;
    readonly shipping: Money;
    readonly tax: Money | null;
    readonly total: Money;
  }[];
  readonly total: Money;
  readonly tax: Money | null;
}

/**
 * The order confirmation of a paid order, laid out to print (order detail, Documents). Built only
 * from the values frozen at placement; product and store names come from the order itself. It is
 * not a tax invoice: numbering is not built (AG-11).
 */
export function OrderDocumentView({
  document,
  parts,
}: {
  readonly document: OrderDocument;
  /** The order's seller parts, for store and product names. */
  readonly parts: readonly SellerPart[];
}) {
  const t = useTranslations('orders.document');
  const to = useTranslations('orders');
  const locale = useLocale();
  return (
    <article className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <BackLink href={`/orders/${document.orderId}`} label={t('back')} />
        <PrintButton label={t('print')} />
      </div>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p>{to('reference', { id: shortId(document.orderId) })}</p>
        <p className="text-sm text-fg-muted break-all">{document.orderId}</p>
        <p className="text-sm text-fg-muted">
          {t('paid', { at: formatInstant(document.paidAt, locale) })}
        </p>
        <p className="text-sm text-fg-muted">{t('not-invoice')}</p>
      </header>
      {document.parts.map((section) => {
        const part = parts.find((each) => each.sellerId === section.sellerId);
        const names = new Map(part?.lines.map((line) => [line.lineId, line.productName]) ?? []);
        return (
          <section
            key={section.sellerId}
            className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
          >
            <h2 className="font-semibold">
              {part?.storeName?.trim() || to('detail.seller', { id: shortId(section.sellerId) })}
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-fg-muted">
                  <th className="py-1 text-start font-medium">{t('item')}</th>
                  <th className="py-1 text-end font-medium">{t('quantity')}</th>
                  <th className="py-1 text-end font-medium">{t('unit-price')}</th>
                  <th className="py-1 text-end font-medium">{t('amount')}</th>
                </tr>
              </thead>
              <tbody>
                {section.lines.map((line) => (
                  <tr key={line.lineId} className="border-t border-line-row">
                    <td className="py-1 break-words">
                      {names.get(line.lineId)?.trim() ||
                        to('line.variant', { id: shortId(line.variantId) })}
                    </td>
                    <td className="py-1 text-end tabular-nums">{line.quantity}</td>
                    <td className="py-1 text-end tabular-nums">
                      {formatMoney(line.unitPrice, locale)}
                    </td>
                    <td className="py-1 text-end tabular-nums">
                      {formatMoney(line.lineAmount, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-line pt-2 text-sm">
              <dt className="text-fg-muted">{to('field.subtotal')}</dt>
              <dd className="text-end tabular-nums">{formatMoney(section.subtotal, locale)}</dd>
              <dt className="text-fg-muted">{to('field.shipping')}</dt>
              <dd className="text-end tabular-nums">{formatMoney(section.shipping, locale)}</dd>
              <dt className="text-fg-muted">{to('field.tax')}</dt>
              <dd className="text-end tabular-nums">
                {section.tax === null ? to('tax.not-recorded') : formatMoney(section.tax, locale)}
              </dd>
              <dt className="font-semibold">{to('field.part-total')}</dt>
              <dd className="text-end font-semibold tabular-nums">
                {formatMoney(section.total, locale)}
              </dd>
            </dl>
          </section>
        );
      })}
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-line pt-3">
        <dt className="text-fg-muted">{to('field.tax')}</dt>
        <dd className="text-end tabular-nums">
          {document.tax === null ? to('tax.not-recorded') : formatMoney(document.tax, locale)}
        </dd>
        <dt className="font-semibold">{to('field.total')}</dt>
        <dd className="text-end font-semibold tabular-nums">
          {formatMoney(document.total, locale)}
        </dd>
      </dl>
    </article>
  );
}
