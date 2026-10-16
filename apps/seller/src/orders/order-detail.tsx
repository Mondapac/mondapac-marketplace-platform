'use client';

import {
  BackLink,
  Badge,
  Banner,
  Button,
  Card,
  CARD_TABLE,
  DataList,
  TextField,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import { orderProblemOf } from './errors.ts';
import { shortId, TONE } from './status.ts';
import type { LineLabels, SellerOrderView } from './types.ts';

/**
 * One paid order on its own page: summary, its lines with product names, the totals and the
 * fulfilment: the shipment form, the shipment details once shipped and "Mark as delivered".
 */
export function OrderDetail({
  initial,
  labels,
  csrfToken,
  canShip,
  canDeliver,
}: {
  readonly initial: SellerOrderView;
  readonly labels: LineLabels;
  readonly csrfToken: string;
  readonly canShip: boolean;
  readonly canDeliver: boolean;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const [order, setOrder] = useState(initial);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const busy = useRef(false);
  const money = (amount: { amount: string; currency: string }) =>
    formatMinor(amount.amount, amount.currency, locale);

  /** One step at a time; the answer is the new state of this order. */
  async function step(action: 'ship' | 'deliver', body: unknown) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setFieldError({});
    const result = await callApi<SellerOrderView>(
      'POST',
      `ordering/seller/orders/${order.sellerOrderId}/${action}`,
      body,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setOrder(result.body);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const fields: Record<string, string> = {};
    for (const entry of result.failure.details?.fields ?? []) fields[entry.path] = 'invalid';
    setFieldError(fields);
    setProblem(orderProblemOf(result.failure));
  }

  function ship(event: FormEvent) {
    event.preventDefault();
    const name = carrier.trim();
    if (name === '') {
      setFieldError({ carrier: 'required' });
      return;
    }
    const ref = tracking.trim();
    void step('ship', ref === '' ? { carrier: name } : { carrier: name, trackingRef: ref });
  }

  const reference = shortId(order.sellerOrderId);
  const count = order.lines.reduce((sum, line) => sum + line.quantity, 0);
  const lineHead = (col: 'item' | 'quantity' | 'unit' | 'amount') => t(`line.col.${col}`);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-2">
        <BackLink href="/orders" label={t('back')} />
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold">
            {t('detail-title', { id: reference })}
          </h1>
          <Badge tone={TONE[order.fulfilment]}>{t(`status.${order.fulfilment}`)}</Badge>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title={t('summary')}>
            <DataList
              missing={t('not-given')}
              rows={[
                { label: t('paid-on'), value: formatInstant(order.paidAt, locale) },
                { label: t('col.items'), value: String(count) },
              ]}
            />
          </Card>
          <Card title={t('lines')}>
            <div className="relative -mx-5 -mb-5 overflow-x-auto border-t border-line">
              <table className={`${CARD_TABLE.table} lg:table-fixed`}>
                <caption className="sr-only">{t('lines')}</caption>
                <colgroup className="max-lg:hidden">
                  <col />
                  <col className="w-20" />
                  <col className="w-28" />
                  <col className="w-28" />
                </colgroup>
                <thead className={CARD_TABLE.head}>
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium">
                      {lineHead('item')}
                    </th>
                    <th scope="col" className="px-4 py-3 text-end font-medium">
                      {lineHead('quantity')}
                    </th>
                    <th scope="col" className="px-4 py-3 text-end font-medium">
                      {lineHead('unit')}
                    </th>
                    <th scope="col" className="px-5 py-3 text-end font-medium">
                      {lineHead('amount')}
                    </th>
                  </tr>
                </thead>
                <tbody className={CARD_TABLE.body}>
                  {order.lines.map((line) => {
                    const label = labels[line.lineId];
                    return (
                      <tr key={line.lineId} className={CARD_TABLE.row}>
                        <td className={`${CARD_TABLE.cell} break-words lg:px-5 max-lg:col-span-2`}>
                          <div className="font-medium text-fg">
                            {label?.name ?? t('line.fallback', { id: shortId(line.offerId) })}
                          </div>
                          {label?.variant == null ? null : (
                            <div className="text-fg-muted">{label.variant}</div>
                          )}
                        </td>
                        <td
                          className={`${CARD_TABLE.labelled} tabular-nums lg:text-end`}
                          data-label={lineHead('quantity')}
                        >
                          {line.quantity}
                        </td>
                        <td
                          className={`${CARD_TABLE.labelled} tabular-nums lg:text-end`}
                          data-label={lineHead('unit')}
                        >
                          {money(line.unitPrice)}
                        </td>
                        <td
                          className={`${CARD_TABLE.labelled} font-medium tabular-nums lg:px-5 lg:text-end`}
                          data-label={lineHead('amount')}
                        >
                          {money(line.lineAmount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Card title={t('totals')}>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
              <dt className="text-fg-muted">{t('subtotal')}</dt>
              <dd className="text-end tabular-nums">{money(order.subtotal)}</dd>
              <dt className="text-fg-muted">{t('delivery')}</dt>
              <dd className="text-end tabular-nums">
                {order.shipping.amount === '0' ? t('delivery-free') : money(order.shipping)}
              </dd>
            </dl>
            <p className="-mt-1 flex justify-between gap-3 border-t border-line pt-3 font-semibold">
              <span>{t('total')}</span>
              <span className="tabular-nums">{money(order.total)}</span>
            </p>
          </Card>
          <Card title={t('fulfilment')}>
            {order.fulfilment === 'to-ship' ? (
              canShip ? (
                <form className="flex flex-col gap-4" onSubmit={ship} noValidate>
                  <h3 className="text-sm font-semibold">{t('ship.title')}</h3>
                  {problem === null ? null : (
                    <Banner tone="critical">{t(`error.${problem}`)}</Banner>
                  )}
                  <TextField
                    name="carrier"
                    label={t('ship.carrier')}
                    value={carrier}
                    maxLength={60}
                    error={
                      fieldError.carrier === undefined
                        ? undefined
                        : t(`validation.${fieldError.carrier}`)
                    }
                    onChange={(event) => setCarrier(event.target.value)}
                  />
                  <TextField
                    name="trackingRef"
                    label={t('ship.tracking')}
                    optionalLabel={t('optional')}
                    value={tracking}
                    maxLength={80}
                    error={
                      fieldError.trackingRef === undefined
                        ? undefined
                        : t(`validation.${fieldError.trackingRef}`)
                    }
                    onChange={(event) => setTracking(event.target.value)}
                  />
                  <p className="text-sm text-balance text-fg-muted">{t('ship.hint')}</p>
                  <div>
                    <Button type="submit" loading={pending}>
                      {t('ship.submit')}
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="text-sm text-fg-muted">{t('not-shipped')}</p>
              )
            ) : (
              <>
                <DataList
                  missing={t('not-given')}
                  rows={[
                    { label: t('ship.carrier'), value: order.carrier },
                    { label: t('ship.tracking'), value: order.trackingRef },
                    {
                      label: t('shipped-on'),
                      value:
                        order.shippedAt === null ? null : formatInstant(order.shippedAt, locale),
                    },
                    ...(order.deliveredAt === null
                      ? []
                      : [
                          {
                            label: t('delivered-on'),
                            value: formatInstant(order.deliveredAt, locale),
                          },
                        ]),
                  ]}
                />
                {order.fulfilment === 'shipped' && canDeliver ? (
                  <>
                    {problem === null ? null : (
                      <Banner tone="critical">{t(`error.${problem}`)}</Banner>
                    )}
                    <div>
                      <Button
                        variant="secondary"
                        loading={pending}
                        onClick={() => void step('deliver', {})}
                      >
                        {t('deliver')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
