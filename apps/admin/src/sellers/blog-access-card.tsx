'use client';

import { Banner, Card, CheckboxRow, Switch } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { formatInstant } from '../shared/format.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';

export const BLOG_ACCESS_PERMISSION = 'sellers.blog-access.edit';
export const blogAccessPath = (sellerId: string): string => `sellers/admin/${sellerId}/blog-access`;

/** What `GET sellers/admin/:id/blog-access` answers; `changedAt` is null until an admin changes it. */
export interface BlogAccessRead {
  readonly enabled: boolean;
  readonly changedAt: string | null;
}

/** The read checked; anything else is treated as unreadable. */
export function blogAccessOf(value: unknown): BlogAccessRead | null {
  if (typeof value !== 'object' || value === null) return null;
  const { enabled, changedAt } = value as Record<string, unknown>;
  if (typeof enabled !== 'boolean') return null;
  return { enabled, changedAt: typeof changedAt === 'string' ? changedAt : null };
}

type Outcome =
  | { readonly kind: 'done'; readonly enabled: boolean; readonly changed: boolean }
  | { readonly kind: 'failed'; readonly key: string };

/**
 * "Blog" on the admin seller page (design A6): whether this seller may write blog posts. Off by
 * default. Switching it off keeps the posts; the admin may also take the seller's live posts off
 * the site. The switch is a protected action, so the shared two-step code dialog may open. The
 * answer drives the switch; `initial` is null when the read failed, `canView` false when the
 * role has no read key.
 */
export function BlogAccessCard({
  sellerId,
  csrfToken,
  initial,
  canView,
}: {
  readonly sellerId: string;
  readonly csrfToken: string;
  readonly initial: BlogAccessRead | null;
  readonly canView: boolean;
}) {
  const t = useTranslations('sellers.blog-access');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [changedAt, setChangedAt] = useState(initial?.changedAt ?? null);
  const [unpublish, setUnpublish] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = useRef(false);

  async function set(next: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setOutcome(null);
    const result = await guarded<{ enabled: boolean; changed: boolean }>(
      'PUT',
      blogAccessPath(sellerId),
      next ? { enabled: true } : { enabled: false, ...(unpublish ? { unpublishLive: true } : {}) },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setEnabled(result.body.enabled);
      if (result.body.changed) setChangedAt(new Date().toISOString());
      setUnpublish(false);
      setOutcome({ kind: 'done', enabled: result.body.enabled, changed: result.body.changed });
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const known: Record<string, string> = {
      'access.denied': 'denied',
      'access.acting-as-refused': 'acting-as',
      'request.csrf': 'csrf',
      'validation.failed': 'invalid',
      'file.not-found': 'not-found',
      'second-factor.enrolment-required': 'enrolment',
    };
    setOutcome({ kind: 'failed', key: known[result.failure.code] ?? 'unknown' });
  }

  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-3">
        <p className="max-w-prose text-fg-muted">{t('help')}</p>
        {!canView ? (
          <Banner tone="info">{t('no-access')}</Banner>
        ) : initial === null ? (
          <Banner tone="attention">{t('unreadable')}</Banner>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Switch
                aria-label={t('title')}
                checked={enabled}
                disabled={pending}
                onCheckedChange={(next) => void set(next)}
              />
              <span>{enabled ? t('on') : t('off')}</span>
            </div>
            {enabled ? (
              <CheckboxRow
                label={t('unpublish')}
                help={t('unpublish-help')}
                checked={unpublish}
                disabled={pending}
                onChange={() => setUnpublish(!unpublish)}
              />
            ) : null}
            <p className="m-0 text-sm text-fg-muted">
              {changedAt === null
                ? t('never-changed')
                : t('last-changed', { when: formatInstant(changedAt, locale) })}
            </p>
          </>
        )}
        <div role="status">
          {outcome?.kind === 'done' ? (
            <p className="m-0 font-medium">
              {outcome.enabled ? t('now-on') : t('now-off')}
              {outcome.changed ? '' : ` ${t('no-change')}`}
            </p>
          ) : null}
        </div>
        {outcome?.kind === 'failed' ? (
          <div role="alert">
            <Banner tone="critical">{t(`error.${outcome.key}`)}</Banner>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
