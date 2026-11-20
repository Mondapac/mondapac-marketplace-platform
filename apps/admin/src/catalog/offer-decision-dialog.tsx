'use client';

import { Banner, Button, Dialog, Select, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { reviewProblemOf, type ReviewProblem } from './review-errors.ts';
import { CHANGE_REASONS, type ReviewRow } from './types.ts';

export type OfferDecision = 'approve' | 'request-changes';

/**
 * The decision on one Offer waiting for its first publication, opened from the row's Actions menu
 * (confirmation level 2: it names the Offer and what follows, shows what the seller wrote, the red
 * button is not the focused one, and sending back needs one prepared reason). Every decision names
 * the version the reviewer saw. A refused decision is told here; an Offer that is no longer waiting
 * closes the dialog and the list reads again.
 */
export function OfferDecisionDialog({
  row,
  decision,
  csrfToken,
  onClose,
  onSettled,
}: {
  readonly row: ReviewRow | null;
  readonly decision: OfferDecision | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The decision was made, or the Offer is gone (`why` is the full message key). */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('catalog.review');
  const tr = useTranslations();
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [reasonCode, setReasonCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ReviewProblem | null>(null);

  useEffect(() => {
    setReasonCode('');
    setProblem(null);
  }, [row?.offerId, decision]);

  if (row === null || decision === null) return null;
  const name = row.product.name ?? row.product.productCode ?? row.sellerSku;
  const texts = Object.entries(row.description).filter(([, text]) => text !== '');
  const ready = decision === 'approve' || reasonCode !== '';

  async function submit() {
    if (busy.current || row === null || decision === null || !ready) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const body =
      decision === 'approve' ? { version: row.version } : { version: row.version, reasonCode };
    const result = await callApi<unknown>(
      'POST',
      `catalog/admin/offers/${row.offerId}/${decision}`,
      body,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(`notice.${decision === 'approve' ? 'approved' : 'sent-back'}`));
      onSettled();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = reviewProblemOf(result.failure);
    if (next.gone) onSettled(next.key);
    else setProblem(next);
  }

  return (
    <Dialog
      open
      size="form"
      title={t(`dialog.${decision}.title`, { name })}
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
        <p className="wrap-anywhere">{t(`dialog.${decision}.body`, { name })}</p>
        {problem === null ? null : (
          <div role="alert">
            <Banner tone="critical">{tr(problem.key)}</Banner>
          </div>
        )}
        <section className="rounded-md bg-muted p-3">
          <h3 className="mb-1 font-medium">{t('field.description')}</h3>
          {texts.length === 0 ? (
            <p className="text-fg-muted">{t('field.no-description')}</p>
          ) : (
            texts.map(([locale, text]) => (
              <p key={locale} className="break-words whitespace-pre-line">
                <span className="me-2 text-fg-muted">{locale}</span>
                {text}
              </p>
            ))
          )}
        </section>
        {decision === 'request-changes' ? (
          <Select
            name="reasonCode"
            label={t('reason.label')}
            value={reasonCode}
            placeholder={t('reason.choose')}
            options={CHANGE_REASONS.map((value) => ({ value, label: t(`reason.${value}`) }))}
            onChange={(event) => setReasonCode(event.target.value)}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
