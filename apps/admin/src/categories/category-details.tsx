'use client';

import { Badge, Banner, EmptyState, LoadError, SkeletonRows, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { When } from '../shared/when.tsx';
import { directionOf } from './tree-model.ts';
import {
  API_CATEGORIES,
  DETAIL_TABS,
  type CategoryStatus,
  type DetailBody,
  type DetailTab,
  type ImpactBody,
} from './types.ts';

type Load = 'loading' | 'ready' | 'failed' | 'missing';

const STATUS_TONE: Record<CategoryStatus, 'success' | 'neutral' | 'attention'> = {
  active: 'success',
  merged: 'attention',
  archived: 'neutral',
};

/** A count, "at least" when the API stopped counting at its time bound. */
function useCount(complete: boolean) {
  const t = useTranslations('categories');
  return (n: number) => (complete ? String(n) : t('at-least', { n }));
}

/**
 * One category: its path, names, status and counts (Details), the products and Offers a change
 * would reach (Products) and its revisions (History). Read only. A category that is gone, or that
 * belongs to another Market, reads as "not found" and nothing more.
 */
export function CategoryDetails({
  id,
  canEdit,
}: {
  readonly id: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations('categories');
  const tl = useTranslations('load');
  const [tab, setTab] = useState<DetailTab>('details');
  const [load, setLoad] = useState<Load>('loading');
  const [body, setBody] = useState<DetailBody | null>(null);
  const latest = useRef(0);

  const fetchDetail = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const result = await callApi<DetailBody>('GET', `${API_CATEGORIES}/${id}`);
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setBody(null);
      setLoad(result.failure.status === 404 ? 'missing' : 'failed');
      return;
    }
    setBody(result.body);
    setLoad('ready');
  }, [id]);

  useEffect(() => {
    setTab('details');
    void fetchDetail();
  }, [fetchDetail]);

  if (load === 'loading') return <SkeletonRows label={t('details.loading')} rows={4} />;
  if (load === 'missing') return <EmptyState icon="layout" title={t('details.missing')} />;
  if (load === 'failed' || body === null) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
        message={t('details.load-error')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchDetail()}
      />
    );
  }

  const { category } = body;
  // The first required locale is the Market's default: the title is the name in it.
  const titleLocale = body.requiredLocales[0] ?? '';
  const title = category.names.find((entry) => entry.locale === titleLocale)?.name ?? category.slug;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 dir={directionOf(titleLocale)} className="text-xl font-semibold">
          {title}
        </h2>
        <p className="text-sm text-fg-muted">
          {body.path.map((entry) => entry.name ?? entry.slug).join(' › ')}
        </p>
      </div>
      <Tabs
        label={t('details.tabs')}
        items={DETAIL_TABS.map((value) => ({ id: value, label: t(`details.tab.${value}`) }))}
        activeId={tab}
        onSelect={(value) => setTab(value as DetailTab)}
      />
      {tab === 'details' ? <DetailsTab body={body} canEdit={canEdit} /> : null}
      {tab === 'products' ? <ProductsTab body={body} /> : null}
      {tab === 'history' ? <HistoryTab body={body} /> : null}
    </div>
  );
}

function Row({ term, children }: { readonly term: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line py-2 sm:flex-row sm:gap-4">
      <dt className="text-sm text-fg-muted sm:w-40 sm:shrink-0">{term}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  );
}

function DetailsTab({ body, canEdit }: { readonly body: DetailBody; readonly canEdit: boolean }) {
  const t = useTranslations('categories');
  const { category } = body;
  const count = useCount(body.complete);
  const nameOfLocale = new Map(category.names.map((entry) => [entry.locale, entry.name]));
  const locales = [
    ...body.requiredLocales,
    ...category.names.map((entry) => entry.locale).filter((l) => !body.requiredLocales.includes(l)),
  ];
  return (
    <div className="flex flex-col gap-3">
      {canEdit ? null : <Banner tone="info">{t('view-only')}</Banner>}
      {body.missingLocales.length > 0 ? (
        <Banner tone="attention">
          {t('details.missing-locales', { locales: body.missingLocales.join(', ') })}
        </Banner>
      ) : null}
      <dl className="m-0">
        <Row term={t('details.status')}>
          <Badge tone={STATUS_TONE[category.status]}>{t(`status.${category.status}`)}</Badge>
        </Row>
        <Row term={t('details.slug')}>
          <code>{category.slug}</code>
        </Row>
        {locales.map((code) => (
          <Row key={code} term={t('details.name-in', { locale: code })}>
            {nameOfLocale.has(code) ? (
              <span dir={directionOf(code)}>{nameOfLocale.get(code)}</span>
            ) : (
              <span className="text-fg-muted">{t('details.name-missing')}</span>
            )}
          </Row>
        ))}
        <Row term={t('details.live-products')}>{count(category.counts.liveProducts)}</Row>
        <Row term={t('details.live-products-direct')}>
          {count(category.counts.liveProductsDirect)}
        </Row>
        <Row term={t('details.offers')}>{count(category.counts.offers)}</Row>
        <Row term={t('details.version')}>{category.version}</Row>
      </dl>
    </div>
  );
}

function ProductsTab({ body }: { readonly body: DetailBody }) {
  const t = useTranslations('categories');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [impact, setImpact] = useState<ImpactBody | null>(null);
  const id = body.category.id;

  const fetchImpact = useCallback(async () => {
    setLoad('loading');
    const result = await callApi<ImpactBody>(
      'GET',
      `${API_CATEGORIES}/${id}/impact?action=archive`,
    );
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setLoad('failed');
      return;
    }
    setImpact(result.body);
    setLoad('ready');
  }, [id]);

  useEffect(() => {
    void fetchImpact();
  }, [fetchImpact]);

  const count = useCount(impact?.complete ?? true);
  if (load === 'loading') return <SkeletonRows label={t('details.loading')} rows={3} />;
  if (load === 'failed' || impact === null) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
        message={t('products.load-error')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchImpact()}
      />
    );
  }
  if (impact.products === 0) return <EmptyState icon="package" title={t('products.empty')} />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">{t('products.intro')}</p>
      <dl className="m-0">
        <Row term={t('products.products')}>{count(impact.products)}</Row>
        <Row term={t('products.direct')}>{count(impact.directProducts)}</Row>
        <Row term={t('products.offers')}>{count(impact.offers)}</Row>
        <Row term={t('products.listed')}>{count(impact.listedOffers)}</Row>
        <Row term={t('products.tagged')}>{count(impact.offersWithActiveTag)}</Row>
        <Row term={t('products.descendants')}>{impact.descendants}</Row>
      </dl>
    </div>
  );
}

function HistoryTab({ body }: { readonly body: DetailBody }) {
  const t = useTranslations('categories');
  if (body.revisions.length === 0) return <EmptyState icon="clock" title={t('history.empty')} />;
  return (
    <ol className="m-0 list-none p-0">
      {body.revisions.map((revision) => (
        <li key={revision.revisionNo} className="flex flex-col gap-0.5 border-b border-line py-3">
          <span className="font-medium">
            {t('history.revision', { no: revision.revisionNo })} · {revision.changeKind}
          </span>
          <span className="text-sm text-fg-muted">
            {t(`history.by-${revision.authorKind}`)} · <When iso={revision.createdAt} missing="" />
          </span>
        </li>
      ))}
    </ol>
  );
}
