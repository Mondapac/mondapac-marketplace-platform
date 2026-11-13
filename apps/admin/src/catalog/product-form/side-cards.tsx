'use client';

import { Badge, Button, Card, Switch } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { dayInZone } from '../../shared/format.ts';
import { readable } from './types.ts';

const STATUS_TONE: Readonly<Record<string, 'neutral' | 'success' | 'attention'>> = {
  draft: 'neutral',
  published: 'success',
  paused: 'attention',
};

/** The status badge of a product, as the page title and the Status card show it. */
export function StatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('catalog.productForm');
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>;
}

/**
 * The Status card: the state, the revision badge of a published product with edits, what Publish
 * does, the Publish button with what it still lacks, a quiet Discard for a draft, and (admin
 * with the pause key, published products only) the Active switch.
 */
export function StatusCard({
  status,
  publishedNo,
  nextNo,
  hasRevision,
  blockers,
  canPublish,
  pending,
  onPublish,
  onDiscard,
  active,
}: {
  readonly status: string;
  /** The revision buyers see; null while the product was never published. */
  readonly publishedNo: number | null;
  readonly nextNo: number;
  readonly hasRevision: boolean;
  /** The "To publish: …" line, or null when nothing is missing. */
  readonly blockers: string | null;
  readonly canPublish: boolean;
  readonly pending: boolean;
  readonly onPublish: () => void;
  /** Present for a draft that was never published. */
  readonly onDiscard: (() => void) | null;
  readonly active: ReactNode;
}) {
  const t = useTranslations('catalog.productForm');
  const published = publishedNo !== null || status === 'published';
  return (
    <Card title={t('status.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={status} />
        {hasRevision ? <Badge tone="attention">{t('status.revision', { n: nextNo })}</Badge> : null}
      </div>
      <p className="text-sm text-fg-muted">
        {published ? t('status.published-help', { n: publishedNo ?? 1 }) : t('status.draft-help')}
      </p>
      <Button disabled={pending || !canPublish} onClick={onPublish}>
        {published ? t('publish-revision', { n: nextNo }) : t('publish')}
      </Button>
      {blockers === null ? null : <p className="text-xs text-fg-muted">{blockers}</p>}
      {onDiscard === null ? null : (
        <div>
          <Button variant="link" disabled={pending} onClick={onDiscard}>
            {t('discard.button')}
          </Button>
        </div>
      )}
      {active}
    </Card>
  );
}

/** The Active row: a switch with what it does; the text changes while the product is paused. */
export function ActiveRow({
  inactive,
  pausedAt,
  offerCount,
  timeZone,
  pending,
  onChange,
}: {
  readonly inactive: boolean;
  readonly pausedAt: string | null;
  readonly offerCount: number;
  readonly timeZone: string;
  readonly pending: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const t = useTranslations('catalog.productForm.active');
  const locale = useLocale();
  return (
    <div className="flex items-center gap-3 border-t border-line-row pt-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p id="product-active-label" className="text-sm font-semibold">
          {inactive ? t('inactive') : t('title')}
        </p>
        <p className="text-xs text-fg-muted">
          {inactive
            ? t('inactive-help', { date: dayInZone(pausedAt, locale, timeZone), count: offerCount })
            : t('help')}
        </p>
      </div>
      <Switch
        checked={!inactive}
        disabled={pending}
        aria-labelledby="product-active-label"
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** Market, scope and type; read only. */
export function OrganisationCard({
  marketName,
  typeCode,
}: {
  readonly marketName: string;
  readonly typeCode: string;
}) {
  const t = useTranslations('catalog.productForm');
  return (
    <Card title={t('organisation.title')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-muted">{t('organisation.market')}</dt>
        <dd>{marketName}</dd>
        <dt className="text-fg-muted">{t('organisation.scope')}</dt>
        <dd>{t('organisation.platform')}</dd>
        <dt className="text-fg-muted">{t('organisation.type')}</dt>
        <dd>{readable(typeCode)}</dd>
      </dl>
    </Card>
  );
}

/** "Sellers selling it": two read-only tiles, or a note while nobody has an offer yet. */
export function SellersCard({
  sellerCount,
  offerCount,
}: {
  readonly sellerCount: number;
  readonly offerCount: number;
}) {
  const t = useTranslations('catalog.productForm.sellers');
  return (
    <Card title={t('title')}>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ['sellers', sellerCount],
            ['offers', offerCount],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-md bg-subtle p-3">
            <p className="text-xs text-fg-muted">{t(key)}</p>
            <p className="text-sm font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-fg-muted">{t('help')}</p>
      {offerCount === 0 ? <p className="text-xs text-fg-muted">{t('none')}</p> : null}
    </Card>
  );
}
