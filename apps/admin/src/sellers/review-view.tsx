import { BackLink, Badge, Card, DataList, type BadgeTone } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatInstant } from '../shared/format.ts';
import { addressLines, areaName, known } from './format.ts';
import { DecisionPanel } from './decision-panel.tsx';
import type { ReviewContent, ReviewRead, ReviewRevision } from './review-types.ts';

type Translate = Awaited<ReturnType<typeof getTranslations>>;

const ACCESS = ['pending', 'approved', 'rejected', 'suspended'];
const KINDS = ['onboarding', 'identity-change'];
const REVISION_STATUSES = ['pending', 'approved', 'rejected', 'superseded', 'withdrawn'];
const REGISTER_STATES = ['not-performed', 'active', 'negative', 'unavailable', 'stale'];
const SNAPSHOT_OUTCOMES = ['not-performed', 'active', 'not-found', 'cancelled', 'unavailable'];
const MISMATCHES = ['business-name', 'indirect-tax-registration', 'postcode'];

const ACCESS_TONE: Record<string, BadgeTone> = {
  approved: 'success',
  pending: 'attention',
  rejected: 'critical',
  suspended: 'critical',
};

interface Row {
  readonly label: string;
  readonly value: string | null;
  readonly previous?: string | null;
}

function contentRows(t: Translate, content: ReviewContent): Row[] {
  return [
    { label: t('sellers.review.field.store-name'), value: content.storeName },
    { label: t('sellers.review.field.business-name'), value: content.businessName },
    {
      label: t('sellers.review.field.identifier'),
      value:
        content.identifier === null
          ? null
          : // Schemes are acronyms (ABN, NZBN, VAT): shown in capitals.
            `${content.identifier.scheme.toUpperCase()} ${content.identifier.display}`,
    },
    { label: t('sellers.review.field.phone'), value: content.phone },
    { label: t('sellers.review.field.contact-email'), value: content.contactEmail },
    { label: t('sellers.review.field.address'), value: addressLines(content.address) },
    {
      label: t('sellers.review.field.registered-address'),
      value: addressLines(content.registeredAddress),
    },
    {
      label: t('sellers.review.field.indirect-tax'),
      value:
        content.registeredForIndirectTax === null
          ? null
          : t(`sellers.review.yes-no.${content.registeredForIndirectTax ? 'yes' : 'no'}`),
    },
  ];
}

function Revision({
  locale,
  t,
  heading,
  revision,
  against,
}: {
  readonly t: Translate;
  readonly locale: string;
  readonly heading: string;
  readonly revision: ReviewRevision;
  /** The approved revision to mark changed fields against, when shown beside a change. */
  readonly against: ReviewRevision | null;
}) {
  const rows = contentRows(t, revision.content);
  const before = against === null ? null : contentRows(t, against.content);
  return (
    <Card title={heading}>
      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        {t('sellers.review.revision-line', {
          kind: t(`sellers.review.kind.${known(revision.kind, KINDS)}`),
          no: revision.revisionNo,
          when: formatInstant(revision.createdAt, locale),
        })}
        <Badge tone="neutral">
          {t(`sellers.review.revision-status.${known(revision.status, REVISION_STATUSES)}`)}
        </Badge>
      </p>
      <DataList
        rows={[
          ...rows.map((row, index) => {
            const changed = before !== null && before[index]?.value !== row.value;
            return {
              label: row.label,
              value:
                row.value === null && !changed ? null : (
                  <>
                    {row.value ?? (
                      <span className="font-normal text-fg-muted">
                        {t('sellers.review.not-given')}
                      </span>
                    )}
                    {changed ? (
                      <span className="ms-2">
                        <Badge tone="info">{t('sellers.review.changed')}</Badge>
                      </span>
                    ) : null}
                  </>
                ),
            };
          }),
          {
            label: t('sellers.review.field.service-area'),
            value: areaName(revision.serviceAreaCode),
          },
          { label: t('sellers.review.field.timezone'), value: revision.operatingTimezone },
        ]}
        missing={t('sellers.review.not-given')}
      />
    </Card>
  );
}

function RegisterPanel({
  t,
  locale,
  review,
}: {
  readonly t: Translate;
  readonly locale: string;
  readonly review: ReviewRead;
}) {
  const { register, current } = review;
  const snapshot = current.registerAtSubmission;
  return (
    <Card title={t('sellers.review.register.title')}>
      {register.lookup === 'none' ? (
        <p className="text-fg-muted">{t('sellers.review.register.none')}</p>
      ) : null}
      <DataList
        rows={[
          {
            label: t('sellers.review.register.state'),
            value: t(
              `sellers.review.register.state-value.${known(register.state, REGISTER_STATES)}`,
            ),
          },
          {
            label: t('sellers.review.register.checked'),
            value: register.checkedAt === null ? null : formatInstant(register.checkedAt, locale),
          },
          ...(register.mismatches.length > 0
            ? [
                {
                  label: t('sellers.review.register.mismatches'),
                  value: register.mismatches
                    .map((flag) => t(`sellers.review.register.mismatch.${known(flag, MISMATCHES)}`))
                    .join(', '),
                },
              ]
            : []),
          {
            label: t('sellers.review.register.at-submission'),
            value: t(
              `sellers.review.register.outcome.${known(snapshot.outcome, SNAPSHOT_OUTCOMES)}`,
            ),
          },
          {
            label: t('sellers.review.register.approval'),
            value: register.blocksApproval
              ? t('sellers.review.register.blocks')
              : t('sellers.review.register.clear'),
          },
        ]}
        missing={t('sellers.review.not-given')}
      />
    </Card>
  );
}

/** One seller application for a reviewer, read only: access state, the revision, the register. */
export async function ReviewView({
  review,
  decide,
}: {
  readonly review: ReviewRead;
  /** What the session may do about a pending application; absent for a read-only page. */
  readonly decide?: {
    readonly canDecide: boolean;
    readonly canCheck: boolean;
    readonly csrfToken: string;
  };
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  const access = known(review.access, ACCESS);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-2">
        <BackToSellers label={t('sellers.review.back')} />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="break-words text-2xl font-semibold">{review.current.content.storeName}</h1>
          <Badge tone={ACCESS_TONE[access] ?? 'neutral'}>
            {t(`sellers.review.access.${access}`)}
          </Badge>
        </div>
      </div>
      <p className="text-sm text-fg-muted">{t('sellers.review.read-only')}</p>
      <Revision
        t={t}
        locale={locale}
        heading={t(
          review.previous === null ? 'sellers.review.under-review' : 'sellers.review.proposed',
        )}
        revision={review.current}
        against={review.previous}
      />
      {review.previous === null ? null : (
        <Revision
          t={t}
          locale={locale}
          heading={t('sellers.review.approved-revision')}
          revision={review.previous}
          against={null}
        />
      )}
      <RegisterPanel t={t} locale={locale} review={review} />
      {decide !== undefined &&
      review.access === 'pending' &&
      (decide.canDecide || decide.canCheck) ? (
        <DecisionPanel
          sellerId={review.sellerId}
          revisionId={review.current.id}
          register={review.register}
          decisionInProgress={review.decisionInProgress}
          canDecide={decide.canDecide}
          canCheck={decide.canCheck}
          csrfToken={decide.csrfToken}
        />
      ) : null}
    </div>
  );
}

/** The way back to the list, above the page heading. */
export function BackToSellers({ label }: { readonly label: string }) {
  return <BackLink href="/sellers" label={label} />;
}
