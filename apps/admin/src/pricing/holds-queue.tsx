'use client';

import { Badge, Banner, Button, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../sellers/format.ts';
import { formatMoney } from './format.ts';
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
        <div className="rounded-lg border border-line p-6">
          <p className="font-medium">{t('empty')}</p>
        </div>
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-160 text-start text-sm">
            <caption className="sr-only">{t('title')}</caption>
            <thead className="bg-muted text-fg-muted">
              <tr>
                {['price', 'anchor', 'direction', 'submitted', 'ids', 'actions'].map((col) => (
                  <th key={col} scope="col" className="px-4 py-3 font-medium">
                    {t(`col.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-row">
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
    <tr>
      <td className="px-4 py-3 align-top font-medium text-fg">{formatMoney(row.amount)}</td>
      <td className="px-4 py-3 align-top">{formatMoney(row.anchorAmount)}</td>
      <td className="px-4 py-3 align-top">
        <Badge tone={row.direction === 'up' ? 'attention' : 'neutral'}>
          {t(`direction.${row.direction}`)}
        </Badge>
      </td>
      <td className="px-4 py-3 align-top">{formatInstant(row.submittedAt)}</td>
      <td className="break-all px-4 py-3 align-top text-xs text-fg-muted">
        <div>
          {t('ids.seller')}: {row.sellerId}
        </div>
        <div>
          {t('ids.offer')}: {row.offerId}
        </div>
        <div>
          {t('ids.variant')}: {row.variantId}
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="flex min-w-56 flex-col gap-3">
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
