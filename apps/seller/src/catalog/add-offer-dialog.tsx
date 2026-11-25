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
import type { ProductOptions } from './types.ts';

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

/** The condition a new draft Offer starts with: `new` when the Market has it, else the first. */
export function defaultCondition(conditions: readonly string[]): string | null {
  return conditions.includes('new') ? 'new' : (conditions[0] ?? null);
}

interface Created {
  readonly offerId: string;
}

/**
 * "Add offer" (Offer page design, PR 1): the seller searches the platform products they are allowed
 * to sell (their business activities decide), ticks one or more, or pastes a list of barcodes, and
 * "Sell this" / "Sell these (N)" creates one draft Offer for each. One product opens its Offer;
 * several open the Drafts tab. A product the seller already sells is shown, not selectable.
 */
export function AddOfferDialog({
  open,
  csrfToken,
  onClose,
  navigate,
}: {
  readonly open: boolean;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** Where to go after the drafts exist (a page address of this panel). */
  readonly navigate: (path: string) => void;
}) {
  const t = useTranslations('catalog.addOffer');
  const [text, setText] = useState('');
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
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [condition, setCondition] = useState<string | null>(null);
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

  // Opening reads the Market's conditions once (the default of a new draft Offer).
  useEffect(() => {
    if (!open || condition !== null) return;
    void callApi<ProductOptions>('GET', 'catalog/seller/products/options').then((result) => {
      if (result.ok) setCondition(defaultCondition(result.body.conditions));
    });
  }, [open, condition]);

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
    if (busy.current || picked.size === 0 || condition === null) return;
    busy.current = true;
    setSaving(true);
    setProblems([]);
    const created: string[] = [];
    const refused: string[] = [];
    for (const product of picked.values()) {
      const result = await callApi<Created>(
        'POST',
        'catalog/seller/offers',
        {
          productId: product.productId,
          // The product code is unique in the Market, so it is a free SKU to start from.
          sellerSku: product.productCode,
          conditionCode: condition,
          description: {},
        },
        csrfToken,
      );
      if (result.ok) created.push(result.body.offerId);
      else if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      } else refused.push(`${product.name ?? product.productCode}: ${result.failure.code}`);
    }
    busy.current = false;
    setSaving(false);
    if (refused.length > 0) {
      setProblems(refused);
      // What was created leaves the picks; the rest stays to try again.
      setPicked((current) => {
        const next = new Map(current);
        for (const [id, product] of current) {
          if (!refused.some((line) => line.startsWith(`${product.name ?? product.productCode}:`))) {
            next.delete(id);
          }
        }
        return next;
      });
      if (created.length === 0) return;
    }
    if (created.length === 1 && refused.length === 0) navigate(`/offers/${created[0]}`);
    else navigate('/offers?view=drafts');
  }

  const count = picked.size;
  const lastPage = answer === null ? 1 : Math.max(1, Math.ceil(answer.total / answer.pageSize));
  const note = useMemo(
    () => (condition === null ? t('note-loading') : count === 0 ? t('note-pick') : undefined),
    [condition, count, t],
  );

  return (
    <Dialog
      open={open}
      title={t('title')}
      size="form"
      onClose={onClose}
      actionsNote={note}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void sell()}
            disabled={count === 0 || condition === null || saving}
          >
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
        {failed ? <Banner tone="critical">{t('error')}</Banner> : null}
        {problems.length === 0 ? null : (
          <Banner tone="critical">
            <p>{t('create-error')}</p>
            <ul className="mt-1 list-disc ps-5 text-sm">
              {problems.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Banner>
        )}
        {answer?.notice === 'no-activity' ? <Banner tone="info">{t('no-activity')}</Banner> : null}
        {loading && answer === null ? <Spinner /> : null}
        {answer !== null && answer.notice !== 'no-activity' ? (
          answer.items.length === 0 ? (
            <p className="text-sm text-fg-muted">
              {text.trim() === '' ? t('empty') : t('no-match')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border" aria-busy={loading}>
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
        {count > 0 ? <p className="text-sm text-fg-muted">{t('picked', { count })}</p> : null}
      </div>
    </Dialog>
  );
}
