import { Badge, Banner, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { shortId } from '../../shared/short-id.ts';
import { When } from '../../shared/when.tsx';
import { ChecksForm, DecisionForm, ScopeForm } from './review-forms.tsx';
import { type ReviewPage } from './types.ts';

const ISSUER_TONE: Readonly<Record<string, BadgeTone>> = {
  active: 'success',
  proposed: 'neutral',
  'closed-to-new': 'attention',
  derecognised: 'critical',
};

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-line bg-surface p-4">
      <h2 id={id} className="mb-3 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The review page of one submission (certificates design CA2). Read-only sections, then the
 * checks, the location and scope, and the decision. Plain text only: every value is shown as text.
 * `canReview` records checks and scope; `canDecide` (the protected approve permission) decides.
 */
export function ReviewView({
  page,
  typeName,
  canReview,
  canDecide,
  csrfToken,
}: {
  readonly page: ReviewPage;
  readonly typeName: string;
  readonly canReview: boolean;
  readonly canDecide: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.review');
  const queue = useTranslations('certificates.queue');
  const { certificate, submission } = page;
  const decided = !submission.pending;
  const missing = page.checks.filter((check) => check.required && check.result === null).length;
  const common = {
    certificateId: certificate.certificateId,
    submissionId: submission.submissionId,
    csrfToken,
  };
  return (
    <div className="flex flex-col gap-4">
      <p>
        <a className="font-medium text-link underline" href="/certificates">
          {t('back')}
        </a>
      </p>
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold wrap-anywhere">
          {page.business.storeName ?? t('seller-fallback')}{' '}
          <span className="text-base font-normal text-fg-muted">
            {t('seller-id', { id: shortId(certificate.sellerId) })}
          </span>
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span>{typeName}</span>
          <Badge tone="neutral">{queue(`kind.${submission.kind as 'initial'}`)}</Badge>
          <span>{queue('submission-no', { n: submission.submissionNo })}</span>
          <Badge tone="info">{certificate.status}</Badge>
        </p>
      </header>

      {decided ? <Banner tone="attention">{t('not-pending')}</Banner> : null}
      {submission.issuer?.state === 'closed-to-new' ? (
        <Banner tone="attention">{t('issuer-closed')}</Banner>
      ) : null}
      {submission.issuer?.state === 'derecognised' ? (
        <Banner tone="critical">{t('issuer-derecognised')}</Banner>
      ) : null}

      <Section id="rv-values" title={t('values.title')}>
        <dl className="flex flex-col gap-2">
          <Row label={t('values.issuer')}>
            {submission.issuer === null ? (
              <span className="text-fg-muted">{t('none')}</span>
            ) : (
              <>
                {submission.issuer.displayName}{' '}
                <Badge tone={ISSUER_TONE[submission.issuer.state] ?? 'neutral'}>
                  {t(`issuer-state.${submission.issuer.state as 'active'}`)}
                </Badge>
              </>
            )}
          </Row>
          <Row label={t('values.number')}>{submission.certificateNumber ?? t('none')}</Row>
          <Row label={t('values.issued')}>{submission.issueDate ?? t('none')}</Row>
          <Row label={t('values.expires')}>
            {submission.expiryDate === null ? (
              t('none')
            ) : (
              <>
                {submission.expiryDate}{' '}
                <span className="text-sm text-fg-muted">
                  {t('values.zone', { zone: submission.submittedZone })}
                </span>
              </>
            )}
          </Row>
          {submission.selfDeclared === null ? null : (
            <Row label={t('values.self-declared')}>
              {submission.selfDeclared ? t('yes') : t('no')}
              {submission.selfDeclarationNote === null ? null : (
                <span className="block text-sm">{submission.selfDeclarationNote}</span>
              )}
            </Row>
          )}
          <Row label={t('values.submitted')}>
            <When iso={submission.submittedAt} missing="-" />
          </Row>
        </dl>
      </Section>

      <Section id="rv-docs" title={t('documents.title')}>
        {page.documents.length === 0 ? (
          <p className="text-fg-muted">{t('documents.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {page.documents.map((doc, index) => (
              <li key={doc.position ?? index}>
                {t('documents.file', {
                  n: (doc.position ?? index) + 1,
                  type: doc.mediaType === 'application/pdf' ? 'PDF' : (doc.mediaType ?? '?'),
                  pages: doc.pageCount ?? 0,
                  size: ((doc.byteSize ?? 0) / (1024 * 1024)).toFixed(1),
                })}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-fg-muted">{t('documents.note')}</p>
      </Section>

      <Section id="rv-business" title={t('business.title')}>
        {page.business.status === 'ok' ? (
          <dl className="flex flex-col gap-2">
            <Row label={t('business.name')}>{page.business.businessName ?? t('none')}</Row>
            <Row label={t('business.store')}>{page.business.storeName ?? t('none')}</Row>
          </dl>
        ) : (
          <p className="text-fg-muted">{t(`business.${page.business.status}`)}</p>
        )}
      </Section>

      <Section id="rv-checks" title={t('checks.title')}>
        <ChecksForm {...common} checks={page.checks} canRecord={canReview && !decided} />
      </Section>

      <Section id="rv-scope" title={t('scope.title')}>
        {page.scope === null ? (
          <p className="mb-3 text-fg-muted">{t('scope.none')}</p>
        ) : (
          <dl className="mb-3 flex flex-col gap-2">
            <Row label={t('scope.location')}>{page.scope.location ?? t('none')}</Row>
            <Row label={t('scope.scope')}>{page.scope.scope ?? t('none')}</Row>
          </dl>
        )}
        {decided ? null : (
          <ScopeForm {...common} recorded={page.scope !== null} canRecord={canReview} />
        )}
      </Section>

      <Section id="rv-confirmation" title={t('confirmation.title')}>
        {page.confirmation === null ? (
          <p className="text-fg-muted">{t('confirmation.none')}</p>
        ) : (
          <p>{t('confirmation.done', { date: page.confirmation.confirmedOn })}</p>
        )}
      </Section>

      <Section id="rv-dups" title={t('duplicates.title')}>
        {page.duplicateHints.length === 0 ? (
          <p className="text-fg-muted">{t('duplicates.none')}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {page.duplicateHints.map((hint) => (
                <li key={`${hint.kind}-${hint.certificateId}`}>
                  <a
                    className="text-link underline wrap-anywhere"
                    href={`/certificates/${hint.certificateId}?reason=duplicate-hint`}
                  >
                    {t(`duplicates.${hint.kind}`, {
                      store: hint.storeName ?? t('seller-fallback'),
                    })}
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-fg-muted">{t('duplicates.hint')}</p>
          </>
        )}
      </Section>

      <Section id="rv-history" title={t('history.title')}>
        {page.history.length === 0 ? (
          <p className="text-fg-muted">{t('history.none')}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {page.history.map((entry, index) => (
              <li key={index} className="text-sm">
                {t('history.entry', {
                  from: entry.fromStatus ?? '-',
                  to: entry.toStatus,
                  by: entry.actorKind,
                })}{' '}
                <When iso={entry.occurredAt} missing="-" />
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section id="rv-decision" title={t('decision.heading')}>
        {page.decision !== null ? (
          <p>{t('decision.done', { outcome: page.decision.outcome })}</p>
        ) : decided ? (
          <p className="text-fg-muted">{t('decision.closed')}</p>
        ) : (
          <DecisionForm
            {...common}
            version={certificate.version}
            reasons={page.reasons}
            canDecide={canDecide}
            missingChecks={missing}
          />
        )}
      </Section>
    </div>
  );
}
