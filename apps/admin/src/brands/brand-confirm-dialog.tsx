'use client';

import { Banner, Button, Dialog, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { API_BRANDS, type BrandRow, type BrandWrap } from './types.ts';
import { useBrandCall } from './use-brand-call.ts';

/** What the dialog asks: approve a seller's proposal, turn it down, or archive a live brand. */
export type ConfirmKind = 'approve' | 'reject' | 'archive';

/**
 * One yes for approve, reject (archive of a proposal) and archive. The words are under
 * `brands.confirm.<kind>`; reject and archive are the destructive ones.
 */
export function BrandConfirmDialog({
  kind,
  brand,
  csrfToken,
  onClose,
  onDone,
  onStale,
}: {
  readonly kind: ConfirmKind;
  readonly brand: BrandRow;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (brand: BrandRow) => void;
  readonly onStale: () => void;
}) {
  const t = useTranslations(`brands.confirm.${kind}`);
  const tr = useTranslations();
  const call = useBrandCall(csrfToken);
  // Level 2: a dialog that archives or turns down opens with focus on the safe choice.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const path = `${API_BRANDS}/${brand.id}/${kind === 'approve' ? 'approve' : 'archive'}`;

  // Turning a proposal down or archiving a brand may carry a short reason (one line, up to 500).
  const asksReason = kind !== 'approve';
  const [reason, setReason] = useState('');

  async function confirm() {
    const note = reason.trim();
    const body =
      asksReason && note !== ''
        ? { version: brand.version, reason: note }
        : { version: brand.version };
    const answer = await call.run<BrandWrap>('POST', path, body);
    if (answer.ok) onDone(answer.body.brand);
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('title', { name: brand.name })}
      onClose={onClose}
      initialFocus={cancelRef}
      actions={
        <>
          <Button ref={cancelRef} variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onStale}>{tr('brands.form.reload')}</Button>
          ) : (
            <Button
              variant={kind === 'approve' ? 'primary' : 'destructive'}
              loading={call.pending}
              disabled={call.pending}
              onClick={() => void confirm()}
            >
              {t('yes')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : <Banner tone="critical">{tr(problem.key)}</Banner>}
        <p>{t('body', { name: brand.name })}</p>
        {asksReason ? (
          <TextField
            label={tr('brands.confirm.reason.label')}
            optionalLabel={tr('brands.confirm.reason.optional')}
            help={tr('brands.confirm.reason.help')}
            maxLength={500}
            value={reason}
            disabled={call.pending}
            onChange={(event) => setReason(event.target.value.replace(/[\r\n]+/g, ' '))}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
