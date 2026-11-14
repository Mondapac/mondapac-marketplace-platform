import { Badge } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { shortId } from '../../shared/short-id.ts';
import { When } from '../../shared/when.tsx';
import { AnswerForm } from './answer-form.tsx';
import type { RequestDetail } from './types.ts';

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * One issuer request (certificate issuers design A13): what the seller typed (plain text, marked as
 * the seller's), its files as metadata, and the answer form for an open request. An answered
 * request is read-only with the answer; a reader who may not edit issuers gets no form.
 */
export function RequestView({
  request,
  typeName,
  canAnswer,
  csrfToken,
}: {
  readonly request: RequestDetail;
  readonly typeName: string;
  readonly canAnswer: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.requests');
  const answered = request.state !== 'open' && request.answer !== null;
  const issuer =
    answered && request.answer?.issuerId != null
      ? request.activeIssuers.find((item) => item.issuerId === request.answer?.issuerId)
      : undefined;
  const reason =
    answered && request.answer?.reasonCode != null
      ? request.reasons.find((item) => item.code === request.answer?.reasonCode)
      : undefined;
  return (
    <div className="flex flex-col gap-4">
      <p>
        <a className="font-medium text-link underline" href="/certificates/issuer-requests">
          {t('back')}
        </a>
      </p>
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold wrap-anywhere">
          {request.storeName ?? t('seller-fallback')}{' '}
          <span className="text-base font-normal text-fg-muted">
            {t('seller-id', { id: shortId(request.sellerId) })}
          </span>
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span>{typeName}</span>
          <Badge tone={request.state === 'open' ? 'attention' : 'neutral'}>
            {t(`state.${request.state}`)}
          </Badge>
        </p>
      </header>

      <section
        aria-labelledby="rq-details"
        className="rounded-lg border border-line bg-surface p-4"
      >
        <h3 id="rq-details" className="mb-3 text-lg font-semibold">
          {t('details.title')}
        </h3>
        <dl className="flex flex-col gap-2">
          <Row label={t('details.typed')}>
            {request.typedIssuerName === null ? (
              <span className="text-fg-muted">{t('details.typed-gone')}</span>
            ) : (
              <>
                <span>{request.typedIssuerName}</span>
                <span className="block text-sm text-fg-muted">{t('details.typed-note')}</span>
              </>
            )}
          </Row>
          <Row label={t('details.sent')}>
            <When iso={request.createdAt} missing="-" />
          </Row>
          <Row label={t('details.files')}>
            {request.documents.length === 0 ? (
              t('details.no-files')
            ) : (
              <ul className="flex flex-col gap-1">
                {request.documents.map((doc, index) => (
                  <li key={doc.position ?? index}>
                    {t('details.file', {
                      n: (doc.position ?? index) + 1,
                      type: doc.mediaType === 'application/pdf' ? 'PDF' : (doc.mediaType ?? '?'),
                      pages: doc.pageCount ?? 0,
                      size: ((doc.byteSize ?? 0) / (1024 * 1024)).toFixed(1),
                    })}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </dl>
        {request.documents.length === 0 ? null : (
          <p className="mt-2 text-sm text-fg-muted">{t('details.files-note')}</p>
        )}
      </section>

      <section aria-labelledby="rq-answer" className="rounded-lg border border-line bg-surface p-4">
        <h3 id="rq-answer" className="mb-3 text-lg font-semibold">
          {t('answer.title')}
        </h3>
        {answered && request.answer !== null ? (
          <dl className="flex flex-col gap-2">
            <Row label={t('answer.outcome')}>{t(`state.${request.state}`)}</Row>
            {request.state === 'issuer-added' ? (
              <Row label={t('answer.answered-issuer')}>
                {issuer?.displayName ?? t('answer.issuer-gone')}
              </Row>
            ) : (
              <Row label={t('answer.answered-reason')}>
                {reason?.label ?? t('answer.reason-gone')}
              </Row>
            )}
            <Row label={t('answer.at')}>
              <When iso={request.answer.answeredAt} missing="-" />
            </Row>
          </dl>
        ) : canAnswer ? (
          <AnswerForm
            request={{
              issuerRequestId: request.issuerRequestId,
              version: request.version,
              activeIssuers: request.activeIssuers,
              reasons: request.reasons,
            }}
            csrfToken={csrfToken}
          />
        ) : (
          <p className="text-fg-muted">{t('answer.no-role')}</p>
        )}
      </section>
    </div>
  );
}
