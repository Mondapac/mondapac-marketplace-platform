'use client';

import { Badge, Banner, Button, EmptyState, Select, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import { reviewProblemOf, type ReviewProblem } from './review-errors.ts';
import { CHANGE_REASONS, type ReviewRow } from './types.ts';

type Step = 'closed' | 'open' | 'confirm-approve' | 'send-back';

/**
 * The Offers waiting for their first publication, oldest first, one card each. A card opens to
 * show the seller's texts; approve or send back (with a required reason) names the version the
 * reviewer saw. A decided or vanished Offer leaves the list.
 */
export function ReviewQueue({
  rows,
  canDecide,
  csrfToken,
}: {
  readonly rows: readonly ReviewRow[];
  readonly canDecide: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.review');
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const visible = rows.filter((row) => !gone.has(row.offerId));
  const leave = (offerId: string) => setGone((current) => new Set(current).add(offerId));

  return (
    <div className="flex flex-col gap-4">
      {visible.length === 0 ? (
        <EmptyState icon="inbox" title={t('empty')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((row) => (
            <ReviewCard
              key={row.offerId}
              row={row}
              canDecide={canDecide}
              csrfToken={csrfToken}
              onDecided={(kind) => {
                toast.success(t(`notice.${kind}`));
                leave(row.offerId);
              }}
              onGone={() => leave(row.offerId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewCard({
  row,
  canDecide,
  csrfToken,
  onDecided,
  onGone,
}: {
  readonly row: ReviewRow;
  readonly canDecide: boolean;
  readonly csrfToken: string;
  readonly onDecided: (kind: 'approved' | 'sent-back') => void;
  readonly onGone: () => void;
}) {
  const t = useTranslations('catalog.review');
  const tr = useTranslations();
  const locale = useLocale();
  const [step, setStep] = useState<Step>('closed');
  const [reasonCode, setReasonCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ReviewProblem | null>(null);
  const busy = useRef(false);
  const base = `catalog/admin/offers/${row.offerId}`;
  const name = row.product.name ?? row.product.productCode ?? row.sellerSku;
  const texts = Object.entries(row.description).filter(([, text]) => text !== '');

  async function send(action: 'approve' | 'request-changes', body: object): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>('POST', `${base}/${action}`, body, csrfToken);
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onDecided(action === 'approve' ? 'approved' : 'sent-back');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = reviewProblemOf(result.failure);
    setProblem(next);
    if (next.gone) onGone();
  }

  function sendBack(event: FormEvent) {
    event.preventDefault();
    if (reasonCode === '') return;
    void send('request-changes', { version: row.version, reasonCode });
  }

  const reset = () => {
    setProblem(null);
    setStep('open');
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="break-words text-lg font-semibold">{name}</h2>
        <Badge tone="neutral">{row.sellerSku}</Badge>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Field label={t('field.condition')} value={row.conditionCode} />
        <Field label={t('field.handling')} value={row.handling ?? t('field.handling-missing')} />
        <Field
          label={t('field.submitted')}
          value={row.submittedAt === null ? '-' : formatInstant(row.submittedAt, locale)}
        />
        <Field label={t('field.seller')} value={row.sellerId} mono />
      </dl>
      {step === 'closed' ? (
        <div>
          <Button variant="secondary" onClick={() => setStep('open')}>
            {t('open')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <section className="rounded-md bg-muted p-3">
            <h3 className="mb-1 font-medium">{t('field.description')}</h3>
            {texts.length === 0 ? (
              <p className="text-fg-muted">{t('field.no-description')}</p>
            ) : (
              texts.map(([locale, text]) => (
                <p key={locale} className="whitespace-pre-line break-words">
                  <span className="me-2 text-fg-muted">{locale}</span>
                  {text}
                </p>
              ))
            )}
          </section>
          {problem === null ? null : <Banner tone="critical">{tr(problem.key)}</Banner>}
          {!canDecide ? (
            <p className="text-fg-muted">{t('view-only')}</p>
          ) : step === 'confirm-approve' ? (
            <div className="flex flex-col gap-2">
              <p>{t('approve-confirm', { name })}</p>
              <div className="flex flex-wrap gap-3">
                <Button
                  loading={pending}
                  disabled={pending}
                  onClick={() => void send('approve', { version: row.version })}
                >
                  {t('approve-yes')}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={reset}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          ) : step === 'send-back' ? (
            <form className="flex flex-col gap-3" onSubmit={sendBack} noValidate>
              <Select
                name="reasonCode"
                label={t('reason.label')}
                value={reasonCode}
                placeholder={t('reason.choose')}
                options={CHANGE_REASONS.map((value) => ({ value, label: t(`reason.${value}`) }))}
                onChange={(event) => setReasonCode(event.target.value)}
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  variant="destructive"
                  loading={pending}
                  disabled={pending || reasonCode === ''}
                >
                  {t('send-back-yes')}
                </Button>
                <Button variant="secondary" disabled={pending} onClick={reset}>
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
                  setStep('send-back');
                }}
              >
                {t('send-back')}
              </Button>
              <Button variant="secondary" onClick={() => setStep('closed')}>
                {t('close')}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={`min-w-0 break-all ${mono ? 'text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
