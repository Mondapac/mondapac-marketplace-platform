'use client';

import { Banner, Button, Card, Select, TextField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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

type Bulk = 'price' | 'increase' | 'stock';

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
  csrfToken,
}: {
  readonly offerId: string;
  readonly rows: readonly TableRow[];
  readonly sources: readonly SourceView[];
  /** The Market currency; null when the seller may not see prices (no price columns then). */
  readonly currency: string | null;
  readonly canEditPrice: boolean;
  readonly canEditStock: boolean;
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
  const [saving, setSaving] = useState(false);

  const live = rows.filter((row) => row.price?.retired !== true);
  const priceText = (row: TableRow) => priceDrafts[row.variantId] ?? savedPriceText(row, currency);
  const stockText = (row: TableRow, sourceId: string) =>
    stockDrafts[stockKey(row.variantId, sourceId)] ?? savedStockText(row, sourceId);
  const { writes } = writesOf(rows, sources, currency, priceDrafts, stockDrafts);
  const canBulk = canEditPrice || canEditStock;

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
    setErrors(found);
    if (plan.writes.length === 0) return;
    setSaving(true);
    const priceLeft = { ...priceDrafts };
    const stockLeft = { ...stockDrafts };
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
    setSaving(false);
    // After a refresh the server's versions are the truth; keep ours only when nothing refreshes.
    setVersions(done > 0 ? {} : seen);
    setPriceDrafts(priceLeft);
    setStockDrafts(stockLeft);
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
        className="overflow-x-auto"
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
              {sources.length === 0 ? <th scope="col" colSpan={colSpanStock} /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const retired = row.price?.retired === true;
              const special = row.price?.special;
              return (
                <tr key={row.variantId} className="border-t border-line align-top">
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
                    {retired ? (
                      <span className="block text-fg-muted">{t('price.retired')}</span>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showPrice ? (
        <p className="text-sm text-fg-muted">
          <a className="font-medium text-link underline" href={`/offers/${offerId}/prices`}>
            {t('catalog.variants-table.special-link')}
          </a>
        </p>
      ) : null}
      {canBulk ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={saving}
            disabled={saving || writes.length === 0}
            onClick={() => void save()}
          >
            {t('catalog.variants-table.save', { count: writes.length })}
          </Button>
          {writes.length === 0 ? null : (
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => {
                setPriceDrafts({});
                setStockDrafts({});
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
