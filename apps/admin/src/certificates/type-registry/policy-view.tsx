import { Badge, Banner } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { When } from '../../shared/when.tsx';
import { PolicyForm, type CategoryChoice } from './policy-form.tsx';
import { TypeProposalCard } from './type-actions.tsx';
import { POLICY_HANDLINGS, type PolicyDetail, type PolicyRow } from './types.ts';

const DONE_NOTICES: ReadonlySet<string> = new Set([
  'published',
  'pending',
  'approved',
  'rejected',
  'withdrawn',
]);

/** The page of the claim basis policy of one type (certificates design CA8). */
export function PolicyView({
  policy,
  categories,
  categoriesLoaded,
  canEdit,
  csrfToken,
  done = null,
  request = null,
}: {
  readonly policy: PolicyDetail;
  readonly categories: readonly CategoryChoice[];
  /** False when the category list could not be read: rows still show, the form is not offered. */
  readonly categoriesLoaded: boolean;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** The notice after a change (`?done=`). */
  readonly done?: string | null;
  /** The number of the System request a save opened (`?sr=`). */
  readonly request?: number | null;
}) {
  const t = useTranslations('certificates.types.policy');
  const tb = useTranslations('certificates.types.basis');
  const basis = (value: string) => (tb.has(value as never) ? tb(value as never) : value);
  const names = new Map(categories.map((category) => [category.id, category.name]));
  const rowName = (row: PolicyRow) =>
    row.selector === 'handling'
      ? (POLICY_HANDLINGS as readonly string[]).includes(row.handling ?? '')
        ? t(`handling.${row.handling}` as never)
        : (row.handling ?? '-')
      : (names.get(row.categoryId ?? '') ?? row.categoryId ?? '-');
  const rowNames: Record<string, string> = {};
  for (const category of categories) rowNames[`row:${category.id}`] = category.name;
  for (const value of POLICY_HANDLINGS) rowNames[`row:${value}`] = t(`handling.${value}`);
  const published = policy.published?.rows ?? [];
  const pending = policy.pendingRevision;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold wrap-anywhere">
          {t('heading', { code: policy.typeCode })}
        </h2>
        <p className="text-sm text-fg-muted">
          {policy.published === null
            ? t('never-saved')
            : t('revision', { n: policy.published.revisionNo })}
        </p>
      </div>
      {done !== null && DONE_NOTICES.has(done) ? (
        <div role="status" className="flex flex-col gap-2">
          <Banner tone="success">{t(`done.${done}` as never)}</Banner>
          {request === null ? null : (
            <Banner tone="info">{t('done.sent', { number: request })}</Banner>
          )}
        </div>
      ) : null}
      <p className="text-sm">
        <span className="text-fg-muted">{t('default')}: </span>
        {basis(policy.defaultBasis)}
        <span className="text-fg-muted"> · {t('default-help')}</span>
      </p>
      {pending === null ? null : canEdit ? (
        <TypeProposalCard
          typeId={policy.typeId}
          kind="policy"
          proposal={pending.proposal}
          csrfToken={csrfToken}
          rowNames={rowNames}
        />
      ) : (
        <Banner tone="info">{t('waiting')}</Banner>
      )}
      <section
        aria-labelledby="policy-rows"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <h3 id="policy-rows" className="text-base font-semibold">
          {t('published-rows')}
        </h3>
        {published.length === 0 ? (
          <p className="text-fg-muted">{t('no-rows')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {published.map((row) => (
              <li
                key={row.selector === 'handling' ? `h:${row.handling}` : `c:${row.categoryId}`}
                className="flex flex-wrap items-baseline gap-x-3 wrap-anywhere"
              >
                <span className="font-medium">{rowName(row)}</span>
                <span>{basis(row.basis)}</span>
                <span className="text-sm text-fg-muted">
                  {row.selector === 'handling' ? t('kind.handling') : t('kind.category')}
                </span>
              </li>
            ))}
          </ul>
        )}
        {policy.published?.reason?.state === 'given' &&
        policy.published.reason.text !== undefined ? (
          <p className="wrap-anywhere">
            <span className="text-fg-muted">{t('reason')}: </span>
            {policy.published.reason.text}
          </p>
        ) : null}
      </section>
      {canEdit && pending === null ? (
        categoriesLoaded ? (
          <section
            aria-labelledby="policy-change"
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          >
            <h3 id="policy-change" className="text-base font-semibold">
              {t('change')}
            </h3>
            <PolicyForm
              typeId={policy.typeId}
              version={policy.version}
              published={published}
              categories={categories}
              reviewed={policy.review.reviewed}
              csrfToken={csrfToken}
            />
          </section>
        ) : (
          <Banner tone="attention">{t('categories-unavailable')}</Banner>
        )
      ) : null}
      {!canEdit ? <p className="text-fg-muted">{t('view-only')}</p> : null}
      {policy.history.length === 0 ? null : (
        <section aria-labelledby="policy-history" className="flex flex-col gap-2">
          <h3 id="policy-history" className="text-base font-semibold">
            {t('history')}
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {policy.history.map((entry) => (
              <li key={entry.revisionId} className="flex flex-wrap items-center gap-x-3">
                <span className="font-medium">{t('revision', { n: entry.revisionNo })}</span>
                <When iso={entry.createdAt} missing="-" />
                {entry.published ? null : <Badge tone="attention">{t('not-published')}</Badge>}
                {entry.reasonGiven ? (
                  <span className="text-fg-muted">{t('has-reason')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
