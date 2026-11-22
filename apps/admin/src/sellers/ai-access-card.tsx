'use client';

import { Banner, Card, Switch } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import { aiAccessPath, type AiAccessRead } from './ai-access-types.ts';

type Outcome =
  | { readonly kind: 'done'; readonly enabled: boolean; readonly changed: boolean }
  | { readonly kind: 'failed'; readonly key: string };

/**
 * "AI writing help" (sellers SEL-25) on the admin seller page: whether this seller may draft
 * product descriptions with AI. Off by default. The switch takes effect at once and the answer
 * drives it. The Market switch (Settings › AI) must also be on; this card says nothing of it.
 * Without the view key the card says so and shows no switch; `initial` is null when the read
 * itself failed, which is worded differently.
 */
export function AiAccessCard({
  sellerId,
  csrfToken,
  initial,
  canView,
}: {
  readonly sellerId: string;
  readonly csrfToken: string;
  /** Null when the read failed, or when `canView` is false and nothing was read. */
  readonly initial: AiAccessRead | null;
  /** The admin holds `sellers.seller.view`, the key of the read. Without it there is no switch. */
  readonly canView: boolean;
}) {
  const t = useTranslations('sellers.ai-access');
  const locale = useLocale();
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [changedAt, setChangedAt] = useState(initial?.changedAt ?? null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = useRef(false);

  async function set(next: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setOutcome(null);
    const result = await callApi<{ enabled: boolean; changed: boolean }>(
      'PUT',
      aiAccessPath(sellerId),
      { enabled: next },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setEnabled(result.body.enabled);
      if (result.body.changed) setChangedAt(new Date().toISOString());
      setOutcome({ kind: 'done', enabled: result.body.enabled, changed: result.body.changed });
      return;
    }
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
