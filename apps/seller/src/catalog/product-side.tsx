'use client';

import { Badge, Button, Card, CheckboxRow } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { readable } from './format.ts';

export type Blocker = 'title' | 'category' | 'tax' | 'details';

const TONE = { draft: 'neutral', published: 'success' } as const;

/** The status badge of a product, as the page title and the Status card show it. */
export function StatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('catalog.products.status');
  const known = ['draft', 'unpublished', 'published', 'matched', 'retired'].includes(status);
  return (
    <Badge tone={status === 'published' || status === 'draft' ? TONE[status] : 'neutral'}>
      {t(known ? (status as 'draft') : 'unknown')}
    </Badge>
  );
}

/**
 * The Status card: the state, what Submit for review does, the button with what it still lacks,
 * and the option to replace a revision that is already waiting.
 */
export function StatusCard({
  status,
  waiting,
  published,
  blockers,
  canSubmit,
  pending,
  onSubmit,
  replacePending,
}: {
  readonly status: string;
  /** A revision is waiting for review. */
  readonly waiting: boolean;
  readonly published: boolean;
  /** The "To submit: …" line, or null when nothing is missing. */
  readonly blockers: string | null;
  readonly canSubmit: boolean;
  readonly pending: boolean;
  readonly onSubmit: () => void;
  /** Present when a revision is waiting: ticking it replaces that revision. */
  readonly replacePending: {
    readonly checked: boolean;
    readonly onChange: (on: boolean) => void;
  } | null;
}) {
  const t = useTranslations('catalog.edit');
  return (
    <Card title={t('status.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={status} />
        {waiting ? <Badge tone="attention">{t('status.waiting')}</Badge> : null}
      </div>
      <p className="text-sm text-fg-muted">
        {waiting
          ? t('status.pending-help')
          : published
            ? t('status.published-help')
            : t('status.draft-help')}
      </p>
      {replacePending === null ? null : (
        <CheckboxRow
          name="replacePending"
          label={t('replace-pending')}
          checked={replacePending.checked}
          onChange={(event) => replacePending.onChange(event.target.checked)}
        />
      )}
      <Button disabled={pending || !canSubmit} onClick={onSubmit}>
        {t('submit')}
      </Button>
      {blockers === null ? null : <p className="text-xs text-fg-muted">{blockers}</p>}
    </Card>
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
  const t = useTranslations('catalog.edit.organisation');
  return (
    <Card title={t('title')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-muted">{t('market')}</dt>
        <dd>{marketName}</dd>
        <dt className="text-fg-muted">{t('scope')}</dt>
        <dd>{t('scope-own')}</dd>
        <dt className="text-fg-muted">{t('type')}</dt>
        <dd>{readable(typeCode)}</dd>
      </dl>
    </Card>
  );
}
