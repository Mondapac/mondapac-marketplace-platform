'use client';

import { Button, ListThumb } from '@mondapac/ui';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import {
  AddOfferDialog,
  afterSellPath,
  createErrorKey,
  searchPath,
  type PlatformProduct,
  type PlatformSearchAnswer,
} from './add-offer-dialog.tsx';
import { createDraftOffer, loadOfferDefaults } from './draft-offers.ts';
import { productThumbSrc } from './product-thumb.ts';

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
  marketId,
  csrfToken,
}: {
  /** The Products list's search, as in the address (trimmed, not empty). */
  readonly text: string;
  /** The panel's Market: the thumbnails are served by its public image route. */
  readonly marketId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.onThePlatform');
  const ta = useTranslations('catalog.addOffer');
  const locale = useLocale();
  const router = useRouter();
  const headingId = useId();
  const errorId = useId();
  // The answer and the text it answers: rows of an older text are shown dimmed and cannot be sold
  // until the new answer arrives.
  const [answer, setAnswer] = useState<{
    readonly text: string;
    readonly body: PlatformSearchAnswer;
  } | null>(null);
  const [rows, setRows] = useState<ReadonlyMap<string, Row>>(new Map());
  const [seeAll, setSeeAll] = useState(false);
  const latest = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    const ticket = ++latest.current;
    // A refusal belongs to the search it was shown in; a draft being created keeps its row.
    setRows((current) => new Map([...current].filter(([, row]) => row.state === 'saving')));
    void callApi<PlatformSearchAnswer>('GET', panelSearchPath(text)).then((result) => {
      // A later search answers; this one is stale.
      if (ticket !== latest.current) return;
      if (!result.ok && result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      // A failed read hides the panel: the list above has its own error and Try again.
      setAnswer(result.ok ? { text, body: result.body } : null);
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

  /**
   * Creates the draft Offer and opens it with the cursor on the first price; the condition and
   * handling are those of the seller's last offer, else the Market default and no handling.
   */
  async function sell(product: PlatformProduct) {
    if (busy.current) return;
    busy.current = true;
    mark(product.productId, { state: 'saving' });
    const defaults = await loadOfferDefaults();
    if (defaults === 'signed-out') {
      window.location.assign('/session-ended');
      return;
    }
    if (defaults === 'failed') {
      busy.current = false;
      mark(product.productId, { state: 'refused', key: 'settings' });
      return;
    }
    const { result, handlingSignedOut } = await createDraftOffer(product, defaults, csrfToken);
    busy.current = false;
    if (handlingSignedOut) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.ok) {
      router.push(afterSellPath([result.body.offerId]));
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    mark(product.productId, { state: 'refused', key: createErrorKey(result.failure.code) });
  }

  if (answer === null) return null;
  const found = answer.body;
  if (found.notice === 'no-activity' || found.total === 0) return null;
  const stale = answer.text !== text;
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const shown = found.items.slice(0, ON_THE_PLATFORM_ROWS);
  const saving = [...rows.values()].some((row) => row.state === 'saving');
  const reason = (key: string) =>
    key === 'settings' ? t('settings-error') : ta(`create-reason.${key}`);
  const footerLink = 'inline-flex min-h-(--mp-size-control-sm) items-center font-medium';

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={stale}
      className="mt-6 overflow-hidden rounded-lg border border-info-border bg-surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-info-border bg-info-bg px-4 py-3">
        <h2 id={headingId} className="text-base font-semibold text-fg">
          {t('title')} <span className="whitespace-nowrap">({number(found.total)})</span>
        </h2>
        <p className="text-sm text-fg-muted">{t('note')}</p>
      </div>
      <ul className={`divide-y divide-line ${stale ? 'opacity-60' : ''}`}>
        {shown.map((product) => {
          const row = rows.get(product.productId);
          const name = product.name ?? product.productCode;
          const busyRow = row?.state === 'saving';
          const refused = row?.state === 'refused' ? row.key : null;
          const sizes = ta('sizes', { count: product.variantCount });
          return (
            <li
              key={product.productId}
              className="flex items-center gap-x-4 px-4 py-3 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <ListThumb src={productThumbSrc(marketId, { ...product, scope: 'PLATFORM' })} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-fg">
                    {name} <span className="font-normal text-fg-muted">{product.productCode}</span>
                  </p>
                  {/* On a phone one line under the name; from md up the brand and category are columns. */}
                  <p className="text-sm text-fg-muted md:hidden">
                    {[product.brandName, product.categoryName, sizes]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                  </p>
                  <p className="hidden text-sm text-fg-muted md:block">{sizes}</p>
                  {refused === null ? null : (
                    <p
                      id={`${errorId}-${product.productId}`}
                      role="alert"
                      className="mt-1 text-sm text-critical-fg"
                    >
                      {t('refused', { reason: reason(refused) })}
                    </p>
                  )}
                </div>
              </div>
              <p className="hidden truncate text-sm text-fg md:block">{product.brandName ?? ''}</p>
              <p className="hidden truncate text-sm text-fg md:block">
                {product.categoryName ?? ''}
              </p>
              <Button
                size="sm"
                className="w-28 shrink-0"
                // The busy button keeps focus (loading); the others wait for it. A product the
                // seller turned out to sell already cannot be sold twice.
                loading={busyRow}
                loadingLabel={t('saving')}
                disabled={stale || (saving && !busyRow) || refused === 'exists'}
                aria-label={
                  busyRow
                    ? t('saving-label', { name })
                    : product.brandName === null
                      ? t('sell-label', { name, code: product.productCode })
                      : t('sell-label-brand', {
                          name,
                          code: product.productCode,
                          brand: product.brandName,
                        })
                }
                aria-describedby={refused === null ? undefined : `${errorId}-${product.productId}`}
                onClick={() => void sell(product)}
              >
                {ta('sell-this')}
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-info-border px-4 py-2 text-sm">
        <p className="text-fg-muted">
          {t('showing', { shown: number(shown.length), total: number(found.total) })}
        </p>
        <div className="flex flex-wrap items-center gap-x-3">
          <Button
            variant="link"
            size="sm"
            className="font-medium"
            disabled={saving}
            aria-haspopup="dialog"
            onClick={() => setSeeAll(true)}
          >
            {t('see-all', { q: text })}
          </Button>
          <span aria-hidden="true" className="hidden text-fg-muted sm:inline">
            ·
          </span>
          {saving ? (
            <span className={`${footerLink} text-fg-muted`} aria-disabled="true">
              {t('add-own')}
            </span>
          ) : (
            <Link
              href="/products/new"
              className={`${footerLink} text-link underline-offset-2 hover:underline`}
            >
              {t('add-own')}
            </Link>
          )}
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
