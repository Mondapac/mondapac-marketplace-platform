'use client';

import { Button } from '@mondapac/ui';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import {
  AddOfferDialog,
  createErrorKey,
  defaultCondition,
  draftOfferBody,
  searchPath,
  type Created,
  type PlatformProduct,
  type PlatformSearchAnswer,
} from './add-offer-dialog.tsx';
import type { ProductOptions } from './types.ts';

/** The rows the panel shows; "See all" opens the full search for the rest. */
export const ON_THE_PLATFORM_ROWS = 5;

/** The platform search of the panel: the Products search text, without products already sold. */
export function panelSearchPath(text: string): string {
  const path = searchPath(text, 1, []);
  return `${path}${path.includes('?') ? '&' : '?'}notSelling=true`;
}

type Row = { readonly state: 'saving' } | { readonly state: 'refused'; readonly key: string };

/**
 * "On the platform" (Offer page design, section 3; PR 2): under the seller's Products list, while
 * its search has text, a short list of the platform products the seller may sell (their business
 * activities decide) and does not sell yet, each with "Sell this". It is not part of the list
 * above: no row selection, columns or bulk actions, and its count is its own. "See all" opens the
 * Add offer search with the same text. Nothing shows while the search finds nothing, fails or the
 * seller has no business activity: the list above stays the page.
 */
export function OnThePlatform({
  text,
  csrfToken,
}: {
  /** The Products list's search, as in the address (trimmed, not empty). */
  readonly text: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.onThePlatform');
  const ta = useTranslations('catalog.addOffer');
  const locale = useLocale();
  const router = useRouter();
  const headingId = useId();
  const [answer, setAnswer] = useState<PlatformSearchAnswer | null>(null);
  const [rows, setRows] = useState<ReadonlyMap<string, Row>>(new Map());
  const [seeAll, setSeeAll] = useState(false);
  const latest = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    const ticket = ++latest.current;
    setRows(new Map());
    void callApi<PlatformSearchAnswer>('GET', panelSearchPath(text)).then((result) => {
      if (ticket !== latest.current) return;
      if (!result.ok && result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      // A failed read hides the panel: the list above has its own error and Try again.
      setAnswer(result.ok ? result.body : null);
    });
  }, [text]);

  const mark = useCallback((productId: string, row: Row | null) => {
    setRows((current) => {
      const next = new Map(current);
      if (row === null) next.delete(productId);
      else next.set(productId, row);
      return next;
    });
  }, []);

  /** Creates the draft Offer and opens it; the condition is the Market's default for a new one. */
  async function sell(product: PlatformProduct) {
    if (busy.current) return;
    busy.current = true;
    mark(product.productId, { state: 'saving' });
    const options = await callApi<ProductOptions>('GET', 'catalog/seller/products/options');
    const condition = options.ok ? defaultCondition(options.body.conditions) : null;
    if (!options.ok && options.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (condition === null) {
      busy.current = false;
      mark(product.productId, { state: 'refused', key: 'unknown' });
      return;
    }
    const result = await callApi<Created>(
      'POST',
      'catalog/seller/offers',
      draftOfferBody(product, condition),
      csrfToken,
    );
    busy.current = false;
    if (result.ok) {
      router.push(`/offers/${result.body.offerId}`);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    mark(product.productId, { state: 'refused', key: createErrorKey(result.failure.code) });
  }

  if (answer === null || answer.notice === 'no-activity' || answer.total === 0) return null;
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const shown = answer.items.slice(0, ON_THE_PLATFORM_ROWS);
  const saving = [...rows.values()].some((row) => row.state === 'saving');

  return (
    <section
      aria-labelledby={headingId}
      className="mt-6 overflow-hidden rounded-lg border border-line bg-surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line bg-info-bg px-4 py-3">
        <h2 id={headingId} className="text-base font-semibold text-fg">
          {t('title', { total: number(answer.total) })}
        </h2>
        <p className="text-sm text-fg-muted">{t('note')}</p>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((product) => {
          const row = rows.get(product.productId);
          const name = product.name ?? product.productCode;
          return (
            <li
              key={product.productId}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1 basis-60">
                <p className="font-medium text-fg">
                  {name} <span className="font-normal text-fg-muted">{product.productCode}</span>
                </p>
                <p className="text-sm text-fg-muted">
                  {[
                    product.brandName,
                    product.categoryName,
                    ta('sizes', { count: product.variantCount }),
                  ]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                </p>
                {row?.state === 'refused' ? (
                  <p role="alert" className="mt-1 text-sm text-critical-fg">
                    {t('refused', { reason: ta(`create-reason.${row.key}`) })}
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                // The busy button keeps focus (loading); the others wait for it.
                loading={row?.state === 'saving'}
                loadingLabel={t('saving')}
                disabled={saving && row?.state !== 'saving'}
                aria-label={t('sell-label', { name })}
                onClick={() => void sell(product)}
              >
                {ta('sell-this')}
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line px-4 py-3 text-sm">
        <p className="text-fg-muted" aria-live="polite">
          {t('showing', { shown: number(shown.length), total: number(answer.total) })}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            variant="link"
            size="sm"
            className="underline"
            aria-haspopup="dialog"
            onClick={() => setSeeAll(true)}
          >
            {t('see-all', { q: text })}
          </Button>
          <span aria-hidden="true" className="hidden text-fg-muted sm:inline">
            ·
          </span>
          <Link href="/products/new" className="font-medium text-link underline">
            {t('add-own')}
          </Link>
        </div>
      </div>
      {seeAll ? (
        <AddOfferDialog
          open
          initialText={text}
          csrfToken={csrfToken}
          onClose={() => setSeeAll(false)}
          navigate={(path) => {
            setSeeAll(false);
            router.push(path);
          }}
        />
      ) : null}
    </section>
  );
}
