'use client';

import { Banner, Card, Switch } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { flagErrorKey } from '../offer-review/flag-errors.ts';
import { TOUCH_SWITCH } from '../offer-review/touch.ts';
import { ReasonDialog, type ReasonResult } from '../offer-review/reason-dialog.tsx';
import { StandingSummary } from '../offer-review/standing-summary.tsx';
import {
  FLAG_IDS,
  FLAG_PATH_PART,
  flagsOf,
  flagsPath,
  type FlagId,
  type Flags,
  type Standing,
} from '../offer-review/standing.ts';
import { formatInstantInZone } from '../shared/format.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';

/** The flags that ask a fresh two-step code (the API names the action key when it needs one). */
const PROTECTED: ReadonlySet<FlagId> = new Set(['trusted', 'stop']);

/**
 * "Offer review" on the admin seller page (risk-based Offer approval slices 4 and 5): where the
 * seller stands (Trusted or Probation, with the count against its target) and three switches:
 * Trusted from start, Full review and the review Stop. Each change asks for a reason of 1 to 500
 * characters; Trusted and Stop also ask for a two-step code, in place. Without the manage key a
 * switch is read-only. The API judges every change; a stale version reloads the flags.
 */
export function OfferReviewCard({
  sellerId,
  csrfToken,
  standing,
  initial,
  can,
  zone,
}: {
  readonly sellerId: string;
  readonly csrfToken: string;
  /** Null when the standing could not be read or the admin may not read it. */
  readonly standing: Standing | null;
  /** Null when the flags could not be read. */
  readonly initial: Flags | null;
  /** The switches this admin may change. */
  readonly can: Readonly<Record<FlagId, boolean>>;
  readonly zone: string;
}) {
  const t = useTranslations('offer-review.seller');
  const tf = useTranslations('offer-review.flag-error');
  const locale = useLocale();
  const guarded = useGuardedCall();
  const [flags, setFlags] = useState<Flags | null>(initial);
  const [asking, setAsking] = useState<FlagId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [staleNote, setStaleNote] = useState(false);

  async function reload() {
    const result = await callApi<unknown>('GET', flagsPath(sellerId));
    if (result.ok) {
      const next = flagsOf(result.body);
      if (next !== null) setFlags(next);
    }
  }

  async function change(id: FlagId, on: boolean, reason: string): Promise<ReasonResult> {
    if (flags === null) return { kind: 'failed', message: tf('unavailable') };
    const send = PROTECTED.has(id) ? guarded : callApi;
    const result = await send<{ on: boolean; changed: boolean; version: number }>(
      'PUT',
      `${flagsPath(sellerId)}/${FLAG_PATH_PART[id]}`,
      { on, reason, expectedVersion: flags.version },
      csrfToken,
    );
    if (result.ok) {
      setFlags({
        ...flags,
        [id]: { on: result.body.on, changedAt: new Date().toISOString() },
        version: result.body.version,
      });
      setNotice(t(`done.${id}.${result.body.on ? 'on' : 'off'}`));
      setStaleNote(false);
      return { kind: 'done' };
    }
    if (isStepUpCancelled(result)) return { kind: 'cancelled' };
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return { kind: 'cancelled' };
    }
    const key = flagErrorKey(result.failure);
    if (key === 'stale') {
      await reload();
      setStaleNote(true);
      setAsking(null);
      return { kind: 'cancelled' };
    }
    return { kind: 'failed', message: tf(key) };
  }

  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-4">
        {standing === null ? null : (
          <section aria-label={t('standing')} className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-medium">{t('standing')}</h3>
            <StandingSummary standing={standing} zone={zone} />
          </section>
        )}
        {flags === null ? (
          <Banner tone="attention">{t('unreadable')}</Banner>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {FLAG_IDS.map((id) => {
              const flag = flags[id];
              const label = `flag-${id}`;
              return (
                <li key={id} className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <Switch
                    aria-labelledby={`${sellerId}-${label}`}
                    aria-describedby={`${sellerId}-${label}-effect`}
                    checked={flag.on}
                    disabled={!can[id] || asking !== null}
                    onCheckedChange={() => {
                      setNotice(null);
                      setAsking(id);
                    }}
                    className={`mt-0.5 min-h-6 ${TOUCH_SWITCH}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p id={`${sellerId}-${label}`} className="m-0 font-medium">
                      {t(`flag.${id}.label`)}
                    </p>
                    <p id={`${sellerId}-${label}-effect`} className="m-0 text-sm text-fg-muted">
                      {t(`flag.${id}.effect`)}
                    </p>
                    <p className="m-0 text-sm text-fg-muted">
                      {flag.changedAt === null
                        ? t('never-changed')
                        : t('last-changed', {
                            when: formatInstantInZone(flag.changedAt, locale, zone),
                          })}
                      {can[id] ? '' : ` · ${t('read-only')}`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div role="status" aria-live="polite">
          {notice === null ? null : <p className="m-0 font-medium">{notice}</p>}
          {staleNote ? <Banner tone="attention">{t('stale')}</Banner> : null}
        </div>
      </div>
      {asking === null || flags === null ? null : (
        <ReasonDialog
          title={t(`dialog.${asking}.${flags[asking].on ? 'off' : 'on'}.title`)}
          intro={
            <p className="m-0">{t(`dialog.${asking}.${flags[asking].on ? 'off' : 'on'}.body`)}</p>
          }
          confirm={t(`dialog.${asking}.${flags[asking].on ? 'off' : 'on'}.confirm`)}
          confirmVariant={asking === 'stop' && !flags[asking].on ? 'destructive-solid' : 'primary'}
          onClose={() => setAsking(null)}
          onConfirm={(reason) => change(asking, !flags[asking].on, reason)}
        />
      )}
    </Card>
  );
}
