'use client';

import { Badge, Banner, Button, CARD_TABLE, EmptyState, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { shortId } from '../shared/short-id.ts';
import { When } from '../shared/when.tsx';
import { formatMoney, percentChange } from './format.ts';
import { holdProblemOf, type HoldProblem } from './hold-errors.ts';
import { NOTE_MAX, REJECTION_REASONS, type PriceHoldRow } from './types.ts';

type Step = 'idle' | 'confirm-approve' | 'reject';
type Notice = { readonly kind: 'approved' | 'rejected'; readonly recordId: string };

/**
 * The queue of held prices, oldest first, with approve and reject per record. The API refuses a
 * decision by the account that submitted the price (`pricing.hold.own-submission`); the screen
 * shows that answer and leaves the row. A decided or vanished record leaves the list.
 */
export function HoldsQueue({
  rows,
  canDecide,
  csrfToken,
}: {
  readonly rows: readonly PriceHoldRow[];
  readonly canDecide: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('pricing.holds');
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const visible = rows.filter((row) => !gone.has(row.recordId));

  const leave = (recordId: string) => setGone((current) => new Set(current).add(recordId));

  return (
    <div className="flex flex-col gap-4">
      {notice === null ? null : <Banner tone="success">{t(`notice.${notice.kind}`)}</Banner>}
      {visible.length === 0 ? (
        <EmptyState icon="clock" title={t('empty')} />
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                {['price', 'anchor', 'direction', 'submitted', 'ids', 'actions'].map((col) => (
                  <th key={col} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(`col.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {visible.map((row) => (
                <HoldLine
                  key={row.recordId}
                  row={row}
                  canDecide={canDecide}
                  csrfToken={csrfToken}
                  onDecided={(kind) => {
                    setNotice({ kind, recordId: row.recordId });
                    leave(row.recordId);
                  }}
                  onGone={() => leave(row.recordId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HoldLine({
  row,
  canDecide,
  csrfToken,
  onDecided,
  onGone,
}: {
  readonly row: PriceHoldRow;
  readonly canDecide: boolean;
  readonly csrfToken: string;
  readonly onDecided: (kind: 'approved' | 'rejected') => void;
  readonly onGone: () => void;
}) {
  const t = useTranslations('pricing.holds');
  const tr = useTranslations();
  const [step, setStep] = useState<Step>('idle');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<HoldProblem | null>(null);
  const busy = useRef(false);
  const base = `pricing/admin/price-holds/${row.recordId}`;
  const change = percentChange(row.amount.amount, row.anchorAmount.amount);

  async function send(action: 'approve' | 'reject', body?: unknown): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>('POST', `${base}/${action}`, body, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onDecided(action === 'approve' ? 'approved' : 'rejected');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = holdProblemOf(result.failure);
    setProblem(next);
    if (next.gone) onGone();
  }

  function reject(event: FormEvent) {
    event.preventDefault();
    if (reasonCode === '') return;
    const trimmed = note.trim();
    void send('reject', { reasonCode, note: trimmed === '' ? null : trimmed });
  }

  return (
    <tr className={CARD_TABLE.row}>
      <td className={`${CARD_TABLE.cell} text-base font-semibold tabular-nums text-fg`}>
        {formatMoney(row.amount)}
      </td>
      <td className={`${CARD_TABLE.labelled} tabular-nums`} data-label={t('col.anchor')}>
        {formatMoney(row.anchorAmount)}
      </td>
      {/* On a card the change sits beside the held price, where the eye starts. */}
      <td className={CARD_TABLE.corner}>
        <Badge tone={row.direction === 'up' ? 'attention' : 'neutral'}>
          {t(`direction.${row.direction}`)}
        </Badge>
        {change === null ? null : (
          <span className="mt-1 block text-xs tabular-nums text-fg-muted">{change}</span>
        )}
      </td>
      <td className={CARD_TABLE.labelled} data-label={t('col.submitted')}>
        <When iso={row.submittedAt} missing="-" />
      </td>
      <td className={`${CARD_TABLE.labelled} text-sm`} data-label={t('col.ids')}>
        {/* Short references with the full id as their tooltip; the seller opens its page. */}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
          <dt className="text-fg-muted">{t('ids.seller')}</dt>
          <dd>
            <a
              className="text-link underline"
              href={`/sellers/${row.sellerId}`}
              title={row.sellerId}
            >
              {shortId(row.sellerId)}
            </a>
          </dd>
          <dt className="text-fg-muted">{t('ids.offer')}</dt>
          <dd title={row.offerId}>{shortId(row.offerId)}</dd>
          <dt className="text-fg-muted">{t('ids.variant')}</dt>
          <dd title={row.variantId}>{shortId(row.variantId)}</dd>
        </dl>
      </td>
      <td className={`${CARD_TABLE.cell} max-lg:col-span-2 max-lg:pt-2`}>
        <div className="flex flex-col gap-3 lg:min-w-56">
          {problem === null ? null : <Banner tone="critical">{tr(problem.key)}</Banner>}
          {!canDecide ? (
            <span className="text-fg-muted">{t('view-only')}</span>
          ) : step === 'confirm-approve' ? (
            <div className="flex flex-col gap-2">
              <p>{t('approve-confirm', { price: formatMoney(row.amount) })}</p>
              <div className="flex flex-wrap gap-3">
                <Button loading={pending} disabled={pending} onClick={() => void send('approve')}>
                  {t('approve-yes')}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => setStep('idle')}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          ) : step === 'reject' ? (
            <form className="flex flex-col gap-3" onSubmit={reject} noValidate>
              <Select
                name="reasonCode"
                label={t('reason.label')}
                value={reasonCode}
                placeholder={t('reason.choose')}
                options={REJECTION_REASONS.map((value) => ({
                  value,
                  label: t(`reason.${value}`),
                }))}
                onChange={(event) => setReasonCode(event.target.value)}
              />
              <TextField
                name="note"
                label={t('note.label')}
                help={t('note.help')}
                value={note}
                maxLength={NOTE_MAX}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  variant="destructive"
                  loading={pending}
                  disabled={pending || reasonCode === ''}
                >
                  {t('reject-yes')}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={() => setStep('idle')}>
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => {
                  setProblem(null);
                  setStep('confirm-approve');
                }}
              >
                {t('approve')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setProblem(null);
                  setStep('reject');
                }}
              >
                {t('reject')}
              </Button>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}
