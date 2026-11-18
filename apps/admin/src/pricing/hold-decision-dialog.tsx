'use client';

import { Banner, Button, Dialog, Select, TextField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatMoney } from './format.ts';
import { holdProblemOf } from './hold-errors.ts';
import { NOTE_MAX, REJECTION_REASONS, type PriceHoldRow } from './types.ts';

export type HoldDecision = 'approve' | 'reject';

/**
 * The decision on one held price, opened from the row's Actions menu (confirmation level 3: it
 * money-affects the seller and the buyers, so it names the price and what follows; a rejection
 * needs a reason code and may carry a note the seller reads). The API refuses a decision by the
 * account that submitted the price; the dialog shows that answer. A record that is no longer
 * pending closes the dialog and the list reads again.
 */
export function HoldDecisionDialog({
  row,
  decision,
  csrfToken,
  onClose,
  onSettled,
}: {
  readonly row: PriceHoldRow | null;
  readonly decision: HoldDecision | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The decision was made, or the record is gone (`gone`): the list reads again. */
  readonly onSettled: (gone: boolean) => void;
}) {
  const t = useTranslations('pricing.holds');
  const tr = useTranslations();
  const locale = useLocale();
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setReasonCode('');
    setNote('');
    setProblem(null);
  }, [row?.recordId, decision]);

  if (row === null || decision === null) return null;
  const price = formatMoney(row.amount, locale);
  const ready = decision === 'approve' || reasonCode !== '';

  async function submit() {
    if (busy.current || row === null) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const trimmed = note.trim();
    const result = await callApi<unknown>(
      'POST',
      `pricing/admin/price-holds/${row.recordId}/${decision}`,
      decision === 'reject' ? { reasonCode, note: trimmed === '' ? null : trimmed } : undefined,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(`notice.${decision === 'approve' ? 'approved' : 'rejected'}`));
      onSettled(false);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = holdProblemOf(result.failure);
    if (next.gone) {
      toast.error(tr(next.key));
      onSettled(true);
      return;
    }
    setProblem(next.key);
  }

  return (
    <Dialog
      open
      size={decision === 'approve' ? 'default' : 'form'}
      title={t(`dialog.${decision}.title`)}
      onClose={() => {
        if (!pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive-solid"
            loading={pending}
            disabled={!ready || pending}
            onClick={() => void submit()}
          >
            {t(`dialog.${decision}.confirm`)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="wrap-anywhere">
          {t(`dialog.${decision}.body`, {
            product: row.productName ?? t('name-unavailable', { id: row.offerId.slice(0, 8) }),
            price,
          })}
        </p>
        {problem === null ? null : (
          <div role="alert">
            <Banner tone="critical">{tr(problem)}</Banner>
          </div>
        )}
        {decision === 'reject' ? (
          <>
            <Select
              name="reasonCode"
              label={t('reason.label')}
              value={reasonCode}
              placeholder={t('reason.choose')}
              options={REJECTION_REASONS.map((value) => ({ value, label: t(`reason.${value}`) }))}
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
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
