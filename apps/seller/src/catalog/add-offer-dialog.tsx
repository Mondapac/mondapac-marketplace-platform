'use client';

import {
  Badge,
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  SearchField,
  Spinner,
  TextAreaField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { createDraftOffer, loadOfferDefaults } from './draft-offers.ts';
import type { OfferDefaults } from './offer-defaults.ts';
import { QUICK_MAX } from './quick-entry-logic.ts';

export { defaultCondition } from './offer-defaults.ts';
export { draftOfferBody, type Created } from './draft-offers.ts';

/** One platform product the seller may sell (`GET catalog/seller/products/platform-search`). */
export interface PlatformProduct {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string | null;
  readonly brandName: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly variantCount: number;
  readonly alreadySelling: boolean;
  /** The first clean photo of the published revision, else null (public image route). */
  readonly primaryImageId: string | null;
}

export type BarcodeStatus = 'found' | 'already-selling' | 'not-allowed' | 'not-found' | 'invalid';

export interface BarcodeResult {
  readonly input: string;
  readonly status: BarcodeStatus;
  readonly product: PlatformProduct | null;
}

export interface PlatformSearchAnswer {
  readonly items: readonly PlatformProduct[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly notice: 'no-activity' | null;
  readonly barcodeResults: readonly BarcodeResult[];
}

const SEARCH_MAX = 100;
const DEBOUNCE_MS = 300;

/** The query string of one search: only the keys that carry a value. */
export function searchPath(text: string, page: number, barcodes: readonly string[]): string {
  const params = new URLSearchParams();
  if (text.trim() !== '') params.set('q', text.trim().slice(0, SEARCH_MAX));
  if (page > 1) params.set('page', String(page));
  if (barcodes.length > 0) params.set('barcodes', barcodes.join(','));
  const query = params.toString();
  return `catalog/seller/products/platform-search${query === '' ? '' : `?${query}`}`;
}

/** The lines of a pasted barcode list: one per line, comma or space; empty ones dropped. */
export function barcodeLines(pasted: string): string[] {
  return [...new Set(pasted.split(/[\s,;]+/).filter((line) => line !== ''))];
}

/**
 * Where "Sell this" / "Sell these" goes once the drafts exist (Offer page PR 5): one draft opens
 * its Offer with the cursor on the first price; several open the quick entry table (at most
 * `QUICK_MAX`, the rest are counted and wait in Drafts).
 */
export function afterSellPath(offerIds: readonly string[]): string {
  if (offerIds.length === 1) return `/offers/${offerIds[0] ?? ''}?new=1#sizes`;
  // Offer ids are UUIDs: the list needs no escaping.
  const ids = `ids=${offerIds.slice(0, QUICK_MAX).join(',')}`;
  const more = offerIds.length > QUICK_MAX ? `&more=${offerIds.length - QUICK_MAX}` : '';
  return `/offers/new?${ids}${more}`;
}

/** The message key of a refused create: the codes a seller can act on, else a general one. */
export function createErrorKey(code: string): string {
  switch (code) {
    case 'offer.sku-taken':
      return 'sku-taken';
    case 'offer.exists-for-product':
      return 'exists';
    case 'type.not-allowed':
      return 'type-not-allowed';
    case 'setting.sell-from-catalogue-off':
      return 'off';
    case 'seller.not-eligible':
      return 'not-eligible';
    case 'request.throttled':
      return 'throttled';
    case 'product.not-found':
      return 'not-found';
    default:
      return 'unknown';
  }
}

/**
 * "Add offer" (Offer page design, PR 1): the seller searches the platform products they are allowed
 * to sell (their business activities decide), ticks one or more, or pastes a list of barcodes, and
 * "Sell this" / "Sell these (N)" creates one draft Offer for each, with the condition and handling
 * of the seller's last offer (else Sealed original). One product opens its Offer; several open
 * the quick entry table. A product the seller already sells is shown, not selectable.
 */
export function AddOfferDialog({
  open,
  csrfToken,
  onClose,
  navigate,
  initialText = '',
}: {
  readonly open: boolean;
  readonly csrfToken: string;
  /** The search the dialog opens with ("See all" under the Products list passes its search). */
  readonly initialText?: string;
  readonly onClose: () => void;
  /** Where to go after the drafts exist (a page address of this panel). */
  readonly navigate: (path: string) => void;
}) {
  const t = useTranslations('catalog.addOffer');
  const [text, setText] = useState(initialText);
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<PlatformSearchAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // The picks outlive a new search or page: a Map keeps them in the order they were ticked.
  const [picked, setPicked] = useState<ReadonlyMap<string, PlatformProduct>>(new Map());
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [barcodeResults, setBarcodeResults] = useState<readonly BarcodeResult[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<
    readonly { productId: string; name: string; key: string }[]
  >([]);
  const [madeDrafts, setMadeDrafts] = useState(0);
  const [defaults, setDefaults] = useState<OfferDefaults | null>(null);
  const [conditionFailed, setConditionFailed] = useState(false);
  const requestId = useRef(0);
  const busy = useRef(false);
  // The first read of an opened dialog does not wait for a pause in typing.
  const firstRead = useRef(true);

  const read = useCallback(async (query: string, pageNo: number, barcodes: readonly string[]) => {
    const id = (requestId.current += 1);
    setLoading(true);
    const result = await callApi<PlatformSearchAnswer>('GET', searchPath(query, pageNo, barcodes));
    // A later request answers; this one is stale.
    if (id !== requestId.current) return null;
    setLoading(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      setFailed(true);
      return null;
    }
    setFailed(false);
    return result.body;
  }, []);

  // Opening reads once what a new draft starts with (the Market's conditions and the seller's
  // last offer); a failed read can be tried again.
  const loadCondition = useCallback(async () => {
    setConditionFailed(false);
    const answer = await loadOfferDefaults();
    if (answer === 'signed-out') window.location.assign('/session-ended');
    else if (answer === 'failed') setConditionFailed(true);
    else setDefaults(answer);
  }, []);
  useEffect(() => {
    if (open && defaults === null) void loadCondition();
  }, [open, defaults, loadCondition]);

  // The search follows the text after a short pause, and the page; closed, nothing is read.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(
      () => {
        firstRead.current = false;
        void read(text, page, []).then((body) => {
          if (body !== null) setAnswer(body);
        });
      },
      firstRead.current ? 0 : DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [open, text, page, read]);

  const toggle = (product: PlatformProduct, on: boolean) => {
    setPicked((current) => {
      const next = new Map(current);
      if (on) next.set(product.productId, product);
      else next.delete(product.productId);
      return next;
    });
  };

  async function findBarcodes() {
    const lines = barcodeLines(pasted);
    if (lines.length === 0) return;
    const body = await read('', 1, lines);
    if (body === null) return;
    setBarcodeResults(body.barcodeResults);
    // Every product found and still free is picked, so one click sells the list.
    setPicked((current) => {
      const next = new Map(current);
      for (const line of body.barcodeResults) {
        if (line.status === 'found' && line.product !== null) {
          next.set(line.product.productId, line.product);
        }
      }
      return next;
    });
  }

  async function sell() {
    if (busy.current || picked.size === 0 || defaults === null) return;
    busy.current = true;
    setSaving(true);
    setProblems([]);
    const created: { productId: string; offerId: string }[] = [];
    const refused: { productId: string; name: string; key: string }[] = [];
    for (const product of picked.values()) {
      const { result, handlingSignedOut } = await createDraftOffer(product, defaults, csrfToken);
      if (handlingSignedOut) {
        window.location.assign('/session-ended');
        return;
      }
      if (result.ok) created.push({ productId: product.productId, offerId: result.body.offerId });
      else if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      } else {
        refused.push({
          productId: product.productId,
          name: product.name ?? product.productCode,
          key: createErrorKey(result.failure.code),
        });
        // Too many requests: the next ones would be refused the same way.
        if (result.failure.code === 'request.throttled') break;
      }
    }
    busy.current = false;
    setSaving(false);
    if (refused.length === 0) {
      navigate(afterSellPath(created.map((item) => item.offerId)));
      return;
    }
    // The dialog stays open: what was created leaves the picks, what was refused stays to be seen.
    setProblems(refused);
    setMadeDrafts((before) => before + created.length);
    setPicked((current) => {
      const next = new Map(current);
      for (const { productId } of created) next.delete(productId);
      return next;
    });
  }

  const count = picked.size;
  const lastPage = answer === null ? 1 : Math.max(1, Math.ceil(answer.total / answer.pageSize));
  const note = useMemo(
    () => (defaults === null ? t('note-loading') : count === 0 ? t('note-pick') : undefined),
    [defaults, count, t],
  );

  return (
    <Dialog
      open={open}
      title={t('title')}
      size="form"
      onClose={() => {
        if (!saving) onClose();
      }}
      actionsNote={note}
      actions={
        <>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void sell()} disabled={count === 0 || defaults === null || saving}>
            {saving ? t('saving') : count > 1 ? t('sell-these', { count }) : t('sell-this')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SearchField
          label={t('search-label')}
          help={t('search-help')}
          placeholder={t('search-placeholder')}
          maxLength={SEARCH_MAX}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPage(1);
          }}
        />
        <div>
          <Button variant="link" onClick={() => setPasteOpen(!pasteOpen)} aria-expanded={pasteOpen}>
            {t('paste')}
          </Button>
        </div>
        {pasteOpen ? (
          <div className="flex flex-col gap-2">
            <TextAreaField
              label={t('paste-label')}
              help={t('paste-help')}
              value={pasted}
              rows={4}
              onChange={(event) => setPasted(event.target.value)}
            />
            <div>
              <Button
                variant="secondary"
                onClick={() => void findBarcodes()}
                disabled={loading || barcodeLines(pasted).length === 0}
              >
                {t('paste-find')}
              </Button>
            </div>
            {barcodeResults === null ? null : (
              <ul className="flex flex-col gap-1 text-sm" aria-label={t('paste-results')}>
                {barcodeResults.map((line) => (
                  <li key={line.input} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{line.input}</span>
                    <Badge tone={line.status === 'found' ? 'success' : 'attention'}>
                      {t(`barcode.${line.status}`)}
                    </Badge>
                    {line.product === null ? null : (
                      <span className="text-fg-muted">
                        {line.product.name ?? line.product.productCode}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {conditionFailed ? (
          <Banner tone="critical">
            <p>{t('condition-error')}</p>
            <Button variant="link" onClick={() => void loadCondition()}>
              {t('try-again')}
            </Button>
          </Banner>
        ) : null}
        {failed ? (
          <Banner tone="critical">
            <p>{t('error')}</p>
            <Button
              variant="link"
              onClick={() => {
                setFailed(false);
                void read(text, page, []).then((body) => {
                  if (body !== null) setAnswer(body);
                });
              }}
            >
              {t('try-again')}
            </Button>
          </Banner>
        ) : null}
        {problems.length === 0 ? null : (
          <Banner tone="critical">
            <p>{t('create-error')}</p>
            <ul className="mt-1 list-disc ps-5 text-sm">
              {problems.map((line) => (
                <li key={line.productId}>{`${line.name}: ${t(`create-reason.${line.key}`)}`}</li>
              ))}
            </ul>
            {madeDrafts > 0 ? (
              <Button variant="link" onClick={() => navigate('/offers?view=drafts')}>
                {t('open-drafts', { count: madeDrafts })}
              </Button>
            ) : null}
          </Banner>
        )}
        {answer?.notice === 'no-activity' ? <Banner tone="info">{t('no-activity')}</Banner> : null}
        {loading && answer === null ? (
          <div role="status" aria-label={t('loading')}>
            <Spinner />
          </div>
        ) : null}
        {answer !== null && answer.notice !== 'no-activity' ? (
          answer.items.length === 0 ? (
            <p className="text-sm text-fg-muted">
              {text.trim() === '' ? t('empty') : t('no-match')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-line" aria-busy={loading}>
              {answer.items.map((product) => (
                <li key={product.productId} className="py-1">
                  <CheckboxRow
                    touch
                    label={product.name ?? product.productCode}
                    help={[
                      product.brandName,
                      product.categoryName,
                      product.productCode,
                      t('sizes', { count: product.variantCount }),
                      product.alreadySelling ? t('already-selling') : null,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                    checked={picked.has(product.productId)}
                    disabled={product.alreadySelling}
                    onChange={(event) => toggle(product, event.target.checked)}
                  />
                </li>
              ))}
            </ul>
          )
        ) : null}
        {answer !== null && lastPage > 1 ? (
          <div className="flex items-center justify-between text-sm">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {t('previous')}
            </Button>
            <span>{t('page', { page, pages: lastPage })}</span>
            <Button
              variant="secondary"
              disabled={page >= lastPage}
              onClick={() => setPage(page + 1)}
            >
              {t('next')}
            </Button>
          </div>
        ) : null}
        {count > 0 ? (
          <div className="flex items-center gap-3 text-sm text-fg-muted">
            <p>{t('picked', { count })}</p>
            <Button variant="link" size="sm" onClick={() => setPicked(new Map())}>
              {t('clear')}
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
