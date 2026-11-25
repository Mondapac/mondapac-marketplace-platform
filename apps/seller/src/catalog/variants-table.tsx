'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  Icon,
  SaveBar,
  Select,
  TextField,
  toast,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { formatMinor, inputOf, minorOf } from '../price/money.ts';
import {
  customerPaysMinor,
  estimateFor,
  lastEstimateFor,
  useReceiveEstimates,
} from '../price/receive-estimates.ts';
import { formatDayInZone, resolveZone } from '../price/zone-time.ts';
import type { SourceView } from '../stock/types.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { priceProblemOf } from '../price/errors.ts';
import type { SpecialWithdrawn } from '../price/types.ts';
import {
  increasedBy,
  isSpecialTyped,
  orderedWrites,
  savedPriceText,
  savedStockText,
  specialKey,
  specialWritesOf,
  stockKey,
  writesOf,
  type SpecialDraft,
  type TableRow,
} from './variants-table-logic.ts';
import { SizeSpecial } from './size-special.tsx';
import { unitProblemOf, variantOfPath } from './sell-unit-errors.ts';
import {
  fallbackSku,
  isLastSelling,
  skuPlaceholder,
  unitPlanOf,
  type UnitRow,
} from './sell-unit-logic.ts';
import { CHECKBOX, SkuField } from './sku-field.tsx';
import { SizeDetails, sizeTabsOf, type ReceiveView, type SizeTab } from './size-details.tsx';
import { focusFirstPrice, moveOnEnter } from './grid-keys.ts';
import { SizeRequests } from './size-requests.tsx';
import { sendSizeWrites } from './size-writes.ts';
import type { SizeRequestsData } from './size-request-logic.ts';
import { LastSizeHint, SizesYouSell } from './sizes-you-sell.tsx';
import { VariantFileTools } from './variant-file-tools.tsx';
import type { CellChange, FileModel } from './variant-file.ts';

type Bulk = 'price' | 'increase' | 'stock';

/** Column widths in rem. Inputs are w-28 (price), w-24 (stock) and w-40 (SKU) inside p-2 cells. */
const COL = {
  variant: 8,
  onSale: 6,
  price: 8,
  pays: 9,
  receive: 7,
  stock: 7,
  sku: 11,
  details: 7,
} as const;

const unitError = (name: string): string => `catalog.variants-table.units.error.${name}`;

/**
 * Price, special price and stock of every variant of one offer in one table (variants V3b). The
 * "Customers pay now" column shows what the shop charges (a running special wins); a size's special
 * price is set and ended in its Details (Offer page PR 6) and saved with the rest.
 * Cells are drafts; a bulk action (set price, increase by a percent, set stock) fills the drafts
 * of the selected rows, and Save sends only the cells that changed, one write each, through the
 * same pricing and inventory routes as the price and stock pages. The server decides every write.
 */
export function VariantsTable({
  offerId,
  rows,
  sources,
  currency: marketCurrency,
  canEditPrice: mayEditPrice,
  canEditStock,
  units,
  csrfToken,
  fileModel = null,
  sizeRequests = null,
  canEstimate = false,
  focusPrice = false,
}: {
  readonly offerId: string;
  readonly rows: readonly TableRow[];
  readonly sources: readonly SourceView[];
  /** The Market currency; null when the seller may not see prices (no price columns then). */
  readonly currency: string | null;
  readonly canEditPrice: boolean;
  readonly canEditStock: boolean;
  /**
   * The SKU and Selling columns (variants V5); null when the seller may not view the catalog.
   * `canEdit` is the key `catalog.own-product.edit`; a PLATFORM product also shows "Sizes you sell".
   */
  readonly units?: {
    readonly canEdit: boolean;
    readonly productScope: 'PLATFORM' | 'SELLER';
    readonly sellerSku: string;
  } | null;
  readonly csrfToken: string;
  /** The variant file (design 14b); null when the seller may not read the product. */
  readonly fileModel?: FileModel | null;
  /** Request a size and the seller's requests (variants V7); null when the product takes none. */
  readonly sizeRequests?: SizeRequestsData | null;
  /**
   * "You receive (est.)" (Offer page PR 4): the seller holds the price view key and the seller
   * ledger key. Shown only with the price columns.
   */
  readonly canEstimate?: boolean;
  /** A draft just created with "Sell this" (Offer page PR 5): the cursor starts on a price. */
  readonly focusPrice?: boolean;
}) {
  const t = useTranslations();
  const showPrice = marketCurrency !== null;
  const currency = marketCurrency ?? '';
  const canEditPrice = mayEditPrice && showPrice;
  const locale = useLocale();
  const router = useRouter();
  const guarded = useGuardedCall();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});
  const [specialDrafts, setSpecialDrafts] = useState<Record<string, SpecialDraft>>({});
  // End special: the size whose request runs, and why the last one was refused.
  const [ending, setEnding] = useState<string | null>(null);
  const [endErrors, setEndErrors] = useState<Record<string, string>>({});
  const zone = resolveZone(useTimeZone());
  const [versions, setVersions] = useState<Record<string, number | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [bulkValue, setBulkValue] = useState('');
  const [bulkSource, setBulkSource] = useState(sources[0]?.id ?? '');
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [skuDrafts, setSkuDrafts] = useState<Record<string, string>>({});
  const [sellingDrafts, setSellingDrafts] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [moreToScroll, setMoreToScroll] = useState(false);
  // Details: one size open at a time (Offer page PR 3); its drafts stay when it closes.
  const [openId, setOpenId] = useState<string | null>(null);
  const [sizeTab, setSizeTab] = useState<SizeTab>('price');
  const [regionWidth, setRegionWidth] = useState<number | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  // "You receive (est.)": for what a customer pays now, the typed price included (not saved).
  const showReceive = canEstimate && showPrice;
  const customerPays = Object.fromEntries(
    rows.map((row) => [
      row.variantId,
      showReceive ? customerPaysMinor(row.price, priceDrafts[row.variantId], currency) : null,
    ]),
  );
  const estimates = useReceiveEstimates(offerId, customerPays, showReceive);
  // After a failed save the first invalid field takes focus, so its message is read out.
  useEffect(() => {
    if (focusTick > 0)
      regionRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);
  // Only when the page opens; a refresh after Save does not move the cursor.
  const focusOnOpen = useRef(focusPrice);
  useEffect(() => {
    if (focusOnOpen.current) focusFirstPrice(regionRef.current);
    focusOnOpen.current = false;
  }, []);
  function updateFade() {
    const el = regionRef.current;
    if (el === null) return;
    setMoreToScroll(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    setRegionWidth(el.clientWidth);
  }
  useEffect(updateFade, [rows.length, sources.length]);
  useEffect(() => {
    // The open Details keeps the width of the visible table, also after the window changes.
    window.addEventListener('resize', updateFade, { passive: true });
    return () => window.removeEventListener('resize', updateFade);
  }, []);
  const lastHintId = useId();
  const tableErrorId = useId();

  const showUnits = units != null && rows.some((row) => row.unit != null);
  const canEditUnits = showUnits && units.canEdit;
  const unitRows: UnitRow[] = rows.flatMap((row) =>
    row.unit == null ? [] : [{ variantId: row.variantId, unit: row.unit }],
  );
  const plan = unitPlanOf(unitRows, skuDrafts, sellingDrafts);
  const unitChanges = canEditUnits ? plan.changes : [];
  const sellingOf = (row: TableRow) => sellingDrafts[row.variantId] ?? row.unit?.selling ?? true;
  const skuText = (row: TableRow) => skuDrafts[row.variantId] ?? row.unit?.variantSku ?? '';
  const onlyOneLeft = showUnits && unitRows.filter((item) => sellingOf(rowOf(item))).length === 1;
  function rowOf(item: UnitRow): TableRow {
    return rows.find((row) => row.variantId === item.variantId) as TableRow;
  }
  const lockedOn = (row: TableRow) =>
    row.unit != null && sellingOf(row) && isLastSelling(unitRows, sellingDrafts, row.variantId);
  function setSelling(variantId: string, on: boolean) {
    const next = { ...sellingDrafts, [variantId]: on };
    if (on === rows.find((row) => row.variantId === variantId)?.unit?.selling)
      delete next[variantId];
    setSellingDrafts(next);
  }

  const live = rows.filter((row) => row.price?.retired !== true);
  const priceText = (row: TableRow) => priceDrafts[row.variantId] ?? savedPriceText(row, currency);
  const stockText = (row: TableRow, sourceId: string) =>
    stockDrafts[stockKey(row.variantId, sourceId)] ?? savedStockText(row, sourceId);
  const { writes, invalid } = writesOf(rows, sources, currency, priceDrafts, stockDrafts);
  // A size's special is one change, however many of its fields are typed or wrong.
  const hasRegular = (row: TableRow) =>
    row.price?.inForce != null || minorOf(priceText(row), currency) !== null;
  const specialCount = canEditPrice
    ? rows.filter(
        (row) =>
          row.price?.retired !== true &&
          hasRegular(row) &&
          isSpecialTyped(specialDrafts[row.variantId]),
      ).length
    : 0;
  const canBulk = canEditPrice || canEditStock;
  const canSave = canBulk || canEditUnits;
  // A malformed cell or SKU counts as a change so that the save bar shows and Save can say why
  // it is not sent.
  const changeCount =
    writes.length +
    invalid.length +
    specialCount +
    unitChanges.length +
    (canEditUnits ? plan.badSku.length : 0);

  function toggle(variantId: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(variantId);
    else next.delete(variantId);
    setSelected(next);
  }

  /** A confirmed import fills the drafts; the Save below writes them, exactly as typed cells. */
  function applyFile(changes: readonly CellChange[]) {
    const prices = { ...priceDrafts };
    const stocks = { ...stockDrafts };
    const skus = { ...skuDrafts };
    const sellings = { ...sellingDrafts };
    for (const change of changes) {
      if (change.kind === 'price') prices[change.variantId] = change.to;
      else if (change.kind === 'sku') skus[change.variantId] = change.to;
      else if (change.kind === 'selling') sellings[change.variantId] = change.to === 'yes';
      else if (change.sourceId !== undefined)
        stocks[stockKey(change.variantId, change.sourceId)] = change.to;
    }
    setPriceDrafts(prices);
    setStockDrafts(stocks);
    setSkuDrafts(skus);
    setSellingDrafts(sellings);
    setErrors({});
  }

  function applyBulk() {
    const chosen = rows.filter((row) => selected.has(row.variantId) && row.price?.retired !== true);
    setBulkNote(null);
    if (bulk === 'price') {
      const next = { ...priceDrafts };
      for (const row of chosen) next[row.variantId] = bulkValue.trim();
      setPriceDrafts(next);
    } else if (bulk === 'increase') {
      const next = { ...priceDrafts };
      let skipped = 0;
      for (const row of chosen) {
        const inForce = row.price?.inForce;
        const raised = inForce == null ? null : increasedBy(inForce.amount, bulkValue);
        if (raised === null) skipped += 1;
        else next[row.variantId] = inputOf(raised, currency);
      }
      setPriceDrafts(next);
      if (skipped > 0) setBulkNote(t('catalog.variants-table.skipped', { count: skipped }));
    } else if (bulk === 'stock') {
      const next = { ...stockDrafts };
      for (const row of chosen) next[stockKey(row.variantId, bulkSource)] = bulkValue.trim();
      setStockDrafts(next);
    }
  }

  async function save() {
    // An End in flight uses the same series version: Save waits for it.
    if (saving || ending !== null) return;
    const plan = writesOf(rows, sources, currency, priceDrafts, stockDrafts);
    const specials = canEditPrice
      ? specialWritesOf(rows, currency, zone, specialDrafts, hasRegular)
      : { writes: [], invalid: [] };
    const found: Record<string, string> = {};
    for (const item of [...plan.invalid, ...specials.invalid]) {
      found[item.key] = t(INVALID_MESSAGE[item.kind]);
    }
    const unitsPlan = canEditUnits ? unitPlanOf(unitRows, skuDrafts, sellingDrafts) : null;
    if (unitsPlan !== null) {
      for (const id of unitsPlan.badSku) found[`sku:${id}`] = t(unitError('format'));
      for (const id of unitsPlan.duplicateSku) found[`sku:${id}`] = t(unitError('duplicate'));
      if (unitsPlan.noneSelling) found.units = t(unitError('none-selling'));
    }
    const sendUnits =
      unitsPlan !== null &&
      unitsPlan.changes.length > 0 &&
      unitsPlan.badSku.length === 0 &&
      unitsPlan.duplicateSku.length === 0 &&
      !unitsPlan.noneSelling;
    setErrors(found);
    setNeedsReload(false);
    setEndErrors({});
    if (plan.writes.length === 0 && specials.writes.length === 0 && !sendUnits) {
      if (Object.keys(found).length > 0) showFirstError(found);
      return;
    }
    setSaving(true);
    const priceLeft = { ...priceDrafts };
    const stockLeft = { ...stockDrafts };
    const skuLeft = { ...skuDrafts };
    const sellingLeft = { ...sellingDrafts };
    const specialLeft = { ...specialDrafts };
    const sent = await sendSizeWrites({
      offerId,
      rows,
      writes: orderedWrites(rows, plan.writes, specials.writes),
      currency,
      versions,
      csrfToken,
      guarded,
      messages: {
        throttledCell: t('catalog.variants-table.throttled-cell'),
        price: (problem) => t(`price.error.${problem}`),
        stock: (problem) => t(`stock.levels.error.${problem}`),
      },
    });
    if (sent.signedOut) {
      flushSync(() => setLeaving(true));
      window.location.assign('/session-ended');
      return;
    }
    Object.assign(found, sent.found);
    for (const id of sent.savedPrices) delete priceLeft[id];
    for (const key of sent.savedStocks) delete stockLeft[key];
    for (const id of sent.savedSpecials) delete specialLeft[id];
    const seen = sent.seen;
    let done = sent.done;
    const stopped = sent.stopped;
    const waitSeconds = sent.waitSeconds;
    if (sendUnits && !stopped) {
      const changes = unitsPlan.changes;
      const result = await callApi<{ changedVariantIds: string[] }>(
        'PUT',
        `catalog/seller/offers/${offerId}/sell-units`,
        { units: changes },
        csrfToken,
      );
      if (result.ok) {
        for (const change of changes) {
          delete skuLeft[change.variantId];
          delete sellingLeft[change.variantId];
        }
        done += changes.length;
      } else if (result.failure.status === 401) {
        flushSync(() => setLeaving(true));
        window.location.assign('/session-ended');
        return;
      } else {
        const failure = result.failure;
        const problem = unitProblemOf(failure);
        const named = (failure.details?.fields ?? []).flatMap((field) => {
          const id = variantOfPath(
            field.path,
            unitRows.map((r) => r.variantId),
          );
          return id === null ? [] : [{ id, code: field.code }];
        });
        const skuSet = changes.filter((c) => typeof c.variantSku === 'string');
        if (problem === 'invalid' && named.length > 0) {
          for (const item of named) {
            found[`sku:${item.id}`] = t(
              unitError(item.code === 'duplicate' ? 'duplicate' : 'format'),
            );
          }
        } else if (problem === 'sku-taken' && skuSet.length === 1) {
          // One new SKU in the request: it is the one that is taken.
          found[`sku:${skuSet[0]?.variantId}`] = t(unitError('sku-taken'));
        } else if (problem === 'sku-taken') {
          // The API does not say which: the banner says so and each new SKU carries a hint.
          for (const change of skuSet) found[`sku:${change.variantId}`] = t(unitError('sku-maybe'));
          found.units = t(unitError('sku-taken-table'));
        } else {
          if (problem === 'stale') setNeedsReload(true);
          found.units = t(
            problem === 'throttled'
              ? 'price.error.throttled'
              : unitError(problem === 'sku-taken' ? 'sku-taken-table' : problem),
          );
        }
      }
    }
    setSaving(false);
    // After a refresh the server's versions are the truth; keep ours only when nothing refreshes.
    setVersions(done > 0 ? {} : seen);
    setPriceDrafts(priceLeft);
    setStockDrafts(stockLeft);
    setSkuDrafts(skuLeft);
    setSellingDrafts(sellingLeft);
    setSpecialDrafts(specialLeft);
    setErrors(found);
    const failed = Object.keys(found).length;
    if (failed > 0) showFirstError(found);
    if (waitSeconds !== null) {
      toast.warning(
        t('catalog.variants-table.throttled', {
          done,
          minutes: Math.max(1, Math.ceil(waitSeconds / 60)),
        }),
      );
    } else if (done > 0 && failed === 0 && !stopped && sent.heldSpecials.length > 0)
      toast.info(t('catalog.variants-table.saved-review', { count: done }));
    else if (done > 0 && failed === 0 && !stopped)
      toast.success(t('catalog.variants-table.saved', { count: done }));
    else if (done > 0) toast.info(t('catalog.variants-table.partial', { done, failed }));
    else if (stopped) toast.info(t('catalog.variants-table.cancelled'));
    // Fresh versions, held prices and special prices come from the server.
    if (done > 0) router.refresh();
  }

  // Leaving with drafts asks first; a sign-out redirect leaves quietly.
  const guard = useUnsavedChangesGuard(
    canSave && changeCount > 0 && !leaving,
    {
      title: t('settings.leave.title'),
      message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
      stay: t('settings.leave.stay'),
      leave: t('settings.leave.leave'),
    },
    { count: changeCount, page: t('catalog.variants-table.title') },
  );

  /**
   * Focus the first field that failed. A special's fields live in its Details: when only specials
   * failed, the first such size opens on its Price tab (one row open at a time).
   */
  function showFirstError(found: Readonly<Record<string, string>>) {
    const special = rows.find((row) =>
      [specialKey.amount, specialKey.start, specialKey.end].some(
        (key) => found[key(row.variantId)] !== undefined,
      ),
    );
    const otherFailed = Object.keys(found).some((key) => !key.startsWith('special'));
    if (special !== undefined && !otherFailed) {
      setOpenId(special.variantId);
      setSizeTab('price');
    }
    setFocusTick((n) => n + 1);
  }

  /** End a size's running or scheduled special, or cancel one waiting for review, at once. */
  async function endSpecial(row: TableRow) {
    if (saving || ending !== null) return;
    const key = `price:${row.variantId}`;
    const expectedVersion =
      key in versions ? (versions[key] ?? null) : (row.price?.seriesVersion ?? null);
    if (expectedVersion === null) return;
    setEnding(row.variantId);
    setEndErrors({});
    const result = await guarded<SpecialWithdrawn>(
      'POST',
      `pricing/seller/offers/${offerId}/variants/${row.variantId}/special-price/withdraw`,
      { expectedVersion },
      csrfToken,
    );
    setEnding(null);
    if (isStepUpCancelled(result)) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        flushSync(() => setLeaving(true));
        window.location.assign('/session-ended');
        return;
      }
      const problem = priceProblemOf(result.failure);
      setEndErrors({ [row.variantId]: t(`price.error.${problem}`) });
      if (problem === 'stale' || problem === 'special-not-found') router.refresh();
      return;
    }
    setVersions({ ...versions, [key]: result.body.seriesVersion });
    toast.success(t('price.special.withdrawn'));
    router.refresh();
  }

  function discard() {
    setSpecialDrafts({});
    setEndErrors({});
    setPriceDrafts({});
    setStockDrafts({});
    setSkuDrafts({});
    setSellingDrafts({});
    setErrors({});
    setNeedsReload(false);
  }

  /** The Details or Close button of a size; `className` hides one of its two places. */
  function detailsButton(row: TableRow, open: boolean, detailsId: string, className?: string) {
    return (
      <Button
        className={className}
        variant="secondary"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        aria-label={t(open ? 'catalog.size-details.close-for' : 'catalog.size-details.open-for', {
          size: row.label,
        })}
        onClick={() => toggleDetails(row.variantId)}
      >
        {t(open ? 'catalog.size-details.close' : 'catalog.size-details.open')}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="size-4" />
      </Button>
    );
  }

  /**
   * The "Customers pay now" cell: a running special with its end day, else the typed or saved
   * price; a scheduled special, one waiting for review and a typed one are named under it.
   */
  function paysCell(row: TableRow) {
    const price = row.price;
    if (price?.retired === true) return <Dash />;
    const special = price?.special ?? null;
    const amount = customerPaysMinor(price, priceDrafts[row.variantId], currency);
    return (
      <>
        {amount === null ? <Dash /> : <span>{formatMinor(amount, currency, locale)}</span>}
        {special?.state === 'running' ? (
          <span className="block text-xs text-fg-muted">
            {t('catalog.variants-table.pays.running', {
              ends: formatDayInZone(special.endsAt, zone, locale),
            })}
          </span>
        ) : special?.state === 'scheduled' ? (
          <span className="block text-xs text-fg-muted">
            {t('catalog.variants-table.pays.scheduled', {
              amount: formatMinor(special.amount, currency, locale),
              starts: formatDayInZone(special.startsAt, zone, locale),
            })}
          </span>
        ) : null}
        {price?.heldSpecial == null ? null : (
          <span className="block text-xs text-fg-muted">
            {t('catalog.variants-table.pays.held')}
          </span>
        )}
        {canEditPrice && hasRegular(row) && isSpecialTyped(specialDrafts[row.variantId]) ? (
          <span className="block text-xs text-attention-fg">
            {t('catalog.variants-table.pays.typed')}
          </span>
        ) : null}
      </>
    );
  }

  /**
   * The "You receive (est.)" cell: "≈ amount" once the estimate for the row's price is read; while
   * a newly typed price is read, the last number stays, muted, so it does not blink to a dash.
   */
  function receiveCell(variantId: string) {
    const amount = customerPays[variantId] ?? null;
    const estimate = estimateFor(estimates, variantId, amount);
    const shown = estimate ?? (amount === null ? null : lastEstimateFor(estimates, variantId));
    if (shown === null) return <Dash />;
    return (
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
    );
  }

  /** What the open Details' Price tab shows of "You receive (est.)" for one size. */
  function receiveView(row: TableRow): ReceiveView | null {
    // A size no longer sold has nothing to estimate.
    if (row.price?.retired === true) return null;
    const amount = customerPays[row.variantId] ?? null;
    const draft = priceDrafts[row.variantId];
    const typed =
      draft !== undefined && minorOf(draft, currency) !== (row.price?.inForce?.amount ?? null);
    const source: ReceiveView['source'] =
      row.price?.special?.state === 'running'
        ? 'special'
        : amount === null
          ? draft !== undefined && draft.trim() !== ''
            ? 'unfinished'
            : 'none'
          : typed
            ? 'typed'
            : 'saved';
    const running = row.price?.special?.state === 'running' ? row.price.special : null;
    return {
      estimate: estimateFor(estimates, row.variantId, amount),
      source,
      specialEnds: running === null ? null : formatDayInZone(running.endsAt, zone, locale),
      state:
        estimates.kind === 'unavailable' || estimates.kind === 'no-category'
          ? estimates.kind
          : 'ready',
    };
  }

  if (rows.length === 0) {
    return (
      <div id="sizes" className="scroll-mt-4">
        <Card title={t('catalog.variants-table.title')}>
          <p className="text-fg-muted">{t('price.no-variants')}</p>
        </Card>
      </div>
    );
  }
  const needsLocation = canEditStock && sources.length === 0;
  const detailTabs = sizeTabsOf(showPrice, sources);
  const showDetails = detailTabs.length > 0;
  const columnCount =
    (canBulk ? 1 : 0) +
    1 +
    (showUnits ? 2 : 0) +
    (showPrice ? 2 : 0) +
    (showReceive ? 1 : 0) +
    sources.length +
    (showDetails ? 1 : 0);
  function toggleDetails(variantId: string) {
    if (openId === variantId) {
      setOpenId(null);
      return;
    }
    setOpenId(variantId);
    if (!detailTabs.includes(sizeTab)) setSizeTab(detailTabs[0] ?? 'price');
  }
  const tableRem =
    (canBulk ? 2.5 : 0) +
    COL.variant +
    (showUnits ? COL.onSale + COL.sku : 0) +
    (showPrice ? COL.price + COL.pays : 0) +
    (showReceive ? COL.receive : 0) +
    sources.length * COL.stock +
    (showDetails ? COL.details : 0);

  return (
    <div id="sizes" className="scroll-mt-4">
      <Card title={t('catalog.variants-table.title')}>
        {/* One form holds the table so its save bar stays at the bottom of the screen. */}
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) void save();
          }}
        >
          {needsLocation ? (
            <Banner tone="attention">
              <p>{t('stock.levels.no-locations')}</p>
              <a className="font-medium text-link underline" href="/settings/stock-locations">
                {t('stock.title')}
              </a>
            </Banner>
          ) : null}
          {errors.units === undefined ? null : (
            <div id={tableErrorId}>
              <Banner tone="critical">
                <p>{errors.units}</p>
                {needsReload ? (
                  <div className="mt-2">
                    <Button variant="secondary" onClick={() => router.refresh()}>
                      {t('catalog.variants-table.units.reload')}
                    </Button>
                  </div>
                ) : null}
              </Banner>
            </div>
          )}
          {fileModel === null ? null : (
            <VariantFileTools
              model={fileModel}
              disabled={saving}
              hasDrafts={changeCount > 0}
              onApply={applyFile}
            />
          )}
          {showUnits && units.productScope === 'PLATFORM' ? (
            <SizesYouSell
              items={unitRows.map((item) => {
                const row = rowOf(item);
                return {
                  variantId: item.variantId,
                  label: item.unit.label ?? item.unit.variantCode,
                  checked: sellingOf(row),
                  locked: lockedOn(row),
                };
              })}
              disabled={!canEditUnits}
              hintId={lastHintId}
              onChange={setSelling}
            />
          ) : null}
          {canBulk && selected.size > 0 ? (
            <div
              className="flex flex-col gap-3 rounded-md border border-line p-3"
              role="group"
              aria-label={t('catalog.variants-table.bulk')}
            >
              <p className="text-sm font-medium">
                {t('catalog.variants-table.selected', { count: selected.size })}
              </p>
              <div className="flex flex-wrap gap-2">
                {canEditPrice ? (
                  <>
                    <Button
                      variant="secondary"
                      aria-pressed={bulk === 'price'}
                      onClick={() => setBulk('price')}
                    >
                      {t('catalog.variants-table.set-price')}
                    </Button>
                    <Button
                      variant="secondary"
                      aria-pressed={bulk === 'increase'}
                      onClick={() => setBulk('increase')}
                    >
                      {t('catalog.variants-table.increase')}
                    </Button>
                  </>
                ) : null}
                {canEditStock && sources.length > 0 ? (
                  <Button
                    variant="secondary"
                    aria-pressed={bulk === 'stock'}
                    onClick={() => setBulk('stock')}
                  >
                    {t('catalog.variants-table.set-stock')}
                  </Button>
                ) : null}
              </div>
              {bulk === null ? null : (
                <div className="flex flex-wrap items-end gap-2">
                  {bulk === 'stock' && sources.length > 1 ? (
                    <Select
                      name="bulk-source"
                      label={t('catalog.variants-table.location')}
                      value={bulkSource}
                      options={sources.map((source) => ({ value: source.id, label: source.name }))}
                      onChange={(event) => setBulkSource(event.target.value)}
                    />
                  ) : null}
                  <TextField
                    name="bulk-value"
                    label={t(`catalog.variants-table.bulk-label.${bulk}`, { currency })}
                    inputMode="decimal"
                    value={bulkValue}
                    onChange={(event) => setBulkValue(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter applies the value to the chosen rows; it does not save the table.
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      if (bulkValue.trim() !== '') applyBulk();
                    }}
                  />
                  <Button
                    variant="secondary"
                    disabled={bulkValue.trim() === ''}
                    onClick={applyBulk}
                  >
                    {t('catalog.variants-table.apply', { count: selected.size })}
                  </Button>
                </div>
              )}
              <p className="text-sm text-fg-muted" role="status">
                {bulkNote}
              </p>
              <p className="text-sm text-fg-muted">{t('catalog.variants-table.bulk-help')}</p>
            </div>
          ) : null}

          <div className="relative">
            <div
              ref={regionRef}
              className="relative overflow-x-auto"
              role="region"
              aria-label={t('catalog.variants-table.title')}
              tabIndex={0}
              // A focused field scrolls into view beside the sticky Variant column, not under it, and
              // clear of the end fade, so its error text and focus ring stay visible on phones.
              style={{
                scrollPaddingInlineStart: `${COL.variant + 0.5}rem`,
                // Clear of the sticky Details column too, when the table has it.
                scrollPaddingInlineEnd: showDetails ? `${COL.details + 1}rem` : '1rem',
                // No strip of the column under it shows beside the sticky Details column.
                paddingInlineEnd: showDetails ? 0 : '1rem',
              }}
              onScroll={updateFade}
            >
              <table
                className="w-full table-fixed text-start text-sm"
                style={{ minWidth: `${tableRem}rem` }}
                onKeyDown={moveOnEnter}
              >
                <colgroup>
                  {canBulk ? <col style={{ width: '2.5rem' }} /> : null}
                  <col style={{ width: `${COL.variant}rem` }} />
                  {showUnits ? <col style={{ width: `${COL.onSale}rem` }} /> : null}
                  {showPrice ? (
                    <>
                      <col style={{ width: `${COL.price}rem` }} />
                      <col style={{ width: `${COL.pays}rem` }} />
                    </>
                  ) : null}
                  {showReceive ? <col style={{ width: `${COL.receive}rem` }} /> : null}
                  {sources.map((source) => (
                    <col key={source.id} style={{ width: `${COL.stock}rem` }} />
                  ))}
                  {showUnits ? <col style={{ width: `${COL.sku}rem` }} /> : null}
                  {showDetails ? <col style={{ width: `${COL.details}rem` }} /> : null}
                </colgroup>
                <thead>
                  <tr>
                    {canBulk ? (
                      <th scope="col" className="p-2 align-middle">
                        <input
                          type="checkbox"
                          className={CHECKBOX}
                          aria-label={t('catalog.variants-table.select-all')}
                          checked={
                            live.length > 0 && live.every((row) => selected.has(row.variantId))
                          }
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? new Set(live.map((row) => row.variantId))
                                : new Set(),
                            )
                          }
                        />
                      </th>
                    ) : null}
                    <th scope="col" className="sticky start-0 z-10 bg-surface p-2 font-medium">
                      {t('catalog.variants-table.variant')}
                    </th>
                    {showUnits ? (
                      <th scope="col" className="p-2 font-medium">
                        {t('catalog.variants-table.units.selling')}
                      </th>
                    ) : null}
                    {showPrice ? (
                      <>
                        <th scope="col" className="p-2 font-medium">
                          {t('catalog.variants-table.your-price')}
                        </th>
                        <th scope="col" className="p-2 font-medium">
                          {t('catalog.variants-table.pays.column')}
                        </th>
                      </>
                    ) : null}
                    {showReceive ? (
                      <th scope="col" className="p-2 font-medium">
                        {t('catalog.variants-table.receive.column')}
                      </th>
                    ) : null}
                    {sources.map((source) => (
                      <th key={source.id} scope="col" className="p-2 font-medium">
                        {source.name}
                      </th>
                    ))}
                    {showUnits ? (
                      <th scope="col" className="p-2 font-medium">
                        {t('catalog.variants-table.units.sku')}
                      </th>
                    ) : null}
                    {showDetails ? (
                      <th
                        scope="col"
                        className="bg-surface p-2 font-medium sm:sticky sm:end-0 sm:z-10 sm:border-s sm:border-line"
                      >
                        <span className="sr-only">{t('catalog.size-details.column')}</span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const retired = row.price?.retired === true;
                    const unit = row.unit;
                    const offSale = unit != null && !sellingOf(row);
                    const open = openId === row.variantId;
                    const bg = offSale ? 'bg-muted' : open ? 'bg-selected' : 'bg-surface';
                    const detailsId = `size-details-${row.variantId}`;
                    return (
                      <Fragment key={row.variantId}>
                        <tr
                          className={`border-t border-line align-middle ${bg} ${
                            offSale ? '[&_input:not([type=checkbox])]:bg-muted' : ''
                          }`}
                        >
                          {canBulk ? (
                            <td className="p-2 [&_label]:sr-only">
                              <input
                                type="checkbox"
                                className={CHECKBOX}
                                aria-label={t('catalog.variants-table.select', {
                                  variant: row.label,
                                })}
                                disabled={retired}
                                checked={selected.has(row.variantId)}
                                onChange={(event) => toggle(row.variantId, event.target.checked)}
                              />
                            </td>
                          ) : null}
                          <th scope="row" className={`sticky start-0 z-10 p-2 font-medium ${bg}`}>
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="min-w-0 break-words">{row.label}</span>
                              {offSale ? (
                                <Badge tone="neutral">
                                  {t('catalog.variants-table.units.off-sale')}
                                </Badge>
                              ) : null}
                            </span>
                            {unit == null ? null : (
                              <span
                                className="block font-mono text-xs font-normal text-fg-muted"
                                dir="ltr"
                              >
                                {unit.variantCode}
                              </span>
                            )}
                            {retired ? (
                              <span className="block text-fg-muted">{t('price.retired')}</span>
                            ) : null}
                            {showDetails ? (
                              // On a phone Details sits under the size, in the column that stays.
                              <span className="mt-2 block font-normal sm:hidden">
                                {detailsButton(row, open, detailsId)}
                              </span>
                            ) : null}
                          </th>
                          {showUnits ? (
                            <td className="p-2">
                              {unit == null ? (
                                <Dash />
                              ) : (
                                <input
                                  type="checkbox"
                                  role="switch"
                                  className={`${CHECKBOX} size-5`}
                                  aria-label={t('catalog.variants-table.units.selling-for', {
                                    variant: row.label,
                                  })}
                                  aria-describedby={lockedOn(row) ? lastHintId : undefined}
                                  checked={sellingOf(row)}
                                  disabled={!canEditUnits || lockedOn(row)}
                                  onChange={(event) =>
                                    setSelling(row.variantId, event.target.checked)
                                  }
                                />
                              )}
                            </td>
                          ) : null}
                          {showPrice ? (
                            <>
                              <td className="p-2 [&_label]:sr-only">
                                {canEditPrice && !retired ? (
                                  <div className="w-28">
                                    <TextField
                                      name={`price-${row.variantId}`}
                                      label={t('price.field', { currency })}
                                      aria-label={t('catalog.variants-table.price-for', {
                                        variant: row.label,
                                      })}
                                      inputMode="decimal"
                                      value={priceText(row)}
                                      error={errors[row.variantId]}
                                      onChange={(event) =>
                                        setPriceDrafts({
                                          ...priceDrafts,
                                          [row.variantId]: event.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                ) : row.price?.inForce == null ? (
                                  <Dash />
                                ) : (
                                  <span>
                                    {formatMinor(row.price.inForce.amount, currency, locale)}
                                  </span>
                                )}
                                {row.price?.held == null ? null : (
                                  <span className="mt-1 block text-fg-muted">
                                    {t('catalog.variants-table.held', {
                                      amount: formatMinor(row.price.held.amount, currency, locale),
                                    })}
                                  </span>
                                )}
                              </td>
                              <td className="p-2 tabular-nums">{paysCell(row)}</td>
                            </>
                          ) : null}
                          {showReceive ? (
                            <td className="p-2 tabular-nums">{receiveCell(row.variantId)}</td>
                          ) : null}
                          {sources.map((source) => {
                            const cell = row.stock[source.id];
                            const key = stockKey(row.variantId, source.id);
                            return (
                              <td key={source.id} className="p-2 [&_label]:sr-only">
                                {canEditStock && !retired ? (
                                  <div className="w-24">
                                    <TextField
                                      name={`onHand-${key}`}
                                      label={t('stock.levels.on-hand')}
                                      aria-label={t('stock.levels.on-hand-for', {
                                        location: source.name,
                                      })}
                                      inputMode="numeric"
                                      value={stockText(row, source.id)}
                                      error={errors[key]}
                                      onChange={(event) =>
                                        setStockDrafts({
                                          ...stockDrafts,
                                          [key]: event.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                ) : cell === undefined ? (
                                  <Dash />
                                ) : (
                                  <span>{cell.onHand}</span>
                                )}
                                {cell === undefined || cell.held === 0 ? null : (
                                  // Short, so the row stays low; the Stock tab explains it.
                                  <span className="mt-1 block text-xs text-fg-muted">
                                    {t('catalog.variants-table.held-stock', { count: cell.held })}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                          {showUnits ? (
                            <td className="p-2">
                              {unit == null ? (
                                <Dash />
                              ) : canEditUnits ? (
                                <div className="w-40">
                                  <SkuField
                                    name={`sku-${row.variantId}`}
                                    label={t('catalog.variants-table.units.sku-for', {
                                      variant: row.label,
                                    })}
                                    dir="ltr"
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder={skuPlaceholder(unit, units.sellerSku)}
                                    value={skuText(row)}
                                    error={errors[`sku:${row.variantId}`]}
                                    onChange={(event) =>
                                      setSkuDrafts({
                                        ...skuDrafts,
                                        [row.variantId]: event.target.value,
                                      })
                                    }
                                  />
                                </div>
                              ) : (
                                <span className="font-mono" dir="ltr">
                                  {unit.displaySku}
                                </span>
                              )}
                            </td>
                          ) : null}
                          {showDetails ? (
                            // Sticky at the end: on a phone Details and Close stay in view.
                            <td
                              className={`p-2 sm:sticky sm:end-0 sm:z-10 sm:border-s sm:border-line ${bg}`}
                            >
                              {detailsButton(row, open, detailsId, 'max-sm:hidden')}
                            </td>
                          ) : null}
                        </tr>
                        {open ? (
                          <tr className="border-t border-line bg-selected">
                            <td colSpan={columnCount} className="p-0">
                              <div
                                className="sticky start-0 border-s-4 border-accent p-4"
                                // The visible width of the table: on a phone it stays in view.
                                style={
                                  regionWidth === null
                                    ? undefined
                                    : { width: `min(calc(${regionWidth}px - 1rem), 100%)` }
                                }
                              >
                                <SizeDetails
                                  id={detailsId}
                                  offerId={offerId}
                                  row={row}
                                  code={unit?.displaySku ?? null}
                                  tabs={detailTabs}
                                  tab={
                                    detailTabs.includes(sizeTab)
                                      ? sizeTab
                                      : (detailTabs[0] ?? 'price')
                                  }
                                  onTab={setSizeTab}
                                  currency={currency}
                                  priceDraft={
                                    row.variantId in priceDrafts &&
                                    (priceDrafts[row.variantId] ?? '').trim() !==
                                      savedPriceText(row, currency)
                                      ? (priceDrafts[row.variantId] ?? '')
                                      : null
                                  }
                                  sources={sources}
                                  stockDrafts={stockDrafts}
                                  receive={showReceive ? receiveView(row) : null}
                                  special={
                                    <SizeSpecial
                                      id={`${detailsId}-special`}
                                      sizeLabel={row.label}
                                      price={row.price}
                                      currency={currency}
                                      zone={zone}
                                      hasRegular={hasRegular(row)}
                                      canEdit={canEditPrice}
                                      draft={specialDrafts[row.variantId]}
                                      errors={{
                                        amount: errors[specialKey.amount(row.variantId)],
                                        start: errors[specialKey.start(row.variantId)],
                                        end: errors[specialKey.end(row.variantId)],
                                      }}
                                      ending={ending === row.variantId}
                                      disabled={saving || ending !== null}
                                      statusError={endErrors[row.variantId] ?? null}
                                      onDraft={(draft) =>
                                        setSpecialDrafts({
                                          ...specialDrafts,
                                          [row.variantId]: draft,
                                        })
                                      }
                                      onEnd={() => void endSpecial(row)}
                                    />
                                  }
                                />
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* The fade sits before the sticky Details column, and goes while a row is open. */}
            {moreToScroll && openId === null ? (
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-0 end-0 w-8 bg-linear-to-l from-surface to-transparent ${showDetails ? 'sm:end-28' : ''}`}
              />
            ) : null}
          </div>
          {showPrice ? (
            <p className="text-sm text-fg-muted">
              {/* The tax convention comes from the Market's answer, never assumed. */}
              {t(
                estimates.kind === 'ready' && estimates.taxInclusive !== null
                  ? estimates.taxInclusive
                    ? 'catalog.variants-table.price-note-inclusive'
                    : 'catalog.variants-table.price-note-exclusive'
                  : 'catalog.variants-table.price-note',
                { currency },
              )}
            </p>
          ) : null}
          {showReceive && (estimates.kind === 'unavailable' || estimates.kind === 'no-category') ? (
            <p className="text-sm text-fg-muted" role="status">
              {t(`catalog.variants-table.receive.${estimates.kind}`)}
            </p>
          ) : null}
          {showReceive ? (
            <p className="text-sm text-fg-muted">
              {t('catalog.variants-table.receive.promotions')}
            </p>
          ) : null}
          {showUnits ? (
            <div className="flex flex-col gap-2 text-sm text-fg-muted">
              {onlyOneLeft && units.productScope !== 'PLATFORM' ? (
                <LastSizeHint id={lastHintId} />
              ) : null}
              <p>
                {t('catalog.variants-table.units.sku-help', {
                  example: fallbackSku(units.sellerSku, 1),
                })}
              </p>
            </div>
          ) : null}
          {canSave ? (
            <SaveBar
              count={changeCount}
              summary={`${t('settings.bar.summary', { count: changeCount })} · ${t('catalog.variants-table.explicit-save')}`}
              saving={saving}
              aboveBottomBar
              labels={{
                region: t('settings.bar.region'),
                discard: t('settings.bar.discard'),
                save: t('catalog.variants-table.save', { count: changeCount }),
                // The button keeps its count while it saves; it shows the spinner.
                saving: t('catalog.variants-table.save', { count: changeCount }),
              }}
              onDiscard={discard}
            />
          ) : null}
        </form>
        {canSave && changeCount > 0 ? guard.dialog : null}
        {showUnits && units.productScope === 'PLATFORM' && sizeRequests !== null ? (
          <SizeRequests
            offerId={offerId}
            axes={sizeRequests.axes}
            items={sizeRequests.items}
            openCount={sizeRequests.openCount}
            maxOpen={sizeRequests.maxOpen}
            canRequest={units.canEdit}
            csrfToken={csrfToken}
          />
        ) : null}
      </Card>
    </div>
  );
}

/** The message of a cell or field whose text is not a valid value. */
const INVALID_MESSAGE = {
  price: 'price.error.invalid',
  stock: 'stock.levels.error.invalid',
  'special-amount': 'price.error.invalid',
  'special-start': 'price.special.error.start',
  'special-end': 'price.special.error.end',
} as const;

/** An empty value: an em dash in the muted colour. */
function Dash() {
  return <span className="text-fg-muted">{'\u2014'}</span>;
}
