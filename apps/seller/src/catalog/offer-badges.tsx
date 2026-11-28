'use client';

import { Badge, Banner, Button, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { badgeErrorOf, type BadgeChoice } from './offer-badges-logic.ts';
import type { OfferTag } from './types.ts';

type Notice = 'added' | 'held' | 'removed' | 'sold-without';

/**
 * The certificate badges of one offer (the Halal badge and its kin): the ones it carries and their
 * state, and one button per certificate the seller holds that the offer does not carry yet. The
 * API decides every add (certification's check); a refusal is shown in words. A live offer's new
 * badge may wait for our check (`held`), which the card says.
 */
export function OfferBadges({
  offerId,
  csrfToken,
  tags,
  choices,
  names,
  canEdit,
}: {
  readonly offerId: string;
  readonly csrfToken: string;
  readonly tags: readonly OfferTag[];
  readonly choices: readonly BadgeChoice[];
  /** Type code to its name in the panel's language, for the badges the offer carries. */
  readonly names: Readonly<Record<string, string>>;
  readonly canEdit: boolean;
}) {
  const t = useTranslations('catalog.badges');
  const tr = useTranslations();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const base = `catalog/seller/offers/${offerId}/tags`;

  async function run(key: string, call: () => ReturnType<typeof callApi<unknown>>, done: Notice) {
    if (busy.current) return;
    busy.current = true;
    setPending(key);
    setError(null);
    setNotice(null);
    const result = await call();
    busy.current = false;
    setPending(null);
    if (result.ok) {
      const body = result.body as { applied?: boolean } | null;
      setNotice(done === 'added' && body?.applied === false ? 'held' : done);
      // The page shows the new state after a reload; the card says so below.
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setError(badgeErrorOf(result.failure));
  }

  if (tags.length === 0 && choices.length === 0 && !canEdit) return null;
  const nameOf = (code: string) => names[code] ?? code;
  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{t('help')}</p>
        {error === null ? null : <Banner tone="critical">{tr(error)}</Banner>}
        {notice === null ? null : (
          <Banner tone={notice === 'held' ? 'info' : 'success'}>
            <span>{t(`notice.${notice}`)} </span>
            <a className="font-medium text-link underline" href={`/offers/${offerId}`}>
              {t('reload')}
            </a>
          </Banner>
        )}
        {tags.length === 0 ? (
          <p>{t('none')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {tags.map((tag) => (
              <li key={tag.typeCode} className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{nameOf(tag.typeCode)}</span>
                <Badge
                  tone={
                    tag.status === 'active'
                      ? 'success'
                      : tag.status === 'suspended'
                        ? 'critical'
                        : 'info'
                  }
                >
                  {t(
                    `status.${
                      tag.status === 'active' || tag.status === 'suspended'
                        ? tag.status
                        : 'pending-publish'
                    }`,
                  )}
                </Badge>
                {canEdit && tag.status === 'suspended' ? (
                  <Button
                    variant="secondary"
                    loading={pending === `sell-${tag.typeCode}`}
                    disabled={pending !== null}
                    onClick={() =>
                      void run(
                        `sell-${tag.typeCode}`,
                        () =>
                          callApi(
                            'POST',
                            `${base}/${encodeURIComponent(tag.typeCode)}/sell-without-badge`,
                            { confirmSellWithoutBadge: true },
                            csrfToken,
                          ),
                        'sold-without',
                      )
                    }
                  >
                    {t('sell-without')}
                  </Button>
                ) : null}
                {canEdit && tag.status !== 'suspended' ? (
                  <Button
                    variant="secondary"
                    loading={pending === `remove-${tag.typeCode}`}
                    disabled={pending !== null}
                    onClick={() =>
                      void run(
                        `remove-${tag.typeCode}`,
                        () =>
                          callApi(
                            'DELETE',
                            `${base}/${encodeURIComponent(tag.typeCode)}`,
                            undefined,
                            csrfToken,
                          ),
                        'removed',
                      )
                    }
                  >
                    {t('remove')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit && choices.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {choices.map((choice) => (
              <Button
                key={choice.typeCode}
                loading={pending === `add-${choice.typeCode}`}
                disabled={pending !== null}
                onClick={() =>
                  void run(
                    `add-${choice.typeCode}`,
                    () => callApi('POST', base, { typeCode: choice.typeCode }, csrfToken),
                    'added',
                  )
                }
              >
                {t('add', { name: choice.name })}
              </Button>
            ))}
          </div>
        ) : null}
        {canEdit && choices.length === 0 && tags.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {t('need-certificate')}{' '}
            <a className="font-medium text-link underline" href="/settings/certificates">
              {t('certificates-link')}
            </a>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
