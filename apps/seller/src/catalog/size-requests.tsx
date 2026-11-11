'use client';

import { Badge, Banner, Button, Select, toast } from '@mondapac/ui';
import type { BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from './format.ts';
import {
  requestProblemOf,
  type RequestAxis,
  type RequestStatus,
  type SizeRequestItem,
} from './size-request-logic.ts';

const TONE: Readonly<Record<RequestStatus, BadgeTone>> = {
  open: 'attention',
  approved: 'success',
  mapped: 'success',
  declined: 'neutral',
};

const titleOf = (item: SizeRequestItem): string =>
  item.options.map((option) => option.optionLabel).join(' · ');

/**
 * "Request a size" and "Sizes you asked for" (variants V7), shown under "Sizes you sell" on a
 * PLATFORM product. A request names option codes the product's family offers, one per axis; a
 * reviewer approves it, maps it to a size the product has, or declines it with a reason. The
 * reviewer's words are shown as plain text. Without the edit key the seller still reads the list.
 */
export function SizeRequests({
  offerId,
  axes,
  items,
  openCount,
  maxOpen,
  canRequest,
  csrfToken,
}: {
  readonly offerId: string;
  readonly axes: readonly RequestAxis[];
  /** The seller's requests for this product. */
  readonly items: readonly SizeRequestItem[];
  readonly openCount: number;
  readonly maxOpen: number;
  readonly canRequest: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.size-requests');
  const locale = useLocale();
  const router = useRouter();
  const busy = useRef(false);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const atLimit = openCount >= maxOpen;
  const complete = axes.every((axis) => (chosen[axis.code] ?? '') !== '');

  async function send() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<{ id: string }>(
      'POST',
      `catalog/seller/offers/${offerId}/variant-requests`,
      { optionValues: chosen },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t('sent'));
      setOpen(false);
      setChosen({});
      router.refresh();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(requestProblemOf(result.failure));
  }

  return (
    <section aria-labelledby="size-requests-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="size-requests-title" className="text-sm font-semibold text-fg">
          {t('title')}
        </h3>
        {canRequest && !open ? (
          <Button variant="secondary" disabled={atLimit} onClick={() => setOpen(true)}>
            {t('request')}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-fg-muted">{t('help')}</p>
      {canRequest && atLimit ? (
        <p className="text-sm text-fg-muted">{t('at-limit', { max: maxOpen })}</p>
      ) : null}
      {problem === null ? null : (
        <div role="alert">
          <Banner tone="critical">{t(`error.${problem}`, { max: maxOpen })}</Banner>
        </div>
      )}
      {open ? (
        <form
          className="flex flex-col gap-3 rounded-md border border-line p-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="flex flex-wrap gap-3">
            {axes.map((axis) => (
              <div key={axis.code} className="w-full sm:w-56">
                <Select
                  label={axis.name}
                  placeholder={t('choose')}
                  value={chosen[axis.code] ?? ''}
                  options={axis.options.map((option) => ({
                    value: option.code,
                    label: option.label,
                  }))}
                  onChange={(event) => setChosen({ ...chosen, [axis.code]: event.target.value })}
                />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={pending} disabled={pending || !complete}>
              {t('send')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setProblem(null);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('none')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('list-label')}>
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2 text-sm"
            >
              <span className="font-medium text-fg">{titleOf(item)}</span>
              <Badge tone={TONE[item.status]}>{t(`status.${item.status}`)}</Badge>
              <span className="text-fg-muted">
                {shortInstant(item.decidedAt ?? item.createdAt, locale)}
              </span>
              {item.status === 'declined' && item.declineReason !== null ? (
                <p className="basis-full text-fg-muted">
                  {t('reason', { reason: item.declineReason })}
                </p>
              ) : null}
              {item.status === 'approved' ? (
                <p className="basis-full text-fg-muted">{t('approved-note')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
