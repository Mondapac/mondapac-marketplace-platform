'use client';

import { Banner, Button, Card, Dialog, RadioGroup, Switch } from '@mondapac/ui';
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
  | {
      readonly kind: 'done';
      readonly enabled: boolean;
      readonly changed: boolean;
      readonly unpublished: boolean;
    }
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
  canEdit,
}: {
  readonly sellerId: string;
  readonly csrfToken: string;
  readonly initial: BlogAccessRead | null;
  readonly canView: boolean;
  /** The admin holds `sellers.blog-access.edit`; without it the switch is shown but locked. */
  readonly canEdit: boolean;
}) {
  const t = useTranslations('sellers.blog-access');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [changedAt, setChangedAt] = useState(initial?.changedAt ?? null);
  const [confirming, setConfirming] = useState(false);
  const [unpublish, setUnpublish] = useState<'keep' | 'unpublish'>('keep');
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function set(next: boolean, takeOff = false) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setOutcome(null);
    const result = await guarded<{ enabled: boolean; changed: boolean }>(
      'PUT',
      blogAccessPath(sellerId),
      next ? { enabled: true } : { enabled: false, ...(takeOff ? { unpublishLive: true } : {}) },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    setConfirming(false);
    if (result.ok) {
      setEnabled(result.body.enabled);
      if (result.body.changed) setChangedAt(new Date().toISOString());
      setUnpublish('keep');
      setOutcome({
        kind: 'done',
        enabled: result.body.enabled,
        changed: result.body.changed,
        unpublished: takeOff && !result.body.enabled,
      });
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
                aria-label={t('switch-label')}
                checked={enabled}
                disabled={!canEdit || pending}
                onCheckedChange={(next) => {
                  if (next) void set(true);
                  else {
                    setUnpublish('keep');
                    setConfirming(true);
                  }
                }}
              />
              <span>{enabled ? t('on') : t('off')}</span>
            </div>
            {!canEdit ? <p className="m-0 text-sm text-fg-muted">{t('read-only')}</p> : null}
            <p className="m-0 text-sm text-fg-muted">
              {changedAt === null
                ? t('never-changed')
                : t('last-changed', { when: formatInstant(changedAt, locale) })}
            </p>
          </>
        )}
        <div role="status">
          {pending ? <p className="m-0 text-fg-muted">{t('saving')}</p> : null}
          {!pending && outcome?.kind === 'done' ? (
            <p className="m-0 font-medium">
              {outcome.enabled
                ? t('now-on')
                : outcome.unpublished
                  ? t('now-off-unpublished')
                  : t('now-off')}
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
      <Dialog
        open={confirming}
        title={t('off-title')}
        onClose={() => {
          if (!pending) setConfirming(false);
        }}
        initialFocus={cancelRef}
        actions={
          <>
            <Button
              ref={cancelRef}
              variant="secondary"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive-solid"
              loading={pending}
              onClick={() => void set(false, unpublish === 'unpublish')}
            >
              {t('off-confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>{t('off-body')}</p>
          <RadioGroup
            legend={t('off-live-legend')}
            name="blog-live-posts"
            value={unpublish}
            disabled={pending}
            options={[
              { value: 'keep', label: t('off-live-keep'), help: t('off-live-keep-help') },
              {
                value: 'unpublish',
                label: t('off-live-unpublish'),
                help: t('off-live-unpublish-help'),
              },
            ]}
            onChange={(value) => setUnpublish(value === 'unpublish' ? 'unpublish' : 'keep')}
          />
        </div>
      </Dialog>
    </Card>
  );
}
