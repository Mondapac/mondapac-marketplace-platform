'use client';

import { Banner, Button, Dialog, Select, TextAreaField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type FormEvent } from 'react';
import { When } from '../../shared/when.tsx';
import { wordsFor } from './label.ts';
import {
  API_CERTIFICATES,
  REASON_TEXT_MAX,
  type HistoryEntry,
  type HistoryPage,
  type ReviewReason,
} from './types.ts';
import { useReviewCall } from './use-review-call.ts';

/**
 * Revoke an approved or expired certificate (certificates design DG7): a prepared reason, an
 * optional note, the consequence in words. Focus opens on Cancel; typed text is kept until Cancel.
 */
export function RevokeAction({
  certificateId,
  version,
  reasons,
  store,
  csrfToken,
}: {
  readonly certificateId: string;
  readonly version: number;
  readonly reasons: readonly ReviewReason[];
  readonly store: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.review.revoke');
  const tr = useTranslations();
  const [open, setOpen] = useState(false);
  const formId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const call = useReviewCall(csrfToken);
  const [reasonCode, setReasonCode] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [checked, setChecked] = useState(false);
  const reasonError = checked && reasonCode === '' ? t('reason-required') : undefined;
  const textError =
    reasonText.length > REASON_TEXT_MAX ? t('text-long', { max: REASON_TEXT_MAX }) : undefined;
  const dirty = reasonCode !== '' || reasonText !== '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (reasonCode === '' || textError !== undefined) return;
    const body: Record<string, unknown> = { version, reasonCode };
    if (reasonText.trim() !== '') body.reasonText = reasonText.trim();
    const answer = await call.run(`${API_CERTIFICATES}/${certificateId}/revoke`, body);
    if (answer.ok) window.location.assign(`/certificates/${certificateId}?revoked=1`);
  }

  return (
    <>
      <Button variant="destructive" className="max-sm:w-full" onClick={() => setOpen(true)}>
        {t('button')}
      </Button>
      {open ? (
        <Dialog
          open
          title={t('title')}
          onClose={() => {
            if (!dirty && !call.pending) setOpen(false);
          }}
          initialFocus={cancel}
          actions={
            <>
              <Button
                ref={cancel}
                variant="secondary"
                disabled={call.pending}
                onClick={() => setOpen(false)}
              >
                {t('cancel')}
              </Button>
              {call.problem?.reload === true ? (
                <Button autoFocus onClick={() => window.location.reload()}>
                  {t('reload')}
                </Button>
              ) : (
                <Button
                  type="submit"
                  form={formId}
                  variant="destructive-solid"
                  loading={call.pending}
                  disabled={call.pending}
                >
                  {t('confirm')}
                </Button>
              )}
            </>
          }
        >
          <form
            id={formId}
            onSubmit={(event) => void submit(event)}
            noValidate
            className="flex flex-col gap-4"
          >
            <div role="alert">
              {call.problem === null ? null : (
                <Banner tone="critical">{tr(call.problem.key as never)}</Banner>
              )}
            </div>
            <p className="text-sm">{t('body', { store })}</p>
            <p className="text-sm">{t('body-pending')}</p>
            {reasons.length === 0 ? (
              <Banner tone="attention">{t('no-reasons')}</Banner>
            ) : (
              <Select
                label={t('reason')}
                required
                placeholder={t('reason-placeholder')}
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value)}
                options={reasons.map((reason) => ({
                  value: reason.code,
                  label: wordsFor(tr, 'reason', reason.code),
                }))}
                error={reasonError}
              />
            )}
            <TextAreaField
              label={t('note')}
              optionalLabel={t('optional')}
              rows={3}
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              help={t('note-help')}
              error={textError}
            />
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The full status history (CA3). Reading it is audited, so it opens behind a "Show history" step
 * that says so. Newest first; older pages are read on request. Notes are plain text.
 */
export function FullHistory({
  certificateId,
  csrfToken,
}: {
  readonly certificateId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.review.full-history');
  const tr = useTranslations();
  const call = useReviewCall(csrfToken);
  const [entries, setEntries] = useState<readonly HistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);

  async function load(before: string | null) {
    const query = before === null ? '' : `?beforeId=${encodeURIComponent(before)}`;
    const answer = await call.run<HistoryPage>(
      `${API_CERTIFICATES}/${certificateId}/history${query}`,
      undefined,
      'GET',
    );
    if (!answer.ok) return;
    const fresh = answer.body.entries.map((entry) => ({
      id: entry.id,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      actorKind: entry.actorKind,
      reasonCode: entry.reasonCode,
      reasonLabel: entry.reasonLabel,
      note: entry.note,
      occurredAt: entry.occurredAt,
    }));
    setEntries((current) => [...(before === null ? [] : (current ?? [])), ...fresh]);
    setNext(answer.body.nextBeforeId);
  }

  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite">
        {call.problem === null ? null : (
          <Banner tone="critical">{tr(call.problem.key as never)}</Banner>
        )}
      </div>
      {entries === null ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-fg-muted">{t('recorded')}</p>
          <Button
            variant="secondary"
            loading={call.pending}
            disabled={call.pending}
            onClick={() => void load(null)}
          >
            {t('show')}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-fg-muted">{t('none')}</p>
      ) : (
        <>
          <ol className="flex flex-col gap-3">
            {entries.map((entry) => (
              <li key={entry.id} className="text-sm">
                <p>
                  {t('entry', {
                    from:
                      entry.fromStatus === null
                        ? t('started')
                        : wordsFor(tr, 'status', entry.fromStatus),
                    to: wordsFor(tr, 'status', entry.toStatus),
                    by: wordsFor(tr, 'actor', entry.actorKind),
                  })}{' '}
                  <When iso={entry.occurredAt} missing="-" />
                </p>
                {entry.reasonCode === null ? null : (
                  <p className="text-fg-muted">
                    {entry.reasonLabel ?? wordsFor(tr, 'reason', entry.reasonCode)}
                  </p>
                )}
                {entry.note === null ? null : (
                  <p className="whitespace-pre-wrap wrap-anywhere text-fg-muted">{entry.note}</p>
                )}
              </li>
            ))}
          </ol>
          {next === null ? null : (
            <div>
              <Button
                variant="secondary"
                loading={call.pending}
                disabled={call.pending}
                onClick={() => void load(next)}
              >
                {t('older')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
