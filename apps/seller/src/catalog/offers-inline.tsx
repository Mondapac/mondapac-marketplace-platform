'use client';

import {
  Badge,
  Button,
  CARD_TABLE,
  Icon,
  SaveBar,
  TextField,
  toast,
  useUnsavedChangesGuard,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { currencySign, formatMinor } from '../price/money.ts';
import {
  customerPaysMinor,
  estimateFor,
  lastEstimateFor,
  useReceiveEstimates,
} from '../price/receive-estimates.ts';
import { canEstimateReceive } from '../price/receive-permissions.ts';
import { PRICE_EDIT_PERMISSION, PRICE_VIEW_PERMISSION } from '../price/types.ts';
import { STOCK_EDIT_PERMISSION } from '../stock/levels-types.ts';
import { STOCK_VIEW_PERMISSION, type SourcesView, type SourceView } from '../stock/types.ts';
import { useGuardedCall } from '../step-up/step-up.tsx';
import { moveOnEnter } from './grid-keys.ts';
import {
  changeLines,
  inlineOffersOf,
  plansOf,
  priceRange,
  rowEditing,
  stockKey,
  stockTotal,
  withDraft,
  withoutSaved,
  basesAfterSave,
  type Drafts,
  type InlineOffer,
  type OffersPricesAnswer,
  type OffersStockAnswer,
} from './offers-inline-logic.ts';
import { sizeStatusOf, type SizeStatus } from './quick-entry-logic.ts';
import { sendSizeWrites } from './size-writes.ts';
import type { OfferSellUnitsView } from './types.ts';
import { savedPriceText, savedStockText, type TableRow } from './variants-table-logic.ts';

const STATUS_TONE: Record<SizeStatus, BadgeTone> = {
  ready: 'success',
  'needs-price': 'attention',
  'check-price': 'critical',
  'needs-stock': 'attention',
  'check-stock': 'critical',
  'out-of-stock': 'neutral',
  'not-sold': 'neutral',
};

/** What the seller may see and change in the list's price and stock cells. */
export interface InlineAccess {
  readonly seePrice: boolean;
  readonly editPrice: boolean;
  readonly seeStock: boolean;
  readonly editStock: boolean;
  readonly estimate: boolean;
}

export function inlineAccessOf(keys: readonly string[]): InlineAccess {
  const seePrice = keys.includes(PRICE_VIEW_PERMISSION);
  const seeStock = keys.includes(STOCK_VIEW_PERMISSION);
  return {
    seePrice,
    editPrice: seePrice && keys.includes(PRICE_EDIT_PERMISSION),
    seeStock,
    editStock: seeStock && keys.includes(STOCK_EDIT_PERMISSION),
    estimate: canEstimateReceive(keys),
  };
}

/** The Offer of a row, as the list knows it: its id and the name it goes by. */
export interface InlineRow {
  readonly offerId: string;
  readonly name: string;
}

/** What the Offer list draws for prices and stock: two cells, the opened sizes and the save bar. */
export interface OffersInline {
  readonly access: InlineAccess;
  /** False when the reads failed: the cells show a dash and the page says why. */
  readonly readFailed: boolean;
  readonly priceCell: (row: InlineRow) => ReactNode;
  readonly stockCell: (row: InlineRow) => ReactNode;
  /** The sizes of the opened row, else null. */
  readonly expanded: (row: InlineRow) => ReactNode;
  /** The save bar (in a form of its own) and the leave dialog. */
  readonly footer: ReactNode;
}

/**
 * Editing prices and stock right in the Offer list (Offer page PR 8, design section 7, john's
 * choice of 25 Nov: the sizes open under their Offer). The page's prices and stock are read in one
 * request each. An Offer with one size edits its price, and with one location its stock, in the
 * row; one with several sizes or locations opens them under the row ("N sizes", one row open at a
 * time). Typing changes nothing on the server: "Save N changes" sends each changed cell through
 * the same pricing and inventory writes as the Offer page, so every rule of those writes holds
 * (stock not below what is held, a special below the regular price, a big price change held for
 * review). Typed values stay while the seller moves between pages, until saved or discarded.
 */
export function useOffersInline({
  rows,
  permissionKeys,
  csrfToken,
}: {
  readonly rows: readonly InlineRow[];
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
}): OffersInline {
  const t = useTranslations();
  const locale = useLocale();
  const guarded = useGuardedCall();
  const access = inlineAccessOf(permissionKeys);
  const [offers, setOffers] = useState<ReadonlyMap<string, InlineOffer>>(new Map());
  const [currency, setCurrency] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  const [labels, setLabels] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>(
    {},
  );
  const [sources, setSources] = useState<readonly SourceView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<Drafts>({});
  const [stockDrafts, setStockDrafts] = useState<Drafts>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The version each typed cell was read at, kept from its first keystroke: a later read (back on
  // the page, or after a save) never moves a draft onto a newer version, so a value changed
  // elsewhere meanwhile is refused as changed, not overwritten. Keys are those of `sendSizeWrites`.
  const [bases, setBases] = useState<
    Readonly<Record<string, Readonly<Record<string, number | null>>>>
  >({});
  // The drafts as they are now, for the end of a save that awaited while the seller typed on.
  const priceDraftsRef = useRef(priceDrafts);
  const stockDraftsRef = useRef(stockDrafts);
  useEffect(() => {
    priceDraftsRef.current = priceDrafts;
    stockDraftsRef.current = stockDrafts;
  }, [priceDrafts, stockDrafts]);
  const busy = useRef(false);
  // Only the newest read counts: a slow answer for a page the seller has left is dropped.
  const readSeq = useRef(0);
  const idsKey = rows.map((row) => row.offerId).join(',');

  useEffect(() => {
    setNames((old) => {
      const next = { ...old };
      for (const row of rows) next[row.offerId] = row.name;
      return next;
    });
  }, [rows]);

  const read = useCallback(
    async (ids: string) => {
      if (ids === '' || (!access.seePrice && !access.seeStock)) return;
      const seq = ++readSeq.current;
      const [prices, stock] = await Promise.all([
        access.seePrice
          ? callApi<OffersPricesAnswer>('GET', `pricing/seller/offer-prices?offerIds=${ids}`)
          : Promise.resolve(null),
        access.seeStock
          ? callApi<OffersStockAnswer>('GET', `inventory/seller/offer-stock?offerIds=${ids}`)
          : Promise.resolve(null),
      ]);
      if (seq !== readSeq.current) return;
      if (
        (prices !== null && !prices.ok && prices.failure.status === 401) ||
        (stock !== null && !stock.ok && stock.failure.status === 401)
      ) {
        window.location.assign('/session-ended');
        return;
      }
      // A seller with no stock locations yet has no stock to show: that is not a failure.
      const stockFailed =
        stock !== null && !stock.ok && stock.failure.code !== 'inventory.not-ready';
      setReadFailed((prices !== null && !prices.ok) || stockFailed);
      if (prices?.ok === true) setCurrency(prices.body.currency);
      const fresh = inlineOffersOf(
        prices?.ok === true ? prices.body : null,
        stock?.ok === true ? stock.body : null,
      );
      setOffers((old) => {
        const next = new Map(old);
        for (const [id, offer] of fresh) next.set(id, offer);
        return next;
      });
    },
    [access.seePrice, access.seeStock],
  );

  useEffect(() => {
    void read(idsKey);
  }, [read, idsKey]);

  const plans = plansOf(offers, currency, priceDrafts, stockDrafts);
  const changeCount = plans.reduce(
    (sum, plan) => sum + plan.writes.length + plan.invalid.length,
    0,
  );
  const canSave = access.editPrice || access.editStock;

  const guard = useUnsavedChangesGuard(
    canSave && changeCount > 0 && !leaving,
    {
      title: t('settings.leave.title'),
      message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
      stay: t('settings.leave.stay'),
      leave: t('settings.leave.leave'),
    },
    { count: changeCount, page: t('catalog.offers.title') },
  );

  const errorKey = (offerId: string, key: string) => `${offerId}|${key}`;
  const sizeName = (offerId: string, variantId: string): string => {
    const offer = offers.get(offerId);
    const name = names[offerId] ?? '';
    if (offer === undefined || offer.rows.length <= 1) return name;
    const label = labels[offerId]?.[variantId];
    return label === undefined ? name : `${name} ${label}`;
  };

  async function openSizes(offerId: string) {
    const opening = openId !== offerId;
    setOpenId(opening ? offerId : null);
    if (!opening) return;
    const offer = offers.get(offerId);
    if (offer === undefined) return;
    const reads: Promise<void>[] = [];
    if (labels[offerId] === undefined && offer.rows.length > 1) {
      reads.push(
        callApi<OfferSellUnitsView>('GET', `catalog/seller/offers/${offerId}/sell-units`).then(
          (result) => {
            if (!result.ok) return;
            const named: Record<string, string> = {};
            result.body.units.forEach((unit, index) => {
              named[unit.variantId] =
                unit.label ?? t('catalog.offers.inline.size-n', { number: index + 1 });
            });
            setLabels((old) => ({ ...old, [offerId]: named }));
          },
        ),
      );
    }
    if (sources === null && offer.sourceIds.length > 1) {
      reads.push(
        callApi<SourcesView>('GET', 'inventory/seller/sources').then((result) => {
          if (result.ok) setSources(result.body.sources);
        }),
      );
    }
    await Promise.all(reads);
  }

  /** Records the version a cell was read at, the first time it is typed in. */
  function keepBase(offerId: string, key: string, version: number | null) {
    setBases((old) =>
      old[offerId] !== undefined && key in old[offerId]
        ? old
        : { ...old, [offerId]: { ...(old[offerId] ?? {}), [key]: version } },
    );
  }

  async function save() {
    if (busy.current) return;
    const found: Record<string, string> = {};
    for (const plan of plans) {
      for (const item of plan.invalid) {
        found[errorKey(plan.offer.offerId, item.key)] =
          item.kind === 'price' ? t('price.error.invalid') : t('stock.levels.error.invalid');
      }
    }
    setErrors(found);
    const toSend = plans.filter((plan) => plan.writes.length > 0);
    if (toSend.length === 0) return;
    busy.current = true;
    setSaving(true);
    const sentPrices = priceDrafts;
    const sentStocks = stockDrafts;
    const savedPrices: Record<string, string[]> = {};
    const savedStocks: Record<string, string[]> = {};
    const seenAll: Record<string, Readonly<Record<string, number | null>>> = {};
    const stalePrice = t('price.error.stale');
    const staleStock = t('catalog.offers.inline.stock-stale');
    const stalePrices: Record<string, string[]> = {};
    const staleStocks: Record<string, string[]> = {};
    let done = 0;
    let stopped = false;
    let waitSeconds: number | null = null;
    for (const plan of toSend) {
      const offerId = plan.offer.offerId;
      const sent = await sendSizeWrites({
        offerId,
        rows: plan.offer.rows,
        writes: plan.writes,
        currency,
        versions: bases[offerId] ?? {},
        csrfToken,
        guarded,
        messages: {
          throttledCell: t('catalog.variants-table.throttled-cell'),
          price: (problem) => t(`price.error.${problem}`),
          stock: (problem) =>
            problem === 'stale' ? staleStock : t(`stock.levels.error.${problem}`),
        },
      });
      if (sent.signedOut) {
        flushSync(() => setLeaving(true));
        window.location.assign('/session-ended');
        return;
      }
      for (const [key, message] of Object.entries(sent.found)) {
        found[errorKey(offerId, key)] = message;
        // A cell changed elsewhere: its draft goes, so it shows the stored value read again
        // below, with this message, and a new value is typed on the current version.
        if (message === stalePrice) (stalePrices[offerId] ??= []).push(key);
        if (message === staleStock) (staleStocks[offerId] ??= []).push(key);
      }
      savedPrices[offerId] = [...sent.savedPrices];
      savedStocks[offerId] = [...sent.savedStocks];
      seenAll[offerId] = sent.seen;
      done += sent.done;
      if (sent.stopped) {
        stopped = true;
        waitSeconds = sent.waitSeconds;
        break;
      }
    }
    // The saved values are read again first, so a saved cell never shows its old value.
    const stale = Object.keys(stalePrices).length + Object.keys(staleStocks).length > 0;
    if (done > 0 || stale) await read(idsKey);
    busy.current = false;
    setSaving(false);
    const leftPrices = withoutSaved(
      withoutSaved(priceDraftsRef.current, savedPrices, sentPrices),
      stalePrices,
      sentPrices,
    );
    const leftStocks = withoutSaved(
      withoutSaved(stockDraftsRef.current, savedStocks, sentStocks),
      staleStocks,
      sentStocks,
    );
    setPriceDrafts(leftPrices);
    setStockDrafts(leftStocks);
    setBases((old) => basesAfterSave(old, seenAll, leftPrices, leftStocks));
    setErrors(found);
    const failed = Object.keys(found).length;
    // A cell that failed on an Offer of another page shows its message only there: name it here.
    const elsewhere = [
      ...new Set(
        Object.keys(found)
          .map((key) => key.split('|')[0] ?? '')
          .filter((offerId) => !rows.some((row) => row.offerId === offerId)),
      ),
    ].map((offerId) => names[offerId] ?? offerId);
    if (elsewhere.length > 0) {
      toast.warning(t('catalog.offers.inline.failed-elsewhere', { names: elsewhere.join(', ') }));
    }
    if (waitSeconds !== null) {
      toast.warning(
        t('catalog.variants-table.throttled', {
          done,
          minutes: Math.max(1, Math.ceil(waitSeconds / 60)),
        }),
      );
    } else if (done > 0 && failed === 0 && !stopped) {
      toast.success(t('catalog.variants-table.saved', { count: done }));
    } else if (stopped) {
      toast.info(
        done > 0
          ? t('catalog.offers.inline.stopped', { done })
          : t('catalog.variants-table.cancelled'),
      );
    } else if (done > 0) toast.info(t('catalog.variants-table.partial', { done, failed }));
  }

  function discard() {
    setPriceDrafts({});
    setStockDrafts({});
    setBases({});
    setErrors({});
  }

  const money = (minor: string) => formatMinor(minor, currency, locale);
  const lines = changeLines(plans);
  const first = lines[0];
  const firstLine =
    first === undefined
      ? null
      : t(`catalog.offers.inline.change-${first.kind}`, {
          size: sizeName(first.offerId, first.variantId),
          from:
            first.from === null
              ? t('catalog.offers.inline.none')
              : first.kind === 'price'
                ? money(first.from)
                : first.from,
          to: first.kind === 'price' ? money(first.to) : first.to,
        });
  const summary = [
    t('settings.bar.summary', { count: changeCount }),
    firstLine,
    lines.length > 1 ? t('catalog.offers.inline.and-more', { count: lines.length - 1 }) : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  /** The toggle that opens an Offer's sizes (or locations) under its row. */
  function toggle(row: InlineRow, offer: InlineOffer, opens: 'sizes' | 'locations') {
    const open = openId === row.offerId;
    return (
      <Button
        variant="link"
        size="sm"
        className="h-auto px-0 py-0.5"
        aria-expanded={open}
        aria-controls={open ? `${row.offerId}-more` : undefined}
        onClick={() => void openSizes(row.offerId)}
      >
        {opens === 'sizes'
          ? t('catalog.offers.inline.sizes', { count: offer.rows.length })
          : t('catalog.offers.inline.locations', { count: offer.sourceIds.length })}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="size-4" />
      </Button>
    );
  }

  const priceField = (row: InlineRow, offer: InlineOffer, size: TableRow, label: string) => (
    <div className="w-28 [&_label]:sr-only">
      <TextField
        name={`price-${size.variantId}`}
        prefix={currencySign(currency, locale)}
        label={t('price.field', { currency })}
        aria-label={label}
        inputMode="decimal"
        value={priceDrafts[row.offerId]?.[size.variantId] ?? savedPriceText(size, currency)}
        error={errors[errorKey(row.offerId, size.variantId)]}
        onChange={(event) => {
          keepBase(offer.offerId, `price:${size.variantId}`, size.price?.seriesVersion ?? null);
          setPriceDrafts((old) =>
            withDraft(old, offer.offerId, size.variantId, event.target.value),
          );
        }}
      />
    </div>
  );

  const stockField = (
    row: InlineRow,
    offer: InlineOffer,
    size: TableRow,
    sourceId: string,
    label: string,
  ) => {
    const key = stockKey(size.variantId, sourceId);
    return (
      <div className="w-20 [&_label]:sr-only">
        <TextField
          name={`onHand-${key}`}
          label={t('stock.levels.on-hand')}
          aria-label={label}
          inputMode="numeric"
          value={stockDrafts[row.offerId]?.[key] ?? savedStockText(size, sourceId)}
          error={errors[errorKey(row.offerId, key)]}
          onChange={(event) => {
            keepBase(offer.offerId, `stock:${key}`, size.stock[sourceId]?.version ?? null);
            setStockDrafts((old) => withDraft(old, offer.offerId, key, event.target.value));
          }}
        />
      </div>
    );
  };

  function priceCell(row: InlineRow): ReactNode {
    const offer = offers.get(row.offerId);
    if (offer === undefined || offer.rows.length === 0) return <Dash />;
    const editing = rowEditing(offer);
    const size = offer.rows[0] as TableRow;
    if (editing.price) {
      const draft = priceDrafts[row.offerId]?.[size.variantId];
      return (
        <div className={`flex flex-col gap-1 ${access.editPrice ? 'lg:-mt-2.5' : ''}`}>
          {access.editPrice ? (
            priceField(row, offer, size, t('catalog.offers.inline.price-of', { product: row.name }))
          ) : size.price?.inForce == null ? (
            <Dash />
          ) : (
            <span className="tabular-nums">{money(size.price.inForce.amount)}</span>
          )}
          {access.editPrice && draft === undefined && size.price?.inForce == null ? (
            <span className="text-xs text-fg-muted">
              {t('catalog.quick-entry.state.needs-price')}
            </span>
          ) : null}
          <PriceNotes size={size} money={money} />
          {access.estimate && draft !== undefined ? (
            <DraftEstimate
              offerId={row.offerId}
              size={size}
              draft={draft}
              currency={currency}
              locale={locale}
            />
          ) : null}
        </div>
      );
    }
    const range = priceRange(offer.rows);
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="tabular-nums">
          {range === null ? (
            <Dash />
          ) : range.min === range.max ? (
            money(range.min)
          ) : (
            t('catalog.offers.inline.range', { min: money(range.min), max: money(range.max) })
          )}
        </span>
        {editing.opens === 'sizes' ? toggle(row, offer, 'sizes') : null}
      </div>
    );
  }

  function stockCell(row: InlineRow): ReactNode {
    const offer = offers.get(row.offerId);
    if (offer === undefined || offer.rows.length === 0 || offer.sourceIds.length === 0) {
      return <Dash />;
    }
    const editing = rowEditing(offer);
    const size = offer.rows[0] as TableRow;
    if (editing.stock && access.editStock) {
      return (
        <div className="lg:-mt-2.5">
          {stockField(
            row,
            offer,
            size,
            offer.sourceIds[0] as string,
            t('catalog.offers.inline.stock-of', { product: row.name }),
          )}
        </div>
      );
    }
    const total = stockTotal(offer.rows);
    return (
      <div className="flex flex-col items-start gap-1">
        <span className="tabular-nums">{total === null ? <Dash /> : total}</span>
        {editing.opens === 'locations' || (editing.opens === 'sizes' && !access.seePrice)
          ? toggle(row, offer, editing.opens)
          : null}
      </div>
    );
  }

  function expanded(row: InlineRow): ReactNode {
    if (openId !== row.offerId) return null;
    const offer = offers.get(row.offerId);
    if (offer === undefined) return null;
    const located = offer.sourceIds.map(
      (id, index) =>
        sources?.find((source) => source.id === id) ?? {
          id,
          name: t('catalog.offers.inline.location-n', { number: index + 1 }),
        },
    );
    const sizeLabel = (size: TableRow, index: number) =>
      labels[row.offerId]?.[size.variantId] ??
      (offer.rows.length === 1 ? '' : t('catalog.offers.inline.size-n', { number: index + 1 }));
    return (
      <SizesPanel
        row={row}
        offer={offer}
        locations={located}
        access={access}
        currency={currency}
        locale={locale}
        priceDrafts={priceDrafts[row.offerId] ?? {}}
        stockDrafts={stockDrafts[row.offerId] ?? {}}
        sizeLabel={sizeLabel}
        priceField={(size, label) => priceField(row, offer, size, label)}
        stockField={(size, sourceId, label) => stockField(row, offer, size, sourceId, label)}
        money={money}
      />
    );
  }

  const footer = (
    <>
      {canSave ? (
        <p className="mt-2 text-sm text-fg-muted">{t('catalog.offers.inline.keys')}</p>
      ) : null}
      {canSave ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <SaveBar
            count={changeCount}
            summary={summary}
            saving={saving}
            aboveBottomBar
            labels={{
              region: t('settings.bar.region'),
              discard: t('settings.bar.discard'),
              save: t('catalog.variants-table.save', { count: changeCount }),
              saving: t('catalog.variants-table.save', { count: changeCount }),
            }}
            onDiscard={discard}
          />
        </form>
      ) : null}
      {canSave && changeCount > 0 ? guard.dialog : null}
    </>
  );

  return { access, readFailed, priceCell, stockCell, expanded, footer };
}

/** A held price (waiting for review) and a running special, under the price of a size. */
function PriceNotes({
  size,
  money,
}: {
  readonly size: TableRow;
  readonly money: (minor: string) => string;
}) {
  const t = useTranslations('catalog.offers.inline');
  const price = size.price;
  if (price === null) return null;
  return (
    <>
      {price.held === null ? null : (
        <span className="text-xs text-fg-muted">
          {t('held', { amount: money(price.held.amount) })}
        </span>
      )}
      {price.special?.state === 'running' ? (
        <span className="text-xs text-fg-muted">
          {t('special', { amount: money(price.special.amount) })}
        </span>
      ) : null}
    </>
  );
}

/** "You receive (est.)" of a price the seller is typing in a row, read after a short pause. */
function DraftEstimate({
  offerId,
  size,
  draft,
  currency,
  locale,
}: {
  readonly offerId: string;
  readonly size: TableRow;
  readonly draft: string;
  readonly currency: string;
  readonly locale: string;
}) {
  const t = useTranslations();
  const amount = customerPaysMinor(size.price, draft, currency);
  const state = useReceiveEstimates(offerId, { [size.variantId]: amount }, true);
  const estimate = estimateFor(state, size.variantId, amount);
  const shown = estimate ?? (amount === null ? null : lastEstimateFor(state, size.variantId));
  if (shown === null) return null;
  const formatted = formatMinor(shown.youReceiveMinor, currency, locale);
  return (
    <span
      className={`text-xs ${estimate === null ? 'text-fg-muted' : ''}`}
      aria-busy={estimate === null}
      aria-live="polite"
    >
      {/* "≈ amount", as in the opened sizes; a screen reader hears the whole phrase. */}
      <span aria-hidden="true">
        {t('catalog.variants-table.receive.value', { amount: formatted })}
      </span>
      <span className="sr-only">{t('catalog.offers.inline.receive', { amount: formatted })}</span>
      {shown.taxInclusive ? null : ` ${t('catalog.variants-table.receive.before-tax')}`}
    </span>
  );
}

/** The sizes of one Offer under its row: a small table of price, stock and status per size. */
function SizesPanel({
  row,
  offer,
  locations,
  access,
  currency,
  locale,
  priceDrafts,
  stockDrafts,
  sizeLabel,
  priceField,
  stockField,
  money,
}: {
  readonly row: InlineRow;
  readonly offer: InlineOffer;
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly access: InlineAccess;
  readonly currency: string;
  readonly locale: string;
  readonly priceDrafts: Readonly<Record<string, string>>;
  readonly stockDrafts: Readonly<Record<string, string>>;
  readonly sizeLabel: (size: TableRow, index: number) => string;
  readonly priceField: (size: TableRow, label: string) => ReactNode;
  readonly stockField: (size: TableRow, sourceId: string, label: string) => ReactNode;
  readonly money: (minor: string) => string;
}) {
  const t = useTranslations();
  const showReceive = access.estimate && access.seePrice;
  const customerPays = Object.fromEntries(
    offer.rows.map((size) => [
      size.variantId,
      showReceive ? customerPaysMinor(size.price, priceDrafts[size.variantId], currency) : null,
    ]),
  );
  const estimates = useReceiveEstimates(row.offerId, customerPays, showReceive);
  const sourceIds = access.seeStock ? offer.sourceIds : [];
  const many = offer.rows.length > 1;
  // One labelled line of a size's card below 1024 px; a plain cell from 1024 px.
  const cardLine = `${CARD_TABLE.labelled} lg:p-2`;

  return (
    // From 1024 px a table; below it each size is a card (size name, status, labelled lines), as
    // in the list itself.
    <div className="relative lg:overflow-x-auto">
      <table
        className={CARD_TABLE.table}
        onKeyDown={(event) => {
          moveOnEnter(event);
          // The list's own table moves on Enter too: this table's Enter is handled here only.
          if (event.key === 'Enter') event.stopPropagation();
        }}
        aria-label={t('catalog.offers.inline.sizes-of', { product: row.name })}
      >
        <thead className="text-fg-muted max-lg:sr-only">
          <tr>
            {many ? (
              <th scope="col" className="p-2 font-medium">
                {t('catalog.variants-table.variant')}
              </th>
            ) : null}
            {access.seePrice ? (
              <th scope="col" className="p-2 font-medium">
                {t('catalog.variants-table.your-price')}
              </th>
            ) : null}
            {showReceive ? (
              <th scope="col" className="p-2 font-medium">
                {t('catalog.variants-table.receive.column')}
              </th>
            ) : null}
            {sourceIds.length === 0
              ? null
              : locations.map((location) => (
                  <th key={location.id} scope="col" className="p-2 font-medium">
                    {locations.length > 1
                      ? t('catalog.quick-entry.stock-at', { location: location.name })
                      : t('catalog.quick-entry.stock')}
                  </th>
                ))}
            <th scope="col" className="p-2 font-medium">
              {t('catalog.quick-entry.status')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {offer.rows.map((size, index) => {
            const label = sizeLabel(size, index);
            const retired = size.price?.retired === true;
            const status = sizeStatusOf(
              size,
              currency,
              sourceIds,
              priceDrafts,
              stockDrafts,
              access.seePrice,
            );
            const amount = customerPays[size.variantId] ?? null;
            const estimate = estimateFor(estimates, size.variantId, amount);
            const shown =
              estimate ?? (amount === null ? null : lastEstimateFor(estimates, size.variantId));
            return (
              <tr
                key={size.variantId}
                className={`${CARD_TABLE.row} lg:align-middle lg:[&>*]:align-middle max-lg:px-0`}
              >
                {many ? (
                  <th
                    scope="row"
                    className="whitespace-nowrap p-2 text-start font-medium max-lg:p-0 lg:font-normal"
                  >
                    {label}
                  </th>
                ) : null}
                {access.seePrice ? (
                  <td className={cardLine} data-label={t('catalog.variants-table.your-price')}>
                    <div className="flex flex-col gap-1">
                      {access.editPrice && offer.priced && !retired ? (
                        priceField(
                          size,
                          t('catalog.quick-entry.price-for', { product: row.name, size: label }),
                        )
                      ) : size.price?.inForce == null ? (
                        <Dash />
                      ) : (
                        <span className="tabular-nums">{money(size.price.inForce.amount)}</span>
                      )}
                      <PriceNotes size={size} money={money} />
                    </div>
                  </td>
                ) : null}
                {showReceive ? (
                  <td
                    className={`${cardLine} tabular-nums`}
                    data-label={t('catalog.variants-table.receive.column')}
                  >
                    {shown === null ? (
                      <Dash />
                    ) : (
                      <span
                        className={estimate === null ? 'text-fg-muted' : undefined}
                        aria-busy={estimate === null}
                      >
                        {t('catalog.variants-table.receive.value', {
                          amount: formatMinor(shown.youReceiveMinor, currency, locale),
                        })}
                        {shown.taxInclusive ? null : (
                          <span className="block text-xs text-fg-muted">
                            {t('catalog.variants-table.receive.before-tax')}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                ) : null}
                {sourceIds.length === 0
                  ? null
                  : locations.map((location) => {
                      const cell = size.stock[location.id];
                      return (
                        <td
                          key={location.id}
                          className={cardLine}
                          data-label={
                            locations.length > 1
                              ? t('catalog.quick-entry.stock-at', { location: location.name })
                              : t('catalog.quick-entry.stock')
                          }
                        >
                          {access.editStock && !retired ? (
                            stockField(
                              size,
                              location.id,
                              t('catalog.quick-entry.stock-for', {
                                product: row.name,
                                size: label === '' ? row.name : label,
                                location: location.name,
                              }),
                            )
                          ) : cell === undefined ? (
                            <Dash />
                          ) : (
                            <span className="tabular-nums">{cell.onHand}</span>
                          )}
                        </td>
                      );
                    })}
                <td
                  className={
                    many
                      ? 'p-2 max-lg:col-start-2 max-lg:row-start-1 max-lg:p-0'
                      : 'p-2 max-lg:col-span-full max-lg:p-0'
                  }
                >
                  <Badge tone={STATUS_TONE[status]}>
                    {t(`catalog.quick-entry.state.${status}`)}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** An empty value: an em dash in the muted colour. */
function Dash() {
  return <span className="text-fg-muted">{'—'}</span>;
}
