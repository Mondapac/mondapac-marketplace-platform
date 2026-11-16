'use client';

import { ActionRow, Badge, Banner, Button, Card, Dialog, TextField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import {
  isNoteFailure,
  ReviewNoteField,
  trimmedNote,
  useSentForReview,
} from '../shared/review-note.tsx';
import { commissionProblemOf } from './errors.ts';
import { bpsOf, MAX_RATE_BPS, percentInput, percentOf, type CommissionRate } from './types.ts';

/** A seller's commission rate: the rate in force, its source, a percent field and a reset. */
export function CommissionRateCard({
  initial,
  canEdit,
  csrfToken,
}: {
  readonly initial: CommissionRate;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('commission');
  const locale = useLocale();
  const [rate, setRate] = useState(initial);
  const [text, setText] = useState(percentInput(initial.rateBps));
  const [pending, setPending] = useState<'save' | 'reset' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [resetNote, setResetNote] = useState('');
  const [noteError, setNoteError] = useState<'required' | 'rejected' | null>(null);
  const busy = useRef(false);
  const sentForReview = useSentForReview();
  // Setting or removing the rate needs a fresh two-step code: the shared dialog asks for it.
  const guarded = useGuardedCall();
  const path = `commission-payouts/admin/sellers/${rate.sellerId}/commission-rate`;

  function adopt(next: CommissionRate) {
    setRate(next);
    setText(percentInput(next.rateBps));
  }

  function fail(failure: Parameters<typeof commissionProblemOf>[0]) {
    if (failure.status === 401) window.location.assign('/session-ended');
    else setProblem(commissionProblemOf(failure));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const bps = bpsOf(text);
    setProblem(null);
    if (bps === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const sent = trimmedNote(note);
    if (sent === null) {
      setNoteError('required');
      return;
    }
    setNoteError(null);
    busy.current = true;
    setPending('save');
    const result = await guarded<CommissionRate>(
      'PUT',
      path,
      { rateBps: bps, note: sent },
      csrfToken,
    );
    busy.current = false;
    setPending(null);
    if (result.ok) {
      adopt(result.body);
      setNote('');
      toast.success(t('saved-done'));
      sentForReview(result.body);
    } else if (!isStepUpCancelled(result)) {
      if (isNoteFailure(result.failure)) setNoteError('rejected');
      else fail(result.failure);
    }
  }

  async function reset() {
    if (busy.current) return;
    const sent = trimmedNote(resetNote);
    if (sent === null) {
      setNoteError('required');
      return;
    }
    setNoteError(null);
    busy.current = true;
    setPending('reset');
    setProblem(null);
    setInvalid(false);
    // The confirm closes first, so the code dialog never opens on top of it.
    setConfirming(false);
    const result = await guarded<CommissionRate>(
      'DELETE',
      `${path}?note=${encodeURIComponent(sent)}`,
      undefined,
      csrfToken,
    );
    busy.current = false;
    setPending(null);
    if (result.ok) {
      adopt(result.body);
      setResetNote('');
      toast.success(t('reset-done'));
      sentForReview(result.body);
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (isNoteFailure(result.failure)) {
      setNoteError('rejected');
      setConfirming(true);
      return;
    }
    // "Not set" means the seller is already on the Market rate: show that, with the words.
    if (result.failure.code === 'commission-payouts.rate-not-set') {
      adopt({ ...rate, rateBps: rate.marketRateBps, source: 'market' });
    }
    fail(result.failure);
  }

  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{t('intro')}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-fg-muted">{t('current')}:</span>
          <strong className="text-2xl tabular-nums">{percentOf(rate.rateBps, locale)}%</strong>
          <Badge tone={rate.source === 'seller' ? 'info' : 'neutral'}>
            {t(`source.${rate.source}`)}
          </Badge>
        </div>
        {rate.source === 'seller' ? (
          <p className="text-sm text-fg-muted">
            {t('market-rate', { rate: percentOf(rate.marketRateBps, locale) })}
          </p>
        ) : null}
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        {canEdit ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => void save(e)} noValidate>
            <TextField
              name="rate"
              label={t('field')}
              help={t('field-help', { max: MAX_RATE_BPS / 100 })}
              inputMode="decimal"
              value={text}
              error={invalid ? t('invalid', { max: MAX_RATE_BPS / 100 }) : undefined}
              onChange={(event) => setText(event.target.value)}
            />
            <ReviewNoteField
              value={note}
              onChange={(next) => {
                setNote(next);
                setNoteError(null);
              }}
              error={confirming ? undefined : (noteError ?? undefined)}
            />
            <ActionRow>
              <Button type="submit" loading={pending === 'save'} disabled={pending === 'reset'}>
                {t('save')}
              </Button>
              {rate.source === 'seller' ? (
                <Button
                  variant="secondary"
                  disabled={pending !== null}
                  onClick={() => {
                    setResetNote('');
                    setNoteError(null);
                    setConfirming(true);
                  }}
                >
                  {t('reset')}
                </Button>
              ) : null}
            </ActionRow>
          </form>
        ) : null}
      </div>
      <Dialog
        open={confirming}
        title={t('reset-title')}
        onClose={() => {
          if (pending === null) setConfirming(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              className="min-h-12"
              disabled={pending !== null}
              onClick={() => setConfirming(false)}
            >
              {t('cancel')}
            </Button>
            <Button className="min-h-12" loading={pending === 'reset'} onClick={() => void reset()}>
              {t('reset-yes')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p>{t('reset-body', { rate: percentOf(rate.marketRateBps, locale) })}</p>
          <ReviewNoteField
            value={resetNote}
            onChange={(next) => {
              setResetNote(next);
              setNoteError(null);
            }}
            error={confirming ? (noteError ?? undefined) : undefined}
          />
        </div>
      </Dialog>
    </Card>
  );
}
