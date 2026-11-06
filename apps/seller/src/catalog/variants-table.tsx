'use client';

import { Badge, Banner, Button, Card, Select, TextField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { callApi } from '../api/client.ts';
import { priceProblemOf } from '../price/errors.ts';
import { formatMinor } from '../price/money.ts';
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
import { inputOf } from '../price/money.ts';
import { unitProblemOf, variantOfPath } from './sell-unit-errors.ts';
import { fallbackSku, isLastSelling, unitPlanOf, type UnitRow } from './sell-unit-logic.ts';
import { SizesYouSell } from './sizes-you-sell.tsx';

type Bulk = 'price' | 'increase' | 'stock';

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
    if (plan.writes.length === 0 && !sendUnits) return;
    setSaving(true);
    const priceLeft = { ...priceDrafts };
    const stockLeft = { ...stockDrafts };
    const skuLeft = { ...skuDrafts };
    const sellingLeft = { ...sellingDrafts };
    const seen = { ...versions };
    let done = 0;
    let stopped = false;
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
        } else {
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
    if (done > 0 && failed === 0 && !stopped)
      toast.success(t('catalog.variants-table.saved', { count: done }));
    else if (done > 0) toast.info(t('catalog.variants-table.partial', { done, failed }));
    // Fresh versions, held prices and special prices come from the server.
    if (done > 0) router.refresh();
  }

  if (rows.length === 0) {
    return <p className="text-fg-muted">{t('price.no-variants')}</p>;
  }
  const colSpanStock = Math.max(sources.length, 1);
  const needsLocation = canEditStock && sources.length === 0;

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
          </Banner>
        </div>
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
                <Button variant="secondary" onClick={() => setBulk('price')}>
                  {t('catalog.variants-table.set-price')}
                </Button>
                <Button variant="secondary" onClick={() => setBulk('increase')}>
                  {t('catalog.variants-table.increase')}
                </Button>
              </>
            ) : null}
            {canEditStock && sources.length > 0 ? (
              <Button variant="secondary" onClick={() => setBulk('stock')}>
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
          {bulkNote === null ? null : <p className="text-sm text-fg-muted">{bulkNote}</p>}
          <p className="text-sm text-fg-muted">{t('catalog.variants-table.bulk-help')}</p>
        </div>
      ) : null}

      <div
        className="relative overflow-x-auto"
        role="region"
        aria-label={t('catalog.variants-table.title')}
        tabIndex={0}
      >
        <table className="w-full min-w-max text-start text-sm">
          <thead>
            <tr>
              {canBulk ? (
                <th scope="col" className="w-8 p-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
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
              <th scope="col" className="p-2 text-start font-medium">
                {t('catalog.variants-table.variant')}
              </th>
              {showPrice ? (
                <>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('price.field', { currency })}
                  </th>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('price.special.title')}
                  </th>
                </>
              ) : null}
              {sources.map((source) => (
                <th key={source.id} scope="col" className="p-2 text-start font-medium">
                  {source.name}
                </th>
              ))}
              {showUnits ? (
                <>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('catalog.variants-table.units.sku')}
                  </th>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('catalog.variants-table.units.selling')}
                  </th>
                </>
              ) : null}
              {sources.length === 0 ? <th scope="col" colSpan={colSpanStock} /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const retired = row.price?.retired === true;
              const special = row.price?.special;
              const unit = row.unit;
              const offSale = unit != null && !sellingOf(row);
              return (
                <tr
                  key={row.variantId}
                  className={`border-t border-line align-top ${offSale ? 'bg-subtle text-fg-muted' : ''}`}
                >
                  {canBulk ? (
                    <td className="p-2 [&_label]:sr-only">
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        aria-label={t('catalog.variants-table.select', { variant: row.label })}
                        disabled={retired}
                        checked={selected.has(row.variantId)}
                        onChange={(event) => toggle(row.variantId, event.target.checked)}
                      />
                    </td>
                  ) : null}
                  <th scope="row" className="p-2 text-start font-medium">
                    {row.label}
                    {unit == null ? null : (
                      <span className="block font-mono text-xs font-normal text-fg-muted" dir="ltr">
                        {unit.variantCode}
                      </span>
                    )}
                    {retired ? (
                      <span className="block text-fg-muted">{t('price.retired')}</span>
                    ) : null}
                    {offSale ? (
                      <span className="mt-1 block">
                        <Badge tone="neutral">{t('catalog.variants-table.units.off-sale')}</Badge>
                      </span>
                    ) : null}
                  </th>
                  {showPrice ? (
                    <>
                      <td className="p-2 [&_label]:sr-only">
                        {canEditPrice && !retired ? (
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
                        ) : (
                          <span>
                            {row.price?.inForce == null
                              ? '-'
                              : formatMinor(row.price.inForce.amount, currency, locale)}
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
                      <td className="p-2 [&_label]:sr-only">
                        {special == null
                          ? '-'
                          : t(`catalog.variants-table.special.${special.state}`, {
                              amount: formatMinor(special.amount, currency, locale),
                            })}
                      </td>
                    </>
                  ) : null}
                  {sources.map((source) => {
                    const cell = row.stock[source.id];
                    const key = stockKey(row.variantId, source.id);
                    return (
                      <td key={source.id} className="p-2 [&_label]:sr-only">
                        {canEditStock && !retired ? (
                          <TextField
                            name={`onHand-${key}`}
                            label={t('stock.levels.on-hand')}
                            aria-label={t('stock.levels.on-hand-for', { location: source.name })}
                            inputMode="numeric"
                            value={stockText(row, source.id)}
                            error={errors[key]}
                            onChange={(event) =>
                              setStockDrafts({ ...stockDrafts, [key]: event.target.value })
                            }
                          />
                        ) : (
                          <span>{cell === undefined ? '-' : cell.onHand}</span>
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
                    <>
                      <td className="p-2 [&_label]:sr-only">
                        {unit == null ? (
                          <span>-</span>
                        ) : canEditUnits ? (
                          <TextField
                            name={`sku-${row.variantId}`}
                            label={t('catalog.variants-table.units.sku')}
                            aria-label={t('catalog.variants-table.units.sku-for', {
                              variant: row.label,
                            })}
                            dir="ltr"
                            className="font-mono"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={fallbackSku(units.sellerSku, unit.variantNo)}
                            value={skuText(row)}
                            error={errors[`sku:${row.variantId}`]}
                            onChange={(event) =>
                              setSkuDrafts({ ...skuDrafts, [row.variantId]: event.target.value })
                            }
                          />
                        ) : (
                          <span className="font-mono" dir="ltr">
                            {unit.variantSku ?? fallbackSku(units.sellerSku, unit.variantNo)}
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        {unit == null ? (
                          <span>-</span>
                        ) : (
                          <input
                            type="checkbox"
                            role="switch"
                            className="size-5 accent-accent"
                            aria-label={t('catalog.variants-table.units.selling-for', {
                              variant: row.label,
                            })}
                            aria-describedby={
                              lockedOn(row) && onlyOneLeft
                                ? lastHintId
                                : errors.units !== undefined
                                  ? tableErrorId
                                  : undefined
                            }
                            checked={sellingOf(row)}
                            disabled={!canEditUnits || lockedOn(row)}
                            onChange={(event) => setSelling(row.variantId, event.target.checked)}
                          />
                        )}
                      </td>
                    </>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showUnits ? (
        <div className="flex flex-col gap-1 text-sm text-fg-muted">
          {onlyOneLeft && units.productScope !== 'PLATFORM' ? (
            <p id={lastHintId}>{t('catalog.variants-table.units.last-hint')}</p>
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
