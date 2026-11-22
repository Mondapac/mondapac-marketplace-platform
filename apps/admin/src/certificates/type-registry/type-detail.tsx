import { Badge, Banner } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { When } from '../../shared/when.tsx';
import { TypeActions, TypeProposalCard } from './type-actions.tsx';
import { TypeCreationCard } from './type-creation.tsx';
import { STATUS_TONE, type TypeContent, type TypeDetail } from './types.ts';

const DONE_NOTICES: ReadonlySet<string> = new Set([
  'deactivated',
  'reactivation-asked',
  'approved',
  'rejected',
  'withdrawn',
  'revision-published',
  'revision-pending',
  'proposed',
  'proposal-changed',
  'type-approved',
  'type-rejected',
  'type-withdrawn',
]);

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[14rem_1fr]">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 wrap-anywhere">{children}</dd>
    </div>
  );
}

/** The page of one certificate type: the published revision, what waits for a second admin, and for an editor what can be done. */
export function TypeDetailView({
  type,
  name,
  canEdit,
  canViewPolicy = false,
  csrfToken,
  done = null,
  accountId = '',
  hasActiveIssuer = null,
}: {
  readonly type: TypeDetail;
  readonly name: string;
  readonly canEdit: boolean;
  /** The admin may read the claim basis policy of this type. */
  readonly canViewPolicy?: boolean;
  readonly csrfToken: string;
  /** The notice after a change (`?done=`). */
  readonly done?: string | null;
  /** The signed-in admin, to tell the proposer of a new type from another admin. */
  readonly accountId?: string;
  /** For a proposed type that needs an issuer: whether one is active; null when unknown. */
  readonly hasActiveIssuer?: boolean | null;
}) {
  const t = useTranslations('certificates.types.detail');
  const tb = useTranslations('certificates.types.basis');
  const tm = useTranslations('certificates.types.mode');
  const locale = useLocale();
  const content: TypeContent = type.published.content;
  const yesNo = (value: boolean | undefined) =>
    value === undefined ? t('none') : t(value ? 'yes' : 'no');
  const locales = Object.entries(content.locales ?? {});
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold wrap-anywhere">{name}</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-fg-muted">{type.code}</span>
            <Badge tone={STATUS_TONE[type.status]}>{t(`status.${type.status}`)}</Badge>
            <span>{t('revision', { n: type.published.revisionNo })}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canEdit && (type.status === 'active' || type.status === 'inactive') ? (
            <a
              className="inline-flex items-center font-medium text-link underline"
              href={`/certificates/types/${type.typeId}/edit`}
            >
              {t('revise')}
            </a>
          ) : null}
          {canViewPolicy ? (
            <a
              className="inline-flex items-center font-medium text-link underline"
              href={`/certificates/types/${type.typeId}/policy`}
            >
              {t('policy')}
            </a>
          ) : null}
          {canEdit && (type.status === 'active' || type.status === 'inactive') ? (
            <TypeActions
              typeId={type.typeId}
              version={type.version}
              status={type.status}
              name={name}
              reactivationWaiting={type.pendingReactivation !== null}
              csrfToken={csrfToken}
            />
          ) : null}
        </div>
      </div>
      {done !== null && DONE_NOTICES.has(done) ? (
        <div role="status">
          <Banner tone="success">{t(`done.${done}`)}</Banner>
        </div>
      ) : null}
      {type.status === 'inactive' ? <Banner tone="info">{t('inactive-note')}</Banner> : null}
      {type.status === 'rejected' || type.status === 'withdrawn' ? (
        <Banner tone="info">{t(`closed-note.${type.status}`)}</Banner>
      ) : null}
      {type.status === 'proposed' ? (
        type.pendingCreation === null || type.pendingCreation === undefined ? (
          <Banner tone="info">{t('proposed-waiting')}</Banner>
        ) : (
          <TypeCreationCard
            typeId={type.typeId}
            proposal={type.pendingCreation}
            content={content}
            code={type.code}
            accountId={accountId}
            canEdit={canEdit}
            hasActiveIssuer={hasActiveIssuer}
            csrfToken={csrfToken}
          />
        )
      ) : null}
      {type.pendingRevision === null ? null : canEdit ? (
        <TypeProposalCard
          typeId={type.typeId}
          kind="revision"
          proposal={type.pendingRevision}
          csrfToken={csrfToken}
        />
      ) : (
        <Banner tone="info">{t('revision-waiting')}</Banner>
      )}
      {type.pendingReactivation === null ? null : canEdit ? (
        <TypeProposalCard
          typeId={type.typeId}
          kind="reactivation"
          proposal={type.pendingReactivation}
          csrfToken={csrfToken}
        />
      ) : (
        <Banner tone="info">{t('reactivation-waiting')}</Banner>
      )}
      {!canEdit && type.status !== 'rejected' && type.status !== 'withdrawn' ? (
        <p className="text-fg-muted">{t('view-only')}</p>
      ) : null}
      <dl className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <Row label={t('mode')}>
          {content.verificationMode === undefined
            ? t('none')
            : tm.has(content.verificationMode as never)
              ? tm(content.verificationMode as never)
              : content.verificationMode}
        </Row>
        <Row label={t('needs-issuer')}>{yesNo(content.requiresIssuerRegistry)}</Row>
        <Row label={t('needs-document')}>{yesNo(content.requiresDocument)}</Row>
        <Row label={t('needs-expiry')}>{yesNo(content.requiresExpiry)}</Row>
        <Row label={t('default-basis')}>
          {content.defaultBasis === undefined
            ? t('none')
            : tb.has(content.defaultBasis as never)
              ? tb(content.defaultBasis as never)
              : content.defaultBasis}
        </Row>
        {content.verificationMode === 'SELF_DECLARATION' ? (
          <Row label={t('auto-approve')}>{yesNo(content.autoApproveSelfDeclaration)}</Row>
        ) : null}
        <Row label={t('icon')}>{content.badgeIconKey ?? t('none')}</Row>
        <Row label={t('published')}>
          <When iso={type.published.createdAt} missing="-" />
        </Row>
      </dl>
      {locales.map(([code, text]) => (
        <section
          key={code}
          aria-labelledby={`type-locale-${code}`}
          lang={code}
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
        >
          <h3 id={`type-locale-${code}`} className="text-base font-semibold" lang={locale}>
            {t('locale', { locale: code })}
          </h3>
          <dl className="flex flex-col gap-2">
            <Row label={t('locale-name')}>{text.name ?? t('none')}</Row>
            <Row label={t('locale-description')}>{text.customerDescription ?? t('none')}</Row>
            <Row label={t('locale-terms')}>
              {text.claimTerms === undefined || text.claimTerms.length === 0 ? (
                t('none')
              ) : (
                <ul className="list-disc ps-5">
                  {text.claimTerms.map((term) => (
                    <li key={term}>{term}</li>
                  ))}
                </ul>
              )}
            </Row>
          </dl>
        </section>
      ))}
    </div>
  );
}
