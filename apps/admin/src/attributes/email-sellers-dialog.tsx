'use client';

import { Badge, Banner, Button, Dialog, SkeletonRows } from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import {
  API_MISSING_DETAILS_EMAIL,
  type EmailSellersAnswer,
  type MissingDetailsItem,
} from './types.ts';

type Preview =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly answer: EmailSellersAnswer }
  | { readonly state: 'failed'; readonly key: string };

/** The key of the message that explains a refused request. */
export function emailErrorKey(status: number, code: string): string {
  if (code === 'missing-details-email.unconfigured') return 'unconfigured';
  if (code === 'access.denied' || code === 'request.csrf') return 'denied';
  if (code === 'validation.failed') return 'too-many';
  if (status === 0) return 'network';
  return 'unknown';
}

/** How many sellers a request would email: those with at least one product not asked recently. */
export function sellersToEmail(answer: EmailSellersAnswer): number {
  return answer.sellers.filter((seller) =>
    seller.products.some((product) => product.status === 'will-send'),
  ).length;
}

/** The picked products that can be emailed: a platform product has no seller to ask. */
export function emailable(rows: readonly MissingDetailsItem[]): readonly MissingDetailsItem[] {
  return rows.filter((row) => row.sellerId !== null);
}

/**
 * The confirmation of "Email sellers" (attributes package A4-4). It first asks the API who would
 * be emailed (a preview that writes nothing), lists the sellers with what happens to each, and
 * shows the mail the first of them gets. Sending asks again with the same products; the API judges
 * them anew and applies the 7-day limit per seller and product. The mail is English only.
 */
export function EmailSellersDialog({
  rows,
  csrfToken,
  onClose,
  onSent,
}: {
  readonly rows: readonly MissingDetailsItem[];
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The request went through: how many sellers will get a mail. */
  readonly onSent: (sellers: number) => void;
}) {
  const t = useTranslations('attributes.missing-details.email');
  const format = useFormatter();
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const ids = emailable(rows).map((row) => row.productId);

  useEffect(() => {
    let current = true;
    void (async () => {
      const result = await callApi<EmailSellersAnswer>(
        'POST',
        API_MISSING_DETAILS_EMAIL,
        { productIds: ids, dryRun: true },
        csrfToken,
      );
      if (!current) return;
      if (result.ok) {
        setPreview({ state: 'ready', answer: result.body });
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setPreview({
        state: 'failed',
        key: emailErrorKey(result.failure.status, result.failure.code),
      });
    })();
    return () => {
      current = false;
    };
    // The picked products are fixed while the dialog is open.
  }, []);

  async function send() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<EmailSellersAnswer>(
      'POST',
      API_MISSING_DETAILS_EMAIL,
      { productIds: ids },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onSent(
        result.body.sellers.filter((s) => s.products.some((p) => p.status === 'queued')).length,
      );
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(emailErrorKey(result.failure.status, result.failure.code));
  }

  const answer = preview.state === 'ready' ? preview.answer : null;
  const count = answer === null ? 0 : sellersToEmail(answer);
  const first = answer?.sellers.find((seller) =>
    seller.products.some((product) => product.status === 'will-send'),
  );
  const listed = first?.products.filter((product) => product.status === 'will-send') ?? [];
  return (
    <Dialog
      open
      title={answer === null ? t('title-pending') : t('title', { count })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button loading={pending} disabled={count === 0 || pending} onClick={() => void send()}>
            {t('send', { count })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {preview.state === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
        {preview.state === 'failed' ? (
          <Banner tone="critical">{t(`error.${preview.key}`)}</Banner>
        ) : null}
        {problem === null ? null : <Banner tone="critical">{t(`error.${problem}`)}</Banner>}
        {answer === null ? null : (
          <>
            <p className="m-0 text-fg-muted">{t('intro', { days: answer.throttleDays })}</p>
            {answer.sellers.length === 0 ? (
              <Banner tone="attention">{t('nobody')}</Banner>
            ) : (
              <ul
                role="list"
                aria-label={t('recipients')}
                className="m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line p-0"
              >
                {answer.sellers.map((seller) => {
                  const will = seller.products.filter((p) => p.status === 'will-send').length;
                  const skipped = seller.products.filter((p) => p.status !== 'will-send');
                  const lastDate = skipped
                    .map((p) => p.lastRequestedAt)
                    .filter((value): value is string => value !== null)
                    .sort()
                    .at(-1);
                  return (
                    <li
                      key={seller.sellerId}
                      className="flex flex-wrap items-center gap-2 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 wrap-anywhere">
                        {seller.sellerName ?? t('unnamed-seller')}
                        <span className="ms-2 text-sm text-fg-muted">
                          {t('products', { count: seller.products.length })}
                        </span>
                      </span>
                      {will > 0 ? (
                        <Badge tone="success">{t('will-send')}</Badge>
                      ) : (
                        <Badge tone="neutral">
                          {lastDate === undefined
                            ? t('skipped-recent')
                            : t('skipped', {
                                date: format.dateTime(new Date(lastDate), { dateStyle: 'medium' }),
                              })}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {answer.ignored.length > 0 ? (
              <p className="m-0 text-sm text-fg-muted">
                {t('ignored', { count: answer.ignored.length })}
              </p>
            ) : null}
            {first === undefined ? null : (
              <div className="flex flex-col gap-1 rounded-lg border border-line bg-muted p-3">
                <p className="m-0 text-sm font-medium">{t('preview')}</p>
                <p className="m-0 text-sm">
                  <strong>{t('subject-label')}</strong> {t('subject', { count: listed.length })}
                </p>
                <p className="m-0 text-sm whitespace-pre-line wrap-anywhere" lang="en" dir="ltr">
                  {first.sellerName === null
                    ? t('preview-hi-anonymous')
                    : t('preview-hi', { name: first.sellerName })}
                  {'\n\n'}
                  {t('preview-lead')}
                  {'\n\n'}
                  {listed
                    .map(
                      (product) =>
                        `- ${product.name ?? product.productCode}: ${product.missing.join(', ')}`,
                    )
                    .join('\n')}
                  {'\n\n'}
                  {t('preview-close')}
                  {'\n\n'}
                  {t('preview-button')}
                  {'\n\n'}
                  {t('preview-questions')}
                  {'\n\n'}
                  {t('preview-signature')}
                </p>
                <p className="m-0 text-sm text-fg-muted">{t('english-only')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
