'use client';

import {
  EmptyState,
  Banner,
  Button,
  Card,
  LedgerTable,
  LedgerTotals,
  type BadgeTone,
  type LedgerRow,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortId } from '../shared/short-id.ts';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatMinor } from '../shipping/money.ts';
import { shortInstant } from '../shared/format.ts';
import type { Ledger, LedgerEntry, LedgerKind } from './types.ts';

const PAGE = 20;
const TONE: Record<LedgerKind, BadgeTone> = {
  sale: 'success',
  shipping: 'info',
  commission: 'attention',
};

/** A seller's ledger for admins: totals, the rows newest first and "Load more". */
export function LedgerCard({ initial }: { readonly initial: Ledger }) {
  const t = useTranslations('commission.ledger');
  const locale = useLocale();
  const [entries, setEntries] = useState<readonly LedgerEntry[]>(initial.entries);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const { currency, totals } = initial;
  const money = (amount: string) => formatMinor(amount, currency, locale);

  async function more() {
    if (cursor === null || loading) return;
    setLoading(true);
    setFailed(false);
    const result = await callApi<Ledger>(
      'GET',
      `commission-payouts/admin/sellers/${initial.sellerId}/ledger?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`,
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
    when: shortInstant(entry.occurredAt, locale),
    order: shortId(entry.orderId),
    orderTitle: entry.orderId,
    kind: t(`kind.${entry.kind}`),
    kindTone: TONE[entry.kind],
    amount: `${entry.direction === 'debit' ? '−' : ''}${money(entry.amount)}`,
  }));

  return (
    <Card title={t('title')}>
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
      {rows.length === 0 ? (
        <EmptyState size="compact" icon="receipt" title={t('empty')} />
      ) : (
        <LedgerTable
          rows={rows}
          labels={{
            caption: t('title'),
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
    </Card>
  );
}
