'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  ListThumb,
  PageHeader,
  SaveBar,
  Select,
  TextField,
  toast,
  useUnsavedChangesGuard,
  type BadgeTone,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { currencySign, formatMinor } from '../price/money.ts';
import {
  customerPaysMinor,
  estimateFor,
  lastEstimateFor,
  useReceiveEstimates,
} from '../price/receive-estimates.ts';
import type { SourceView } from '../stock/types.ts';
import { useGuardedCall } from '../step-up/step-up.tsx';
import { AddOfferDialog } from './add-offer-dialog.tsx';
import { HANDLINGS } from './offer-edit-form.tsx';
import { focusFirstPrice, moveOnEnter } from './grid-keys.ts';
import { readable } from './format.ts';
import { sizeStatusOf, type QuickGroup, type SizeStatus } from './quick-entry-logic.ts';
import { sendSizeWrites } from './size-writes.ts';
import {
  savedPriceText,
  savedStockText,
  stockKey,
  writesOf,
  type TableRow,
} from './variants-table-logic.ts';

const STATUS_TONE: Record<SizeStatus, BadgeTone> = {
  ready: 'success',
  'needs-price': 'attention',
  'check-price': 'critical',
  'needs-stock': 'attention',
  'check-stock': 'critical',
  'out-of-stock': 'neutral',
  'not-sold': 'neutral',
};

/**
 * The quick entry table of new drafts (Offer page PR 5, design section 5): after "Sell these (N)"
 * every size of every new draft is one row of one table. Tab moves right, Enter moves down;
 * "Apply to all sizes" fills one product's stock. Nothing is saved until "Save N changes": the
 * writes go one by one through the same pricing and inventory routes as the Offer page, offer
 * after offer, and the server decides each. The drafts stay drafts; each is submitted on its own
 * Offer page.
 */
export function QuickEntryTable({
  groups,
  unreadable,
  more,
  sources,
  stockUnavailable = false,
  currency: marketCurrency,
  canEditPrice: mayEditPrice,
  canEditStock,
  canEstimate,
  csrfToken,
  marketId,
}: {
  readonly groups: readonly QuickGroup[];
  /** Drafts that could not be read; they wait in Drafts. */
  readonly unreadable: number;
  /** Drafts made beyond the table's limit; they wait in Drafts. */
  readonly more: number;
  readonly sources: readonly SourceView[];
  /** The stock locations could not be read: stock is not shown and Status does not judge it. */
  readonly stockUnavailable?: boolean;
  /** The Market currency; null when the seller may not see prices (no price columns then). */
  readonly currency: string | null;
  readonly canEditPrice: boolean;
  readonly canEditStock: boolean;
  readonly canEstimate: boolean;
  readonly csrfToken: string;
  /** The panel's Market: the photos of the Add offer search come from its image route. */
  readonly marketId: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const guarded = useGuardedCall();
  const showPrice = marketCurrency !== null;
  const currency = marketCurrency ?? '';
  const canEditPrice = mayEditPrice && showPrice;
  const showReceive = canEstimate && showPrice;
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<Record<string, Record<string, number | null>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeId, setActiveId] = useState(groups[0]?.offerId ?? '');
  const [applyValue, setApplyValue] = useState('');
  const [applySource, setApplySource] = useState(sources[0]?.id ?? '');
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const tableRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  // The cursor starts on the first price, where the seller types first.
  useEffect(() => {
    focusFirstPrice(tableRef.current);
  }, []);
  // After a failed save the first invalid field takes focus, so its message is read out.
  useEffect(() => {
    if (focusTick > 0)
      tableRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  const plans = groups.map((group) => ({
    group,
    ...writesOf(group.rows, sources, currency, priceDrafts, stockDrafts),
  }));
  const changeCount = plans.reduce(
    (sum, plan) => sum + plan.writes.length + plan.invalid.length,
    0,
  );
  const canSave = canEditPrice || canEditStock;
  const sourceIds = sources.map((source) => source.id);
  const statusOf = (row: TableRow) =>
    sizeStatusOf(row, currency, sourceIds, priceDrafts, stockDrafts, showPrice);
  const liveRows = groups.flatMap((group) =>
    group.rows.filter((row) => row.price?.retired !== true),
  );
  const readyCount = liveRows.filter((row) => statusOf(row) === 'ready').length;
  const active = groups.find((group) => group.offerId === activeId) ?? groups[0];

  const guard = useUnsavedChangesGuard(
    canSave && changeCount > 0 && !leaving,
    {
      title: t('settings.leave.title'),
      message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
      stay: t('settings.leave.stay'),
      leave: t('settings.leave.leave'),
    },
    { count: changeCount, page: t('catalog.quick-entry.title') },
  );

  function applyToAll() {
    if (active === undefined) return;
    const value = applyValue.trim();
    if (value === '' || sources.length === 0) return;
    const next = { ...stockDrafts };
    let count = 0;
    for (const row of active.rows) {
      if (row.price?.retired === true) continue;
      next[stockKey(row.variantId, applySource)] = value;
      count += 1;
    }
    setStockDrafts(next);
    setApplyNote(t('catalog.quick-entry.applied', { count, product: active.name }));
  }

  /** Saves every changed cell; true when nothing is left to save. */
  async function save(): Promise<boolean> {
    if (busy.current) return false;
    const found: Record<string, string> = {};
    for (const plan of plans) {
      for (const item of plan.invalid) {
        found[item.key] =
          item.kind === 'price' ? t('price.error.invalid') : t('stock.levels.error.invalid');
      }
    }
    setErrors(found);
    const toSend = plans.filter((plan) => plan.writes.length > 0);
    if (toSend.length === 0) {
      if (Object.keys(found).length > 0) setFocusTick((n) => n + 1);
      return Object.keys(found).length === 0;
    }
    busy.current = true;
    setSaving(true);
    // What was sent: a cell typed again while the save runs keeps its newer text.
    const sentPrices = priceDrafts;
    const sentStocks = stockDrafts;
    const savedPrices: string[] = [];
    const savedStocks: string[] = [];
    const seenAll = { ...versions };
    let done = 0;
    let stopped = false;
    let waitSeconds: number | null = null;
    for (const plan of toSend) {
      const sent = await sendSizeWrites({
        offerId: plan.group.offerId,
        rows: plan.group.rows,
        writes: plan.writes,
        currency,
        versions: versions[plan.group.offerId] ?? {},
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
        return false;
      }
      Object.assign(found, sent.found);
      savedPrices.push(...sent.savedPrices);
      savedStocks.push(...sent.savedStocks);
      seenAll[plan.group.offerId] = sent.seen;
      done += sent.done;
      if (sent.stopped) {
        stopped = true;
        waitSeconds = sent.waitSeconds;
        break;
      }
    }
    busy.current = false;
    setSaving(false);
    // After a refresh the server's versions are the truth; keep ours only when nothing refreshes.
    setVersions(done > 0 ? {} : seenAll);
    setPriceDrafts((old) => withoutSaved(old, savedPrices, sentPrices));
    setStockDrafts((old) => withoutSaved(old, savedStocks, sentStocks));
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
    if (done > 0) router.refresh();
    return failed === 0 && !stopped;
  }

  /** "Save drafts": saves what changed, then opens the Drafts tab where each is submitted. */
  async function saveAndLeave() {
    const ok = changeCount === 0 ? true : await save();
    if (!ok) return;
    flushSync(() => setLeaving(true));
    router.push('/offers?view=drafts');
  }

  function discard() {
    setApplyNote(null);
    setPriceDrafts({});
    setStockDrafts({});
    setErrors({});
  }

  const sizeCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const title = t('catalog.quick-entry.heading', {
    products: groups.length,
    sizes: sizeCount,
  });
  const header = (
    <PageHeader
      title={title}
      className="mb-4"
      actions={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              // A new search leaves this page: typed prices are saved or discarded first.
              if (changeCount > 0) toast.info(t('catalog.quick-entry.save-first'));
              else setSearchOpen(true);
            }}
          >
            {t('catalog.quick-entry.back-to-search')}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={() => void saveAndLeave()}>
            {t('catalog.quick-entry.save-drafts')}
          </Button>
        </>
      }
    />
  );
  const waiting = more + unreadable;
  const notices =
    waiting > 0 ? (
      <Banner tone="info">
        <p>{t('catalog.quick-entry.in-drafts', { count: waiting })}</p>
        <a className="font-medium text-link underline" href="/offers?view=drafts">
          {t('catalog.quick-entry.open-drafts')}
        </a>
      </Banner>
    ) : null;
  const dialog = searchOpen ? (
    <AddOfferDialog
      open
      csrfToken={csrfToken}
      marketId={marketId}
      onClose={() => setSearchOpen(false)}
      navigate={(path) => {
        setSearchOpen(false);
        router.push(path);
      }}
    />
  ) : null;

  if (groups.length === 0) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-4">
          {notices}
          <Card>
            <p className="text-fg-muted">{t('catalog.quick-entry.none')}</p>
          </Card>
        </div>
        {dialog}
      </>
    );
  }

  // Product, Size, price, "You receive", one stock column per location, Status (rem): the table
  // scrolls inside its card below this width, never the page.
  // 45 rem with one location fits a 768 px window beside the panel's gutters.
  const minRem = 11 + 4.5 + (showPrice ? 8 : 0) + (showReceive ? 6.5 : 0) + sources.length * 6 + 7;
  return (
    <>
      {header}
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void save();
        }}
      >
        {notices}
        {stockUnavailable ? (
          <Banner tone="critical">
            <p>{t('catalog.quick-entry.stock-unavailable')}</p>
          </Banner>
        ) : null}
        {canEditStock && sources.length === 0 && !stockUnavailable ? (
          <Banner tone="attention">
            <p>{t('stock.levels.no-locations')}</p>
            <a className="font-medium text-link underline" href="/settings/stock-locations">
              {t('stock.title')}
            </a>
          </Banner>
        ) : null}
        <Card>
          <div
            ref={tableRef}
            // Relative: the hidden labels inside are clipped by the scroll, not by the page. The
            // padding keeps a focused field's ring inside the scroll box.
            className="relative scroll-p-3 overflow-x-auto p-1.5"
            role="region"
            aria-label={title}
            tabIndex={0}
          >
            <table
              className="w-full text-start text-sm"
              style={{ minWidth: `${minRem}rem` }}
              onKeyDown={moveOnEnter}
            >
              <thead>
                <tr>
                  <th scope="col" className="p-2 font-medium">
                    {t('catalog.quick-entry.product')}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {t('catalog.variants-table.variant')}
                  </th>
                  {showPrice ? (
                    <th scope="col" className="p-2 font-medium">
                      {t('catalog.variants-table.your-price')}
                    </th>
                  ) : null}
                  {showReceive ? (
                    <th scope="col" className="p-2 font-medium">
                      {t('catalog.variants-table.receive.column')}
                    </th>
                  ) : null}
                  {sources.map((source) => (
                    <th key={source.id} scope="col" className="p-2 font-medium">
                      {sources.length > 1
                        ? t('catalog.quick-entry.stock-at', { location: source.name })
                        : t('catalog.quick-entry.stock')}
                    </th>
                  ))}
                  <th scope="col" className="p-2 font-medium">
                    {t('catalog.quick-entry.status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <GroupRows
                    key={group.offerId}
                    group={group}
                    sources={sources}
                    currency={currency}
                    locale={locale}
                    showPrice={showPrice}
                    showReceive={showReceive}
                    canEditPrice={canEditPrice}
                    canEditStock={canEditStock}
                    priceDrafts={priceDrafts}
                    stockDrafts={stockDrafts}
                    errors={errors}
                    statusOf={statusOf}
                    onPrice={(variantId, value) =>
                      setPriceDrafts((old) => ({ ...old, [variantId]: value }))
                    }
                    onStock={(key, value) => setStockDrafts((old) => ({ ...old, [key]: value }))}
                    onFocusGroup={() => {
                      if (activeId !== group.offerId) {
                        setActiveId(group.offerId);
                        setApplyNote(null);
                      }
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-fg-muted">{t('catalog.quick-entry.keys')}</p>
          {showPrice ? (
            <p className="mt-1 text-sm text-fg-muted">
              {t('catalog.variants-table.price-note', { currency })}
            </p>
          ) : null}
          {showReceive ? (
            <p className="mt-1 text-sm text-fg-muted">
              {t('catalog.variants-table.receive.promotions')}
            </p>
          ) : null}
        </Card>
        {active === undefined ? null : (
          <div
            className="flex flex-col gap-3 rounded-md border border-line bg-info-bg p-4"
            role="group"
            aria-label={t('catalog.quick-entry.all-sizes', { product: active.name })}
          >
            {canEditStock && sources.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                {groups.length > 1 ? (
                  <Select
                    name="apply-offer"
                    label={t('catalog.quick-entry.product')}
                    value={active.offerId}
                    options={groups.map((group) => ({ value: group.offerId, label: group.name }))}
                    onChange={(event) => {
                      setActiveId(event.target.value);
                      setApplyNote(null);
                    }}
                  />
                ) : null}
                {sources.length > 1 ? (
                  <Select
                    name="apply-source"
                    label={t('catalog.variants-table.location')}
                    value={applySource}
                    options={sources.map((source) => ({ value: source.id, label: source.name }))}
                    onChange={(event) => setApplySource(event.target.value)}
                  />
                ) : null}
                <div className="w-40">
                  <TextField
                    name="apply-stock"
                    label={t('catalog.quick-entry.stock-for-all')}
                    inputMode="numeric"
                    value={applyValue}
                    onChange={(event) => setApplyValue(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter fills the column; it does not save the table.
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      applyToAll();
                    }}
                  />
                </div>
                <Button
                  variant="secondary"
                  disabled={applyValue.trim() === ''}
                  onClick={applyToAll}
                >
                  {t('catalog.quick-entry.apply')}
                </Button>
              </div>
            ) : null}
            <p className="text-sm text-fg-muted" role="status">
              {applyNote}
            </p>
            <p className="text-sm">
              {t('catalog.quick-entry.defaults', {
                condition: readable(active.conditionCode),
                handling:
                  active.handling === null
                    ? t('catalog.quick-entry.handling-none')
                    : t(`catalog.offer.handling-value.${handlingKey(active.handling)}`),
              })}{' '}
              {active.handling === null ? null : <>{t('catalog.quick-entry.defaults-copied')} </>}
              <a
                className="font-medium text-link underline"
                href={`/offers/${active.offerId}/edit`}
              >
                {t('catalog.quick-entry.change', { product: active.name })}
              </a>
            </p>
          </div>
        )}
        {canSave ? (
          <SaveBar
            count={changeCount}
            summary={`${t('settings.bar.summary', { count: changeCount })} · ${t('catalog.quick-entry.ready', { ready: readyCount, total: liveRows.length })}`}
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
        ) : null}
      </form>
      {canSave && changeCount > 0 ? guard.dialog : null}
      {dialog}
    </>
  );
}

const handlingKey = (value: string) =>
  (HANDLINGS as readonly string[]).includes(value) ? value : 'unknown';

/** The drafts left after a save: a saved cell goes, unless it was typed again meanwhile. */
function withoutSaved(
  drafts: Readonly<Record<string, string>>,
  saved: readonly string[],
  sent: Readonly<Record<string, string>>,
): Record<string, string> {
  const next = { ...drafts };
  for (const key of saved) if (next[key] === sent[key]) delete next[key];
  return next;
}

/** The rows of one new draft, with its own "You receive (est.)" read. */
function GroupRows({
  group,
  sources,
  currency,
  locale,
  showPrice,
  showReceive,
  canEditPrice,
  canEditStock,
  priceDrafts,
  stockDrafts,
  errors,
  statusOf,
  onPrice,
  onStock,
  onFocusGroup,
}: {
  readonly group: QuickGroup;
  readonly sources: readonly SourceView[];
  readonly currency: string;
  readonly locale: string;
  readonly showPrice: boolean;
  readonly showReceive: boolean;
  readonly canEditPrice: boolean;
  readonly canEditStock: boolean;
  readonly priceDrafts: Readonly<Record<string, string>>;
  readonly stockDrafts: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly statusOf: (row: TableRow) => SizeStatus;
  readonly onPrice: (variantId: string, value: string) => void;
  readonly onStock: (key: string, value: string) => void;
  readonly onFocusGroup: () => void;
}) {
  const t = useTranslations();
  const customerPays = Object.fromEntries(
    group.rows.map((row) => [
      row.variantId,
      showReceive ? customerPaysMinor(row.price, priceDrafts[row.variantId], currency) : null,
    ]),
  );
  const estimates = useReceiveEstimates(group.offerId, customerPays, showReceive);

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

  if (group.rows.length === 0) {
    return (
      <tr className="border-t border-line align-middle">
        <td className="p-2" colSpan={99}>
          <ProductCell group={group} />
          <span className="mt-1 block text-fg-muted">{t('price.no-variants')}</span>
        </td>
      </tr>
    );
  }
  return (
    <>
      {group.rows.map((row, index) => {
        const retired = row.price?.retired === true;
        const status = statusOf(row);
        return (
          <tr
            key={row.variantId}
            className={`align-middle ${index === 0 ? 'border-t border-line' : ''}`}
            onFocus={onFocusGroup}
          >
            <td className="p-2">
              {/* Every row keeps the cell, so Enter finds the same column on the next row. */}
              {index === 0 ? (
                <ProductCell group={group} />
              ) : (
                <span className="sr-only">{group.name}</span>
              )}
            </td>
            <th scope="row" className="p-2 font-normal">
              {row.label}
            </th>
            {showPrice ? (
              <td className="p-2 [&_label]:sr-only">
                {canEditPrice && !retired ? (
                  <div className="w-28">
                    <TextField
                      name={`price-${row.variantId}`}
                      prefix={currencySign(currency, locale)}
                      framedPrefix
                      label={t('price.field', { currency })}
                      aria-label={t('catalog.quick-entry.price-for', {
                        product: group.name,
                        size: row.label,
                      })}
                      inputMode="decimal"
                      value={priceDrafts[row.variantId] ?? savedPriceText(row, currency)}
                      error={errors[row.variantId]}
                      onChange={(event) => onPrice(row.variantId, event.target.value)}
                    />
                  </div>
                ) : row.price?.inForce == null ? (
                  <Dash />
                ) : (
                  <span>{formatMinor(row.price.inForce.amount, currency, locale)}</span>
                )}
              </td>
            ) : null}
            {showReceive ? (
              <td className="p-2 tabular-nums">{receiveCell(row.variantId)}</td>
            ) : null}
            {sources.map((source) => {
              const key = stockKey(row.variantId, source.id);
              const cell = row.stock[source.id];
              return (
                <td key={source.id} className="p-2 [&_label]:sr-only">
                  {canEditStock && !retired ? (
                    <div className="w-20">
                      <TextField
                        name={`onHand-${key}`}
                        label={t('stock.levels.on-hand')}
                        aria-label={t('catalog.quick-entry.stock-for', {
                          product: group.name,
                          size: row.label,
                          location: source.name,
                        })}
                        inputMode="numeric"
                        value={stockDrafts[key] ?? savedStockText(row, source.id)}
                        error={errors[key]}
                        onChange={(event) => onStock(key, event.target.value)}
                      />
                    </div>
                  ) : cell === undefined ? (
                    <Dash />
                  ) : (
                    <span>{cell.onHand}</span>
                  )}
                </td>
              );
            })}
            <td className="p-2">
              <Badge tone={STATUS_TONE[status]}>{t(`catalog.quick-entry.state.${status}`)}</Badge>
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** The product of a draft: its thumbnail and name, linked to its Offer page. */
function ProductCell({ group }: { readonly group: QuickGroup }) {
  return (
    <span className="flex items-center gap-3">
      <ListThumb src={group.thumb} />
      <span className="min-w-0">
        <a
          className="block break-words font-medium text-link underline"
          href={`/offers/${group.offerId}`}
        >
          {group.name}
        </a>
        {group.productCode === null ? null : (
          <span className="block font-mono text-xs text-fg-muted" dir="ltr">
            {group.productCode}
          </span>
        )}
      </span>
    </span>
  );
}

/** An empty value: an em dash in the muted colour. */
function Dash() {
  return <span className="text-fg-muted">{'—'}</span>;
}
