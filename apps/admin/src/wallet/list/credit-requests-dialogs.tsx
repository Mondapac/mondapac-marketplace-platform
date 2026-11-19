'use client';

import { Banner, Button, ConfirmAction, DataList, Dialog, Select } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { shortId } from '../../shared/short-id.ts';
import { isStepUpCancelled, useGuardedCall } from '../../step-up/step-up.tsx';
import { walletProblemOf } from '../errors.ts';
import { wordFor } from '../labels.ts';
import { formatMinor } from '../money.ts';
import { REJECT_REASONS, type AdminCredit } from '../types.ts';
import { shortInstantInZone } from '../../shared/format.ts';

export type DecideAsk = {
  readonly kind: 'approve' | 'reject';
  readonly row: AdminCredit;
} | null;

/** Refusals that mean the row on screen is out of date: the list reads its rows again. */
export const STALE_PROBLEMS: readonly string[] = [
  'request-expired',
  'request-decided',
  'request-not-found',
];

/**
 * Approve and Reject of a credit request. Approving is a money action of level 3: the dialog names
 * the amount and the customer, and the admin types the request's short id before the red button
 * works; focus starts on Cancel. The guarded call then opens the shared step-up dialog for the
 * code; a cancelled code leaves this dialog as it was. Reject is level 2 and needs a reason. The
 * response drives the list (it reads its rows again); nothing here edits a row.
 */
export function CreditDecideDialogs({
  ask,
  csrfToken,
  onClose,
  onDone,
  onFailed,
}: {
  readonly ask: DecideAsk;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** Decided: the list says so and reads its rows again. */
  readonly onDone: (kind: 'approve' | 'reject', row: AdminCredit) => void;
  /** Refused: `key` is the message under `wallet.error`; the list shows it and may read again. */
  readonly onFailed: (key: string, row: AdminCredit) => void;
}) {
  const t = useTranslations('wallet');
  const tl = useTranslations('wallet.list');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  // Every opening starts clean.
  useEffect(() => {
    setReason('');
    setPending(false);
  }, [ask]);

  async function decide(kind: 'approve' | 'reject', row: AdminCredit) {
    if (busy.current) return;
    if (kind === 'reject' && reason === '') return;
    busy.current = true;
    setPending(true);
    const result = await guarded<AdminCredit>(
      'POST',
      `wallet/admin/credit-requests/${encodeURIComponent(row.id)}/${kind}`,
      kind === 'reject' ? { reasonCode: reason } : undefined,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onDone(kind, row);
      return;
    }
    // A cancelled code leaves the dialog exactly as it was.
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    onFailed(walletProblemOf(result.failure, 'decide'), row);
  }

  const row = ask?.row ?? null;
  const reference = row === null ? '' : shortId(row.id);
  const amount = row === null ? '' : formatMinor(row.amount, row.currency, locale);
  const customer = row === null ? '' : shortId(row.customerAccountId);

  return (
    <>
      <ConfirmAction
        open={ask?.kind === 'approve'}
        level={3}
        title={tl('approve.title', { amount, customer })}
        body={<p>{tl('approve.body', { amount, customer })}</p>}
        rowName={reference}
        typeLabel={tl('approve.type-to-confirm', { id: reference })}
        stepUpNote={tl('approve.step-up-note')}
        confirmLabel={tl('approve.confirm')}
        cancelLabel={t('cancel')}
        pending={pending}
        onConfirm={() => {
          if (ask?.kind === 'approve') void decide('approve', ask.row);
        }}
        onCancel={onClose}
      />
      <ConfirmAction
        open={ask?.kind === 'reject'}
        level={2}
        title={tl('reject.title', { amount, customer })}
        body={
          <div className="flex flex-col gap-4">
            <p>{tl('reject.body', { amount, customer })}</p>
            <Select
              label={tl('reject.reason')}
              name="reasonCode"
              placeholder={tl('reject.reason-placeholder')}
              value={reason}
              disabled={pending}
              options={REJECT_REASONS.map((code) => ({
                value: code,
                label: tl(`reject-reason.${code}`),
              }))}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        }
        rowName={reference}
        confirmLabel={tl('reject.confirm')}
        cancelLabel={t('cancel')}
        pending={pending}
        confirmDisabled={reason === ''}
        onConfirm={() => {
          if (ask?.kind === 'reject') void decide('reject', ask.row);
        }}
        onCancel={onClose}
      />
    </>
  );
}

/**
 * The read-only details of one request: what the table has no room for (the note, why a second
 * admin was needed, how it was decided). The note is plain text. No decision is made here.
 */
export function CreditDetailsDialog({
  row,
  accountId,
  zone,
  onClose,
}: {
  readonly row: AdminCredit | null;
  readonly accountId: string;
  readonly zone: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('wallet');
  const tl = useTranslations('wallet.list');
  const locale = useLocale();
  const none = tl('none');
  const person = (id: string | null) =>
    id === null ? null : id === accountId ? tl('you') : shortId(id);
  const when = (iso: string | null) =>
    iso === null ? null : shortInstantInZone(iso, locale, zone);
  const own = row !== null && row.requestedBy === accountId && row.status === 'pending';
  return (
    <Dialog
      open={row !== null}
      title={
        row === null ? tl('details.title') : tl('details.title-named', { id: shortId(row.id) })
      }
      onClose={onClose}
      actions={
        <Button variant="secondary" onClick={onClose}>
          {tl('details.close')}
        </Button>
      }
    >
      {row === null ? null : (
        <div className="flex flex-col gap-4">
          {own ? <Banner tone="info">{t('error.approver-is-requester')}</Banner> : null}
          <DataList
            missing={none}
            rows={[
              {
                label: tl('details.note'),
                value:
                  row.note === null ? null : (
                    <span className="whitespace-pre-line wrap-anywhere">{row.note}</span>
                  ),
              },
              {
                label: tl('details.approval-reason'),
                value:
                  row.approvalReason === null
                    ? null
                    : wordFor(t, 'result.approval-reason', row.approvalReason),
              },
              { label: tl('details.decided-by'), value: person(row.decidedBy) },
              { label: tl('details.decided'), value: when(row.decidedAt) },
              {
                label: tl('details.decision-reason'),
                value:
                  row.decisionReason === null
                    ? null
                    : wordFor(t, 'list.reject-reason', row.decisionReason),
              },
              {
                label: tl('details.journal'),
                value: row.journalId === null ? null : shortId(row.journalId),
              },
            ]}
          />
        </div>
      )}
    </Dialog>
  );
}
