import { Banner } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { When } from '../../shared/when.tsx';
import { ExpertApproval, IssuerActions } from './issuer-actions.tsx';
import { IssuerStateBadge } from './state-badge.tsx';
import type { IssuerDetail } from './types.ts';

/** The page of one issuer: details, the expert approval and, for an editor, what can be done. */
export function IssuerDetailView({
  issuer,
  typeName,
  canEdit,
  csrfToken,
  activated = false,
}: {
  readonly activated?: boolean;
  readonly issuer: IssuerDetail;
  readonly typeName: string;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('certificates.issuers.detail');
  const rows: readonly [string, React.ReactNode][] = [
    [t('type'), typeName],
    [t('accreditation'), issuer.accreditationNumber ?? <span className="text-fg-muted">-</span>],
    [
      t('changed'),
      <span key="changed">
        <When iso={issuer.stateChangedAt} missing="-" />
        <span className="text-sm text-fg-muted">{t(`by.${issuer.stateChangedByKind}`)}</span>
      </span>,
    ],
    [
      t('expert'),
      <ExpertApproval
        key="expert"
        issuerId={issuer.issuerId}
        recorded={issuer.expertReferenceRecorded}
        canView={canEdit}
        csrfToken={csrfToken}
      />,
    ],
    [t('affected'), String(issuer.affectedCertificates)],
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold wrap-anywhere">{issuer.displayName}</h2>
          <IssuerStateBadge state={issuer.state} />
        </div>
        {canEdit ? (
          <IssuerActions
            issuer={{
              issuerId: issuer.issuerId,
              version: issuer.version,
              displayName: issuer.displayName,
              state: issuer.state,
            }}
            csrfToken={csrfToken}
          />
        ) : null}
      </div>
      {activated ? (
        <div role="status">
          <Banner tone="success">{t('activated')}</Banner>
        </div>
      ) : null}
      {issuer.state === 'proposed' ? <Banner tone="info">{t('name-note')}</Banner> : null}
      {issuer.pendingReactivation === null ? null : (
        <Banner tone="info">{t('reactivation-waiting')}</Banner>
      )}
      {!canEdit ? <p className="text-fg-muted">{t('view-only')}</p> : null}
      <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-[14rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-muted">{label}</dt>
            <dd className="min-w-0 wrap-anywhere">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
