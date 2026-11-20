'use client';

import { Banner, Button, Dialog, Select, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useWrite } from './use-write.ts';
import { API_PROPOSALS, REJECT_REASONS, type ProposalDecided } from './types.ts';

export type ProposalDecision = 'approve' | 'reject';

/**
 * The decision on one category proposal, opened from the row's Actions menu (confirmation level 2:
 * it names the proposal and what follows, the red button is not the focused one, and a rejection
 * takes one prepared reason the seller sees). A refused decision is told in the dialog; one that
 * went stale closes it and the list reads again, with the reason said as a message.
 */
export function ProposalDecisionDialog({
  id,
  version,
  name,
  store,
  decision,
  csrfToken,
  onClose,
  onSettled,
}: {
  readonly id: string | null;
  readonly version: number;
  /** The proposal in the default language, and the store it comes from. */
  readonly name: string;
  readonly store: string;
  readonly decision: ProposalDecision | null;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The decision was made, or the proposal turned out stale (`why` names the error key). */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('categories.proposals');
  const cancel = useRef<HTMLButtonElement>(null);
  const write = useWrite(csrfToken);
  const [reason, setReason] = useState('');
  const clearProblem = useRef(write.clear);
  clearProblem.current = write.clear;

  useEffect(() => {
    setReason('');
    clearProblem.current();
  }, [id, decision]);

  if (id === null || decision === null) return null;
  const ready = decision === 'approve' || reason !== '';

  async function submit() {
    if (id === null || decision === null || !ready) return;
    const body = decision === 'approve' ? { version } : { version, reasonCode: reason };
    const result = await write.run<ProposalDecided>(`${API_PROPOSALS}/${id}/${decision}`, body);
    if (result.ok) {
      toast.success(t(`decided.${result.body.status}`));
      onSettled();
      return;
    }
    if (result.problem?.reload === true && result.problem.key !== 'category-proposal_not-allowed') {
      onSettled(result.problem.key);
    }
  }

  return (
    <Dialog
      open
      size="form"
      title={t(`dialog.${decision}.title`, { name })}
      onClose={() => {
        if (!write.pending) onClose();
      }}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={write.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive-solid"
            loading={write.pending}
            disabled={!ready || write.pending}
            onClick={() => void submit()}
          >
            {t(`dialog.${decision}.confirm`)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="wrap-anywhere">{t(`dialog.${decision}.body`, { name, store })}</p>
        {write.problem === null ? null : (
          <div role="alert">
            <Banner tone="critical">
              {t(`error.${write.problem.key}`, { max: write.problem.max ?? 0 })}
            </Banner>
          </div>
        )}
        {decision === 'reject' ? (
          <>
            <Select
              label={t('reason-label')}
              placeholder={t('reason-choose')}
              value={reason}
              options={REJECT_REASONS.map((code) => ({ value: code, label: t(`reason.${code}`) }))}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-sm text-fg-muted">{t('reason-note')}</p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
