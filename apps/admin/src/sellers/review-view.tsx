import { Badge, type BadgeTone } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { formatInstant, known } from './format.ts';
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

/** An address field key (`line1`, `postal_code`) as words; the Market decides which keys exist. */
function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

function addressText(address: Readonly<Record<string, string>> | null): string | null {
  if (address === null) return null;
  const lines = Object.entries(address)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${fieldLabel(key)}: ${value}`);
  return lines.length === 0 ? null : lines.join('\n');
}

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
          : `${content.identifier.scheme} ${content.identifier.display}`,
    },
    { label: t('sellers.review.field.phone'), value: content.phone },
    { label: t('sellers.review.field.contact-email'), value: content.contactEmail },
    { label: t('sellers.review.field.address'), value: addressText(content.address) },
    {
      label: t('sellers.review.field.registered-address'),
      value: addressText(content.registeredAddress),
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
  t,
  heading,
  revision,
  against,
}: {
  readonly t: Translate;
  readonly heading: string;
  readonly revision: ReviewRevision;
  /** The approved revision to mark changed fields against, when shown beside a change. */
  readonly against: ReviewRevision | null;
}) {
  const rows = contentRows(t, revision.content);
  const before = against === null ? null : contentRows(t, against.content);
  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="mb-1 text-lg font-semibold">{heading}</h2>
      <p className="mb-3 text-sm text-fg-muted">
        {t('sellers.review.revision-line', {
          kind: t(`sellers.review.kind.${known(revision.kind, KINDS)}`),
          no: revision.revisionNo,
          when: formatInstant(revision.createdAt),
        })}{' '}
        <Badge tone="neutral">
          {t(`sellers.review.revision-status.${known(revision.status, REVISION_STATUSES)}`)}
        </Badge>
      </p>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
        {rows.map((row, index) => {
          const changed = before !== null && before[index]?.value !== row.value;
          return (
            <div key={row.label} className="contents">
              <dt className="text-fg-muted">{row.label}</dt>
              <dd className="whitespace-pre-line break-words font-medium">
                {row.value ?? '-'}
                {changed ? (
                  <span className="ms-2">
                    <Badge tone="info">{t('sellers.review.changed')}</Badge>
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
        <div className="contents">
          <dt className="text-fg-muted">{t('sellers.review.field.service-area')}</dt>
          <dd className="font-medium">{revision.serviceAreaCode}</dd>
        </div>
        <div className="contents">
          <dt className="text-fg-muted">{t('sellers.review.field.timezone')}</dt>
          <dd className="font-medium">{revision.operatingTimezone}</dd>
        </div>
      </dl>
    </section>
  );
}

function RegisterPanel({ t, review }: { readonly t: Translate; readonly review: ReviewRead }) {
  const { register, current } = review;
  const snapshot = current.registerAtSubmission;
  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="mb-3 text-lg font-semibold">{t('sellers.review.register.title')}</h2>
      {register.lookup === 'none' ? (
        <p className="mb-3 text-fg-muted">{t('sellers.review.register.none')}</p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
        <div className="contents">
          <dt className="text-fg-muted">{t('sellers.review.register.state')}</dt>
          <dd className="font-medium">
            {t(`sellers.review.register.state-value.${known(register.state, REGISTER_STATES)}`)}
          </dd>
        </div>
        <div className="contents">
          <dt className="text-fg-muted">{t('sellers.review.register.checked')}</dt>
          <dd className="font-medium">{formatInstant(register.checkedAt)}</dd>
        </div>
        {register.mismatches.length > 0 ? (
          <div className="contents">
            <dt className="text-fg-muted">{t('sellers.review.register.mismatches')}</dt>
            <dd className="font-medium">
              {register.mismatches
                .map((flag) => t(`sellers.review.register.mismatch.${known(flag, MISMATCHES)}`))
                .join(', ')}
            </dd>
          </div>
        ) : null}
        <div className="contents">
          <dt className="text-fg-muted">{t('sellers.review.register.at-submission')}</dt>
          <dd className="font-medium">
            {t(`sellers.review.register.outcome.${known(snapshot.outcome, SNAPSHOT_OUTCOMES)}`)}
          </dd>
        </div>
        <div className="contents">
          <dt className="text-fg-muted">{t('sellers.review.register.approval')}</dt>
          <dd className="font-medium">
            {register.blocksApproval
              ? t('sellers.review.register.blocks')
              : t('sellers.review.register.clear')}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** One seller application for a reviewer, read only: access state, the revision, the register. */
export async function ReviewView({ review }: { readonly review: ReviewRead }) {
  const t = await getTranslations();
  const access = known(review.access, ACCESS);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="break-words text-2xl font-semibold">{review.current.content.storeName}</h1>
        <Badge tone={ACCESS_TONE[access] ?? 'neutral'}>
          {t(`sellers.review.access.${access}`)}
        </Badge>
      </div>
      <p className="text-sm text-fg-muted">{t('sellers.review.read-only')}</p>
      <Revision
        t={t}
        heading={t(
          review.previous === null ? 'sellers.review.under-review' : 'sellers.review.proposed',
        )}
        revision={review.current}
        against={review.previous}
      />
      {review.previous === null ? null : (
        <Revision
          t={t}
          heading={t('sellers.review.approved-revision')}
          revision={review.previous}
          against={null}
        />
      )}
      <RegisterPanel t={t} review={review} />
      <p>
        <a className="font-medium text-link underline" href="/sellers">
          {t('sellers.review.back')}
        </a>
      </p>
    </div>
  );
}
