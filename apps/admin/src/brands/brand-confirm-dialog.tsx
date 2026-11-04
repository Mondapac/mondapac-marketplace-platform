'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
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
  const path = `${API_BRANDS}/${brand.id}/${kind === 'approve' ? 'approve' : 'archive'}`;

  async function confirm() {
    const answer = await call.run<BrandWrap>('POST', path, { version: brand.version });
    if (answer.ok) onDone(answer.body.brand);
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('title', { name: brand.name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
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
      </div>
    </Dialog>
  );
}
