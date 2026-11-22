'use client';

import { Card, EmptyState, LoadError, Spinner } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatMinor } from '../price/money.ts';

const PATH = 'commission-payouts/seller/exclusive-commission';

export interface Saved {
  /** Signed minor units; negative when refunds gave back more than the month saved. */
  readonly amount: string;
  readonly currency: string;
}

export interface ExclusiveCommission {
  readonly rule: {
    readonly standardRateBps: number;
    readonly exclusiveRateBps: number;
    readonly months: number;
  } | null;
  readonly zone: string;
  readonly months: readonly { readonly month: string; readonly saved: readonly Saved[] }[];
  readonly thisMonth: readonly Saved[];
}

/** The months, one row list per currency (a month with no amount in a currency is a zero row). */
export function byCurrency(months: ExclusiveCommission['months']): readonly {
  readonly currency: string;
  readonly rows: readonly { month: string; amount: string }[];
}[] {
  const currencies = [...new Set(months.flatMap((m) => m.saved.map((s) => s.currency)))].sort();
  return currencies.map((currency) => ({
    currency,
    rows: months.map((m) => ({
      month: m.month,
      amount: m.saved.find((s) => s.currency === currency)?.amount ?? '0',
    })),
  }));
}

/** A percent from basis points: 1250 is "12.5". */
export function percentOf(bps: number): string {
  return String(bps / 100);
}

/** The month name of a `YYYY-MM` the API already cut in its zone (no zone shift is applied). */
export function monthLabel(month: string, locale: string): string {
  const [year, number] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year ?? 1970, (number ?? 1) - 1, 1)));
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly body: ExclusiveCommission }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'failed'; readonly key: string; readonly minutes: number };

/**
 * Settings, Exclusive perks: the lower commission on the shop's exclusive customers (read only) and
 * what it saved, this month and in the last 12 months, per currency. A negative month is money
 * given back after refunds and is written so. When the Market has no such rule (`rule` null) the
 * card is not drawn: there is nothing to explain. A 403 hides it alone.
 */
export function CommissionCard({ onHidden }: { readonly onHidden: () => void }) {
  const t = useTranslations('customers.perks.commission');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [state, setState] = useState<Load>({ kind: 'loading' });

  const load = useCallback(async () => {
    const result = await callApi<ExclusiveCommission>('GET', PATH);
    if (result.ok) {
      setState({ kind: 'ok', body: result.body });
      if (result.body.rule === null) onHidden();
      return;
    }
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (failure.status === 403) {
      setState({ kind: 'hidden' });
      onHidden();
      return;
    }
    setState({
      kind: 'failed',
      key:
        failure.status === 429
          ? 'throttled'
          : failure.status === 0 || failure.status >= 500
            ? 'unavailable'
            : 'unknown',
      minutes: Math.max(1, Math.ceil((failure.details?.retryAfterSeconds ?? 60) / 60)),
    });
  }, [onHidden]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'hidden') return null;
  if (state.kind === 'ok' && state.body.rule === null) return null;
  const money = (saved: Saved) => {
    const negative = saved.amount.startsWith('-');
    const text = formatMinor(saved.amount, saved.currency, locale);
    return negative ? `${text} (${t('refunds')})` : text;
  };
  return (
    <Card title={t('title')}>
      {state.kind === 'loading' ? (
        <div className="flex items-center gap-2 text-fg-muted" role="status">
          <Spinner />
          {t('loading')}
        </div>
      ) : state.kind === 'failed' ? (
        <LoadError
          className="w-full"
          message={t(`error.${state.key}`, { n: state.minutes })}
          retryLabel={tl('retry')}
          onRetry={() => {
            setState({ kind: 'loading' });
            void load();
          }}
        />
      ) : state.kind === 'ok' && state.body.rule !== null ? (
        <CommissionBody
          body={state.body}
          locale={locale}
          money={money}
          empty={t('empty')}
          labels={{
            rule: t('rule', {
              rate: percentOf(state.body.rule.exclusiveRateBps),
              standard: percentOf(state.body.rule.standardRateBps),
              n: state.body.rule.months,
            }),
            thisMonth: t('this-month'),
            last12: t('last-12'),
            zone: t('zone', { zone: state.body.zone }),
            nothing: t('nothing-this-month'),
          }}
        />
      ) : null}
    </Card>
  );
}

function CommissionBody({
  body,
  locale,
  money,
  empty,
  labels,
}: {
  readonly body: ExclusiveCommission;
  readonly locale: string;
  readonly money: (saved: Saved) => string;
  readonly empty: string;
  readonly labels: {
    readonly rule: string;
    readonly thisMonth: string;
    readonly last12: string;
    readonly zone: string;
    readonly nothing: string;
  };
}) {
  const groups = byCurrency(body.months);
  return (
    <>
      <p>{labels.rule}</p>
      {groups.length === 0 ? (
        <EmptyState size="compact" icon="tag" title={empty} />
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold">{labels.thisMonth}</h3>
            {body.thisMonth.length === 0 ? (
              <p className="text-sm text-fg-muted">{labels.nothing}</p>
            ) : (
              <ul className="text-sm">
                {body.thisMonth.map((saved) => (
                  <li key={saved.currency} className="font-medium" dir="ltr">
                    {money(saved)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-4">
            <h3 className="text-base font-semibold">{labels.last12}</h3>
            <p className="text-sm text-fg-muted">{labels.zone}</p>
            {groups.map((group) => {
              const peak = Math.max(...group.rows.map((row) => Math.abs(Number(row.amount))), 1);
              return (
                <section key={group.currency} aria-label={group.currency}>
                  <h4 className="text-sm font-medium">{group.currency}</h4>
                  <ul className="flex flex-col gap-1 text-sm">
                    {group.rows.map((row) => {
                      const negative = row.amount.startsWith('-');
                      return (
                        <li
                          key={row.month}
                          className="grid grid-cols-[6rem_1fr_auto] items-center gap-2"
                        >
                          <span className="text-fg-muted">{monthLabel(row.month, locale)}</span>
                          <span
                            aria-hidden="true"
                            className={`h-2 rounded-sm ${negative ? 'bg-critical-solid' : 'bg-accent'}`}
                            style={{ width: `${(Math.abs(Number(row.amount)) / peak) * 100}%` }}
                          />
                          <span dir="ltr" className="font-medium">
                            {money({ amount: row.amount, currency: group.currency })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
