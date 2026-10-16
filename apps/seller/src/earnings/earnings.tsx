'use client';

import {
  Banner,
  Button,
  EmptyState,
  LedgerTable,
  LedgerTotals,
  type BadgeTone,
  type LedgerRow,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import type { Ledger, LedgerEntry, LedgerKind } from './types.ts';

const PAGE = 20;
const TONE: Record<LedgerKind, BadgeTone> = {
  sale: 'success',
  shipping: 'info',
  commission: 'attention',
};
const shortId = (id: string): string => id.slice(-8).toUpperCase();

/** The seller's earnings: totals (sales, shipping, commission, balance) and the ledger. */
export function Earnings({ initial }: { readonly initial: Ledger }) {
  const t = useTranslations('earnings');
  const [entries, setEntries] = useState<readonly LedgerEntry[]>(initial.entries);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const { currency, totals } = initial;
  const money = (amount: string) => formatMinor(amount, currency);

  async function more() {
    if (cursor === null || loading) return;
    setLoading(true);
    setFailed(false);
    const result = await callApi<Ledger>(
      'GET',
      `commission-payouts/seller/ledger?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`,
    );
    setLoading(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setFailed(true);
      return;
    }
    const known = new Set(entries.map((entry) => entry.entryId));
    setEntries([...entries, ...result.body.entries.filter((e) => !known.has(e.entryId))]);
    setCursor(result.body.nextCursor);
  }

  const rows: LedgerRow[] = entries.map((entry) => ({
    id: entry.entryId,
    dateTime: entry.occurredAt,
    when: shortInstant(entry.occurredAt),
    order: shortId(entry.orderId),
    orderTitle: entry.orderId,
    kind: t(`kind.${entry.kind}`),
    kindTone: TONE[entry.kind],
    amount: `${entry.direction === 'debit' ? '−' : ''}${money(entry.amount)}`,
  }));

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-(--mp-size-form-max) text-fg-muted">{t('intro')}</p>
      <LedgerTotals
        items={[
          { id: 'sales', label: t('totals.sales'), value: money(totals.sales) },
          { id: 'shipping', label: t('totals.shipping'), value: money(totals.shipping) },
          { id: 'commission', label: t('totals.commission'), value: money(totals.commission) },
          {
            id: 'balance',
            label: t('totals.balance'),
            value: money(totals.balance),
            emphasis: true,
          },
        ]}
      />
      {/* An empty ledger is its own region: the empty state's heading stands for it. */}
      {rows.length === 0 ? null : <h2 className="text-lg font-semibold">{t('ledger')}</h2>}
      {rows.length === 0 ? (
        <EmptyState icon="receipt" title={t('empty-state.title')} body={t('empty-state.body')} />
      ) : (
        <LedgerTable
          rows={rows}
          labels={{
            caption: t('ledger'),
            when: t('col.when'),
            order: t('col.order'),
            kind: t('col.kind'),
            amount: t('col.amount'),
          }}
        />
      )}
      {failed ? <Banner tone="critical">{t('more-failed')}</Banner> : null}
      {cursor === null ? null : (
        <div>
          <Button variant="secondary" onClick={() => void more()} loading={loading}>
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  );
}
