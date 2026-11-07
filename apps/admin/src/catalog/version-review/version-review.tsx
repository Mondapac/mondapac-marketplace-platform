'use client';

import { Badge, Banner, Card } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { formatInstant } from '../../shared/format.ts';
import { REVISION_REASONS } from '../types.ts';
import { DecisionCard } from './decision.tsx';
import {
  attributeDiffs,
  attributeText,
  idDiffs,
  photoTiles,
  textDiffs,
  variantDiffs,
  type Change,
} from './diff.ts';
import { PhotoTiles } from './photos.tsx';
import type { RevisionImage, RevisionRead, RevisionVariant } from './types.ts';

const KNOWN_REASONS: ReadonlySet<string> = new Set(REVISION_REASONS);

/**
 * One product version against the published one (product version review design, screen 2): the
 * summary, then texts per locale, photos, categories and tax, variants and attributes in two
 * columns (stacked on phones; unchanged locales folded), and beside them the decision and the
 * history. A change is marked with a word and a sign, never by colour only. Price is not shown (D3).
 */
export function VersionReview({
  read,
  images,
  categoryNames,
  canDecide,
  csrfToken,
  nextHref,
}: {
  readonly read: RevisionRead;
  readonly images: readonly RevisionImage[];
  /** Category id to name in the panel locale; an unknown id shows as the id. */
  readonly categoryNames: Readonly<Record<string, string>>;
  readonly canDecide: boolean;
  readonly csrfToken: string;
  readonly nextHref: string | null;
}) {
  const t = useTranslations('catalog.version');
  const tq = useTranslations('catalog.queue');
  const locale = useLocale();
  const { revision, published } = read;
  const name =
    revision.texts[locale]?.name ?? Object.values(revision.texts)[0]?.name ?? read.productCode;
  const texts = textDiffs(revision, published, locale);
  const tiles = photoTiles(images, published?.imageIds ?? null);
  const removedPhotos = idDiffs(revision.imageIds, published?.imageIds ?? null).filter(
    (row) => row.change === 'removed',
  ).length;
  const categories = idDiffs(revision.categoryIds, published?.categoryIds ?? null);
  const variants = variantDiffs(revision, published);
  const attributes = attributeDiffs(revision, published);
  const taxChanged = published !== null && published.taxCategoryCode !== revision.taxCategoryCode;
  const categoryName = (id: string) => categoryNames[id] ?? id;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="break-words text-2xl font-semibold">{name}</h1>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Fact label={t('summary.seller')}>{read.storeName ?? tq('filter.seller-unnamed')}</Fact>
          <Fact label={t('summary.code')}>{read.productCode}</Fact>
          <Fact label={t('summary.revision')}>
            {t('summary.revision-no', { number: revision.revisionNo })}
          </Fact>
          <Fact label={t('summary.submitted')}>{formatInstant(revision.submittedAt, locale)}</Fact>
        </dl>
        <ul className="flex flex-wrap gap-1" aria-label={t('summary.reasons')}>
          <li>
            <Badge tone={read.firstPublication ? 'info' : 'neutral'}>
              {tq(read.firstPublication ? 'change.new' : 'change.update')}
            </Badge>
          </li>
          <li>
            <Badge tone={read.state === 'pending' ? 'attention' : 'neutral'}>
              {t(`state.${read.state}`)}
            </Badge>
          </li>
          {read.reasons.map((reason) => (
            <li key={reason}>
              <Badge tone="neutral">
                {KNOWN_REASONS.has(reason) ? tq(`reason.${reason}`) : reason}
              </Badge>
            </li>
          ))}
        </ul>
        {read.warnings.length === 0 ? null : (
          <Banner tone="attention" title={t('warning.title')}>
            <ul className="list-disc ps-5">
              {read.warnings.map((code) => (
                <li key={code}>
                  {code === 'gtin.duplicate-platform' || code === 'gtin.duplicate'
                    ? t(`warning.${code.replace('.', '-')}`)
                    : code}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {read.state === 'pending' ? null : <Banner tone="info">{t(`closed.${read.state}`)}</Banner>}
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title={t('section.texts')}>
            {texts.map((group) => {
              const body = (
                <div className="flex flex-col gap-4">
                  {group.rows.map((row) => (
                    <DiffPair
                      key={row.field}
                      label={t(`field.${row.field}`)}
                      change={row.change}
                      before={row.before}
                      after={row.after}
                      first={published === null}
                    />
                  ))}
                </div>
              );
              return group.changed ? (
                <section key={group.locale} className="flex flex-col gap-3">
                  <h3 className="font-medium">
                    {group.locale} <Badge tone="info">{t('mark.changed')}</Badge>
                  </h3>
                  {body}
                </section>
              ) : (
                <details key={group.locale} className="rounded-md border border-line p-3">
                  <summary className="min-h-12 cursor-pointer content-center font-medium lg:min-h-0">
                    {t('unchanged-locale', { locale: group.locale })}
                  </summary>
                  <div className="mt-3">{body}</div>
                </details>
              );
            })}
          </Card>

          <Card title={t('section.photos')}>
            <PhotoTiles
              productId={read.productId}
              tiles={tiles}
              removed={removedPhotos}
              canDecide={canDecide}
              csrfToken={csrfToken}
            />
          </Card>

          <Card title={t('section.categories')}>
            <ul className="flex flex-col gap-1">
              {categories.map((row) => (
                <li key={row.id}>
                  <Marked change={published === null ? 'same' : row.change}>
                    {categoryName(row.id)}
                  </Marked>
                </li>
              ))}
            </ul>
            <DiffPair
              label={t('field.tax-category')}
              change={taxChanged ? 'changed' : 'same'}
              before={published?.taxCategoryCode ?? null}
              after={revision.taxCategoryCode}
              first={published === null}
            />
          </Card>

          <Card title={t('section.variants')}>
            {variants.length === 0 ? (
              <p className="text-fg-muted">{t('variants.none')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {variants.map((row) => (
                  <li key={row.variantId} className="rounded-md border border-line p-3">
                    <Marked change={published === null ? 'same' : row.change}>
                      {variantLabel((row.after ?? row.before)!, locale) || t('variants.single')}
                    </Marked>
                    <VariantFacts
                      before={row.change === 'changed' ? row.before : null}
                      after={row.after ?? row.before!}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {attributes.length === 0 ? null : (
            <Card title={t('section.attributes')}>
              <div className="flex flex-col gap-4">
                {attributes.map((row) => (
                  <DiffPair
                    key={row.code}
                    label={row.code}
                    change={published === null ? 'added' : row.change}
                    before={row.before === null ? null : attributeText(row.before, locale)}
                    after={row.after === null ? null : attributeText(row.after, locale)}
                    first={published === null}
                  />
                ))}
              </div>
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-6" aria-label={t('side')}>
          {read.state === 'pending' ? (
            <DecisionCard
              productId={read.productId}
              revisionId={revision.revisionId}
              version={read.version}
              requiredChecks={read.requiredChecks}
              canDecide={canDecide}
              csrfToken={csrfToken}
              nextHref={nextHref}
            />
          ) : null}
          <History read={read} />
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** A line with its change in words and a sign: + added, − removed, ~ changed. */
function Marked({ change, children }: { readonly change: Change; readonly children: ReactNode }) {
  const t = useTranslations('catalog.version.mark');
  if (change === 'same') return <span>{children}</span>;
  const sign = change === 'added' ? '+' : change === 'removed' ? '−' : '~';
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <span
        className={
          change === 'removed' ? 'line-through' : change === 'added' ? 'underline' : undefined
        }
      >
        <span aria-hidden="true">{sign} </span>
        {children}
      </span>
      <Badge tone={change === 'removed' ? 'critical' : 'info'}>{t(change)}</Badge>
    </span>
  );
}

/**
 * Published and This version side by side from 640 px, stacked below; an unchanged value shows
 * once. The old value is struck through with −, the new one underlined with +.
 */
function DiffPair({
  label,
  change,
  before,
  after,
  first,
}: {
  readonly label: string;
  readonly change: Change;
  readonly before: string | null;
  readonly after: string | null;
  /** A first publication: there is no published side. */
  readonly first: boolean;
}) {
  const t = useTranslations('catalog.version');
  const empty = <span className="text-fg-muted">{t('empty-value')}</span>;
  if (first || change === 'same') {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-fg-muted">{label}</div>
        <div className="whitespace-pre-wrap break-words">{after ?? empty}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-muted">
        {label} <Badge tone="info">{t(`mark.${change}`)}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-muted p-3">
          <div className="mb-1 text-xs font-medium text-fg-muted">{t('published')}</div>
          <div className="whitespace-pre-wrap break-words">
            {before === null ? (
              empty
            ) : (
              <span className="line-through">
                <span aria-hidden="true">− </span>
                <span className="sr-only">{t('removed-text')} </span>
                {before}
              </span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-line p-3">
          <div className="mb-1 text-xs font-medium text-fg-muted">{t('this-version')}</div>
          <div className="whitespace-pre-wrap break-words">
            {after === null ? (
              empty
            ) : (
              <span className="underline">
                <span aria-hidden="true">+ </span>
                <span className="sr-only">{t('added-text')} </span>
                {after}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function variantLabel(variant: RevisionVariant, locale: string): string {
  return (
    variant.labels[locale] ??
    (Object.values(variant.optionValues).join(' / ') || Object.values(variant.labels)[0] || '')
  );
}

function VariantFacts({
  before,
  after,
}: {
  readonly before: RevisionVariant | null;
  readonly after: RevisionVariant;
}) {
  const t = useTranslations('catalog.version.variants');
  const facts = (variant: RevisionVariant) =>
    [
      variant.gtin === null ? null : t('gtin', { gtin: variant.gtin }),
      variant.shippingWeightGrams === null
        ? null
        : t('weight', { grams: variant.shippingWeightGrams }),
      variant.imageIds.length === 0 ? null : t('photos', { count: variant.imageIds.length }),
    ].filter((fact): fact is string => fact !== null);
  const now = facts(after).join(' · ');
  const old = before === null ? null : facts(before).join(' · ');
  return (
    <div className="mt-1 text-sm text-fg-muted">
      {old === null || old === now ? (
        now
      ) : (
        <>
          <div className="line-through">
            <span aria-hidden="true">− </span>
            {old || t('nothing')}
          </div>
          <div className="underline">
            <span aria-hidden="true">+ </span>
            {now || t('nothing')}
          </div>
        </>
      )}
    </div>
  );
}

/** The product's versions, newest first, with who sent each and what became of it. */
function History({ read }: { readonly read: RevisionRead }) {
  const t = useTranslations('catalog.version.history');
  const td = useTranslations('catalog.version.decision');
  const locale = useLocale();
  const reasonLabel = (code: string) =>
    td.has(`reason-code.${code}`) ? td(`reason-code.${code}`) : code;
  return (
    <Card title={t('title')}>
      {read.history.length === 0 ? (
        <p className="text-fg-muted">{t('none')}</p>
      ) : (
        <ol className="flex flex-col gap-3 border-s-2 border-line ps-4">
          {read.history.map((entry) => (
            <li key={entry.revisionId} className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium">
                {t('entry', { number: entry.revisionNo })}
                {entry.revisionId === read.revision.revisionId ? ` · ${t('this')}` : ''}
              </span>
              <span className="text-fg-muted">
                {t('sent', {
                  kind: t.has(`kind.${entry.kind}`) ? t(`kind.${entry.kind}`) : entry.kind,
                  author: t.has(`author.${entry.authorKind}`)
                    ? t(`author.${entry.authorKind}`)
                    : entry.authorKind,
                  at: formatInstant(entry.submittedAt, locale),
                })}
              </span>
              {entry.decision === null ? (
                <span>{t('waiting')}</span>
              ) : (
                <span>
                  {t.has(`outcome.${entry.decision.outcome}`)
                    ? t(`outcome.${entry.decision.outcome}`)
                    : entry.decision.outcome}
                  {entry.decision.reasonCode === null
                    ? ''
                    : ` · ${t('reason', { reason: reasonLabel(entry.decision.reasonCode) })}`}
                  {` · ${formatInstant(entry.decision.decidedAt, locale)}`}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
