'use client';

import { Badge, Banner, Button, Card, Select, TextField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { priceProblemOf } from '../price/errors.ts';
import { formatMinor, inputOf } from '../price/money.ts';
import type { PriceWritten } from '../price/types.ts';
import { levelsProblemOf } from '../stock/levels-errors.ts';
import type { StockSet } from '../stock/levels-types.ts';
import type { SourceView } from '../stock/types.ts';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import {
  increasedBy,
  savedPriceText,
  savedStockText,
  stockKey,
  writesOf,
  type TableRow,
} from './variants-table-logic.ts';
import { unitProblemOf, variantOfPath } from './sell-unit-errors.ts';
import {
  fallbackSku,
  isLastSelling,
  skuPlaceholder,
  unitPlanOf,
  type UnitRow,
} from './sell-unit-logic.ts';
import { CHECKBOX, SkuField } from './sku-field.tsx';
import { SizeRequests } from './size-requests.tsx';
import type { SizeRequestsData } from './size-request-logic.ts';
import { LastSizeHint, SizesYouSell } from './sizes-you-sell.tsx';
import { VariantFileTools } from './variant-file-tools.tsx';
import type { CellChange, FileModel } from './variant-file.ts';

type Bulk = 'price' | 'increase' | 'stock';

/** Column widths in rem. Inputs are w-28 (price), w-24 (stock) and w-40 (SKU) inside p-2 cells. */
const COL = { variant: 8, onSale: 6, price: 8, special: 7, stock: 7, sku: 11 } as const;

const unitError = (name: string): string => `catalog.variants-table.units.error.${name}`;

/**
 * Price, special price and stock of every variant of one offer in one table (variants V3b).
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
  const [focusTick, setFocusTick] = useState(0);
  const [moreToScroll, setMoreToScroll] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);
  // After a failed save the first invalid field takes focus, so its message is read out.
  useEffect(() => {
    if (focusTick > 0)
      regionRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);
  function updateFade() {
    const el = regionRef.current;
    if (el !== null) setMoreToScroll(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }
  useEffect(updateFade, [rows.length, sources.length]);
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
  const { writes } = writesOf(rows, sources, currency, priceDrafts, stockDrafts);
  const canBulk = canEditPrice || canEditStock;
  const canSave = canBulk || canEditUnits;
  // A malformed SKU counts as a change so that Save can show why it is not sent.
  const changeCount = writes.length + unitChanges.length + (canEditUnits ? plan.badSku.length : 0);

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
    if (saving) return;
    const plan = writesOf(rows, sources, currency, priceDrafts, stockDrafts);
    const found: Record<string, string> = {};
    for (const item of plan.invalid) {
      found[item.key] =
        item.kind === 'price' ? t('price.error.invalid') : t('stock.levels.error.invalid');
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
    if (plan.writes.length === 0 && !sendUnits) {
      if (Object.keys(found).length > 0) setFocusTick((n) => n + 1);
      return;
    }
    setSaving(true);
    const priceLeft = { ...priceDrafts };
    const stockLeft = { ...stockDrafts };
    const skuLeft = { ...skuDrafts };
    const sellingLeft = { ...sellingDrafts };
    const seen = { ...versions };
    let done = 0;
    let stopped = false;
    let waitSeconds: number | null = null;
    for (const write of plan.writes) {
      const row = rows.find((item) => item.variantId === write.variantId);
      if (row === undefined) continue;
      if (write.kind === 'price') {
        const key = `price:${write.variantId}`;
        const expectedVersion =
          key in seen ? (seen[key] ?? null) : (row.price?.seriesVersion ?? null);
        const result = await guarded<PriceWritten>(
          'PUT',
          `pricing/seller/offers/${offerId}/variants/${write.variantId}/regular-price`,
          { amount: write.amount, currency, expectedVersion },
          csrfToken,
        );
        if (isStepUpCancelled(result)) {
          stopped = true;
          break;
        }
        if (!result.ok) {
          if (result.failure.status === 401) {
            window.location.assign('/session-ended');
            return;
          }
          if (result.failure.code === 'request.throttled') {
            // Stop here: this cell and every one after it stay drafts, nothing is retried.
            waitSeconds = result.failure.details?.retryAfterSeconds ?? 60;
            found[write.variantId] = t('catalog.variants-table.throttled-cell');
            stopped = true;
            break;
          }
          found[write.variantId] = t(`price.error.${priceProblemOf(result.failure)}`);
          continue;
        }
        seen[key] = result.body.seriesVersion;
        delete priceLeft[write.variantId];
        done += 1;
      } else {
        const key = stockKey(write.variantId, write.sourceId);
        const vkey = `stock:${key}`;
        const expectedVersion =
          vkey in seen ? (seen[vkey] ?? null) : (row.stock[write.sourceId]?.version ?? null);
        const result = await callApi<StockSet>(
          'PUT',
          `inventory/seller/offers/${offerId}/variants/${write.variantId}/sources/${write.sourceId}/stock`,
          { onHand: write.onHand, expectedVersion },
          csrfToken,
        );
        if (!result.ok) {
          if (result.failure.status === 401) {
            window.location.assign('/session-ended');
            return;
          }
          if (result.failure.code === 'request.throttled') {
            waitSeconds = result.failure.details?.retryAfterSeconds ?? 60;
            found[key] = t('catalog.variants-table.throttled-cell');
            stopped = true;
            break;
          }
          found[key] = t(`stock.levels.error.${levelsProblemOf(result.failure)}`);
          continue;
        }
        seen[vkey] = result.body.version;
        delete stockLeft[key];
        done += 1;
      }
    }
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
    setErrors(found);
    const failed = Object.keys(found).length;
    if (failed > 0) setFocusTick((n) => n + 1);
    if (waitSeconds !== null) {
      toast.warning(
        t('catalog.variants-table.throttled', {
          done,
          minutes: Math.max(1, Math.ceil(waitSeconds / 60)),
        }),
      );
    } else if (done > 0 && failed === 0 && !stopped)
      toast.success(t('catalog.variants-table.saved', { count: done }));
    else if (done > 0) toast.info(t('catalog.variants-table.partial', { done, failed }));
    else if (stopped) toast.info(t('catalog.variants-table.cancelled'));
    // Fresh versions, held prices and special prices come from the server.
    if (done > 0) router.refresh();
  }

  if (rows.length === 0) {
    return <p className="text-fg-muted">{t('price.no-variants')}</p>;
  }
  const needsLocation = canEditStock && sources.length === 0;
  const tableRem =
    (canBulk ? 2.5 : 0) +
    COL.variant +
    (showUnits ? COL.onSale + COL.sku : 0) +
    (showPrice ? COL.price + COL.special : 0) +
    sources.length * COL.stock;

  return (
    <Card title={t('catalog.variants-table.title')}>
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
              />
              <Button variant="secondary" disabled={bulkValue.trim() === ''} onClick={applyBulk}>
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
            scrollPaddingInlineEnd: '1rem',
            paddingInlineEnd: '1rem',
          }}
          onScroll={updateFade}
        >
          <table className="table-fixed text-start text-sm" style={{ width: `${tableRem}rem` }}>
            <colgroup>
              {canBulk ? <col style={{ width: '2.5rem' }} /> : null}
              <col style={{ width: `${COL.variant}rem` }} />
              {showUnits ? <col style={{ width: `${COL.onSale}rem` }} /> : null}
              {showPrice ? (
                <>
                  <col style={{ width: `${COL.price}rem` }} />
                  <col style={{ width: `${COL.special}rem` }} />
                </>
              ) : null}
              {sources.map((source) => (
                <col key={source.id} style={{ width: `${COL.stock}rem` }} />
              ))}
              {showUnits ? <col style={{ width: `${COL.sku}rem` }} /> : null}
            </colgroup>
            <thead>
              <tr>
                {canBulk ? (
                  <th scope="col" className="p-2 align-middle">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      aria-label={t('catalog.variants-table.select-all')}
                      checked={live.length > 0 && live.every((row) => selected.has(row.variantId))}
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
                      {t('price.field', { currency })}
                    </th>
                    <th scope="col" className="p-2 font-medium">
                      {t('price.special.title')}
                    </th>
                  </>
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
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const retired = row.price?.retired === true;
                const special = row.price?.special;
                const unit = row.unit;
                const offSale = unit != null && !sellingOf(row);
                const bg = offSale ? 'bg-muted' : 'bg-surface';
                return (
                  <tr
                    key={row.variantId}
                    className={`border-t border-line align-middle ${bg} ${
                      offSale ? '[&_input:not([type=checkbox])]:bg-muted' : ''
                    }`}
                  >
                    {canBulk ? (
                      <td className="p-2 [&_label]:sr-only">
                        <input
                          type="checkbox"
                          className={CHECKBOX}
                          aria-label={t('catalog.variants-table.select', { variant: row.label })}
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
                          <Badge tone="neutral">{t('catalog.variants-table.units.off-sale')}</Badge>
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
                            onChange={(event) => setSelling(row.variantId, event.target.checked)}
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
                            <span>{formatMinor(row.price.inForce.amount, currency, locale)}</span>
                          )}
                          {row.price?.held == null ? null : (
                            <span className="mt-1 block text-fg-muted">
                              {t('catalog.variants-table.held', {
                                amount: formatMinor(row.price.held.amount, currency, locale),
                              })}
                            </span>
                          )}
                        </td>
                        <td className="p-2">
                          {special == null ? (
                            <Dash />
                          ) : (
                            t(`catalog.variants-table.special.${special.state}`, {
                              amount: formatMinor(special.amount, currency, locale),
                            })
                          )}
                        </td>
                      </>
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
                                  setStockDrafts({ ...stockDrafts, [key]: event.target.value })
                                }
                              />
                            </div>
                          ) : cell === undefined ? (
                            <Dash />
                          ) : (
                            <span>{cell.onHand}</span>
                          )}
                          {cell === undefined || cell.held === 0 ? null : (
                            <span className="mt-1 block text-fg-muted">
                              {t('stock.levels.held', { count: cell.held })}
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
                                setSkuDrafts({ ...skuDrafts, [row.variantId]: event.target.value })
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {moreToScroll ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 end-0 w-8 bg-linear-to-l from-surface to-transparent"
          />
        ) : null}
      </div>
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
      {showPrice ? (
        <p className="text-sm text-fg-muted">
          <a className="font-medium text-link underline" href={`/offers/${offerId}/prices`}>
            {t('catalog.variants-table.special-link')}
          </a>
        </p>
      ) : null}
      {canSave ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={saving}
            disabled={saving || changeCount === 0}
            onClick={() => void save()}
          >
            {t('catalog.variants-table.save', { count: changeCount })}
          </Button>
          {changeCount === 0 ? null : (
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => {
                setPriceDrafts({});
                setStockDrafts({});
                setSkuDrafts({});
                setSellingDrafts({});
                setErrors({});
                setNeedsReload(false);
              }}
            >
              {t('catalog.variants-table.discard')}
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/** An empty value: an em dash in the muted colour. */
function Dash() {
  return <span className="text-fg-muted">{'\u2014'}</span>;
}
