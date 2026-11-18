'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import * as api from '../account/customer-api.ts';
import { formatMoney } from '../format/money.ts';
import { useStore } from '../shell/store-context.tsx';
import { productHref } from '../storefront/links.ts';
import type { CardMoney } from './card-values.ts';
import type {
  BasketLineView,
  BasketOptionView,
  BasketProposalView,
  CartAction,
  CartSummary,
} from './cart-cards.ts';

// The cart cards of the assistant (stage 1, S1-F1). The cards only propose: nothing reaches the cart
// until the buyer clicks, and then it goes through the cart's own routes with the buyer's session
// and CSRF token, exactly as the product page does (ADR-0019 R4). Every figure shown is from the
// card; the widget only multiplies a price by a quantity the buyer edits.

type Outcome = 'ok' | 'refused' | 'failed';

/** What a cart route answered, as the card words it. */
export function outcomeOf(result: api.ApiResult<true>): Outcome {
  if (result.kind === 'ok') return 'ok';
  return result.kind === 'invalid' ? 'refused' : 'failed';
}

/** Cart facts and the "move the other store's lines away" step, shared by the two add cards. */
function useCartGuard() {
  const { live, cart, cartSource, saveForLater, removeLine, refreshCart } = useStore();
  // The newest cart on screen: a step that waits for the API reads it again afterwards.
  const latest = useRef({ cart, items: cartSource.items });
  latest.current = { cart, items: cartSource.items };
  /** True when the cart holds a line that is not of this store (or whose store is not known). */
  const holdsOtherStore = (sellerId: string | null): boolean => {
    const keys = Object.keys(latest.current.cart);
    return (
      keys.length > 0 &&
      keys.some((key) => {
        const seller = latest.current.items[key]?.sellerId ?? null;
        return seller === null || seller !== sellerId;
      })
    );
  };
  /** Waits for the API's cart to reach the screen (a render after the read). */
  const settle = async () => {
    await refreshCart();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /**
   * Moves every current line to saved items or removes it, waits until the API has it, and says
   * whether the cart is now empty. The add runs only then, so a failed move never adds beside it.
   */
  const moveAway = async (how: 'save' | 'remove'): Promise<boolean> => {
    for (const key of Object.keys(latest.current.cart)) {
      if (how === 'save') saveForLater(key);
      else removeLine(key);
    }
    await settle();
    return Object.keys(latest.current.cart).length === 0;
  };
  return { live, holdsOtherStore, moveAway, settle, refreshCart };
}

function useMoney() {
  const locale = useLocale();
  return (value: CardMoney) => formatMoney(value, locale);
}

const times = (price: CardMoney, quantity: number): CardMoney => ({
  amount: price.amount * quantity,
  currency: price.currency,
});

/** The choice a single-store cart asks for before another store's items go in. */
function StoreChoice({
  busy,
  onChoose,
  onCancel,
}: {
  readonly busy: boolean;
  readonly onChoose: (how: 'save' | 'remove') => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('assistant');
  return (
    <div className="ascc-choice" role="group" aria-label={t('cart-other-store-title')}>
      <p>{t('cart-other-store')}</p>
      <div className="ascc-acts">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => onChoose('save')}
        >
          {t('cart-other-store-save')}
        </button>
        <button
          type="button"
          className="btn small alt"
          disabled={busy}
          onClick={() => onChoose('remove')}
        >
          {t('cart-other-store-remove')}
        </button>
        <button type="button" className="btn small ghost" disabled={busy} onClick={onCancel}>
          {t('cart-cancel')}
        </button>
      </div>
    </div>
  );
}

const outcomeKey = (outcome: Outcome) => (outcome === 'refused' ? 'cart-refused' : 'cart-failed');

/** A proposed cart change: add, set a quantity or remove, with one button the buyer must press. */
export function CartActionCardView({
  card,
  onNavigate,
}: {
  readonly card: CartAction;
  readonly onNavigate?: () => void;
}) {
  const t = useTranslations('assistant');
  const money = useMoney();
  const guard = useCartGuard();
  const [unitAt, setUnitAt] = useState(() =>
    Math.max(
      0,
      card.units.findIndex((unit) => (unit.addable ?? 1) > 0),
    ),
  );
  const lineUnit =
    card.action === 'add' ? undefined : card.units.find((u) => u.lineId === card.lineId);
  const unit = lineUnit ?? card.units[unitAt] ?? card.units[0]!;
  const ceiling =
    card.action === 'add'
      ? Math.max(0, unit.addable ?? card.quantity)
      : Math.max(1, unit.maxQuantity ?? card.quantity);
  const [wanted, setWanted] = useState(card.quantity);
  const quantity =
    card.action === 'remove' ? 0 : Math.min(Math.max(1, wanted), Math.max(1, ceiling));
  const [step, setStep] = useState<'idle' | 'choose' | 'busy' | 'done' | Outcome>('idle');
  const busy = useRef(false);
  const uid = useId();

  const submit = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setStep('busy');
    try {
      let result: api.ApiResult<true>;
      if (card.action === 'add')
        result = await api.addCartItem(card.offerId, unit.variantId, quantity);
      else if (card.action === 'set-quantity' && card.lineId !== null)
        result = await api.setCartLineQuantity(card.lineId, quantity);
      else if (card.lineId !== null) result = await api.removeCartLine(card.lineId);
      else {
        setStep('failed');
        return;
      }
      const outcome = outcomeOf(result);
      await guard.refreshCart();
      setStep(outcome === 'ok' ? 'done' : outcome);
    } finally {
      busy.current = false;
    }
  }, [card, unit.variantId, quantity, guard]);

  const press = async () => {
    if (card.action === 'add' && card.cartMode === 'single-store') {
      setStep('busy');
      // `otherStore` unknown (null) or true is never "safe": read the cart again before deciding.
      if (card.otherStore !== false) await guard.settle();
      if (guard.holdsOtherStore(card.sellerId)) {
        setStep('choose');
        return;
      }
    }
    await submit();
  };

  const choose = async (how: 'save' | 'remove') => {
    setStep('busy');
    try {
      if (!(await guard.moveAway(how))) {
        setStep('failed');
        return;
      }
    } catch {
      setStep('failed');
      return;
    }
    await submit();
  };

  const name = card.name ?? t('cart-this-product');
  const title = t(`cart-action-${card.action}`, { name });
  const canAdd = card.action !== 'add' || ceiling > 0;
  const addNotPossible = card.action === 'add' && (card.cartFull === true || ceiling === 0);
  const live = guard.live;

  return (
    <section className="ascc" aria-label={title}>
      <div className="ascc-h">
        {card.productId !== null ? (
          <Link href={productHref(card.productId, name)} onClick={onNavigate}>
            {name}
          </Link>
        ) : (
          <b>{name}</b>
        )}
        {card.sellerName ? <small>{t('sold-by', { seller: card.sellerName })}</small> : null}
      </div>
      <p className="ascc-t">{title}</p>

      {card.units.length > 1 && card.action === 'add' ? (
        <fieldset className="ascc-units" disabled={step === 'busy' || step === 'done'}>
          <legend>{t('cart-pick-unit')}</legend>
          {card.units.map((option, at) => (
            <label key={option.variantId} className="ascc-unit">
              <input
                type="radio"
                name={`unit-${uid}`}
                checked={at === unitAt}
                disabled={(option.addable ?? 1) === 0}
                onChange={() => setUnitAt(at)}
              />
              <span>
                <bdi>{option.label ?? t('cart-unit-default')}</bdi>
              </span>
              {option.price === null ? null : <b className="num">{money(option.price)}</b>}
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="ascc-price num">
          {unit.label ? (
            <span>
              <bdi>{unit.label}</bdi>
            </span>
          ) : null}
          {unit.price === null ? null : <b>{money(unit.price)}</b>}
          {unit.taxInclusive === true ? <small>{t('including-gst')}</small> : null}
        </div>
      )}

      {card.action !== 'remove' && canAdd ? (
        <div className="ascc-qty">
          <span id={`q-${uid}`}>{t('cart-quantity')}</span>
          <div role="group" aria-labelledby={`q-${uid}`}>
            <button
              type="button"
              aria-label={t('cart-less')}
              disabled={quantity <= 1 || step === 'busy' || step === 'done'}
              onClick={() => setWanted(quantity - 1)}
            >
              −
            </button>
            <output className="num" aria-live="polite">
              {quantity}
            </output>
            <button
              type="button"
              aria-label={t('cart-more')}
              disabled={quantity >= ceiling || step === 'busy' || step === 'done'}
              onClick={() => setWanted(quantity + 1)}
            >
              +
            </button>
          </div>
          {card.limited || quantity >= ceiling ? (
            <small>{t('cart-max', { max: ceiling })}</small>
          ) : null}
        </div>
      ) : null}

      {card.action === 'remove' && card.currentQuantity !== null ? (
        <small>{t('cart-in-cart', { count: card.currentQuantity })}</small>
      ) : null}

      {addNotPossible ? (
        <p className="asnote">{card.cartFull === true ? t('cart-full') : t('cart-none-left')}</p>
      ) : null}

      {step === 'choose' ? (
        <StoreChoice
          busy={false}
          onChoose={(how) => void choose(how)}
          onCancel={() => setStep('idle')}
        />
      ) : step === 'done' ? (
        <p className="ascc-ok" role="status">
          {t(`cart-done-${card.action}`)}{' '}
          <Link href="/cart" onClick={onNavigate}>
            {t('page-cart')}
          </Link>
        </p>
      ) : (
        <>
          {step === 'refused' || step === 'failed' ? (
            <p className="ascc-err" role="alert">
              {t(outcomeKey(step))}
            </p>
          ) : null}
          {!live ? (
            <p className="asnote">{t('cart-unavailable')}</p>
          ) : addNotPossible ? null : (
            <div className="ascc-acts">
              <button
                type="button"
                className={card.action === 'remove' ? 'btn small alt' : 'btn small'}
                disabled={step === 'busy'}
                onClick={() => void press()}
              >
                {step === 'busy'
                  ? t('cart-working')
                  : step === 'refused' || step === 'failed'
                    ? t('retry')
                    : t(`cart-button-${card.action}`)}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The buyer's own cart, read only: stores, lines, quantities and the totals the cart gave. */
export function CartSummaryCardView({
  card,
  onNavigate,
}: {
  readonly card: CartSummary;
  readonly onNavigate?: () => void;
}) {
  const t = useTranslations('assistant');
  const money = useMoney();
  if (card.lineCount === 0 || card.groups.length === 0) {
    return (
      <section className="ascc" aria-label={t('cart-summary-title')}>
        <p className="ascc-t">{t('cart-empty')}</p>
      </section>
    );
  }
  return (
    <section className="ascc" aria-label={t('cart-summary-title')}>
      <p className="ascc-t">{t('cart-summary-lines', { count: card.lineCount })}</p>
      {card.groups.map((group, at) => (
        <div className="ascc-group" key={group.sellerId ?? `g${at}`}>
          <div className="ascc-gh">
            <b>{group.sellerName ?? t('cart-store-unknown')}</b>
            {group.subtotal === null ? null : <span className="num">{money(group.subtotal)}</span>}
          </div>
          <ul className="ascc-lines">
            {group.lines.map((line) => (
              <li key={line.lineId}>
                <span>
                  {line.productId !== null && line.name ? (
                    <Link href={productHref(line.productId, line.name)} onClick={onNavigate}>
                      {line.name}
                    </Link>
                  ) : (
                    (line.name ?? t('cart-this-product'))
                  )}
                  {line.variantLabel ? (
                    <small>
                      {' · '}
                      <bdi>{line.variantLabel}</bdi>
                    </small>
                  ) : null}
                  {line.state === 'buyable' ? null : (
                    <small className="ascc-flag"> · {t(`cart-line-${line.state}`)}</small>
                  )}
                </span>
                <span className="num">
                  {t('cart-times', { count: line.quantity })}
                  {line.unitPrice === null
                    ? ''
                    : ` · ${money(times(line.unitPrice, line.quantity))}`}
                </span>
              </li>
            ))}
          </ul>
          {group.minimumOrder.state === 'below-minimum' && group.minimumOrder.minimum ? (
            <small className="ascc-flag">
              {t('cart-minimum', { amount: money(group.minimumOrder.minimum) })}
            </small>
          ) : null}
        </div>
      ))}
      {card.total === null ? null : (
        <div className="ascc-total">
          <span>{t('cart-total')}</span>
          <b className="num">{money(card.total)}</b>
        </div>
      )}
      {card.groups.some((group) => group.lines.some((line) => line.state !== 'buyable')) ? (
        <small className="asnote">{t('cart-total-unavailable')}</small>
      ) : null}
      <small className="asnote">{t('cart-delivery-at-checkout')}</small>
      <div className="ascc-acts">
        <Link className="btn small alt" href="/cart" onClick={onNavigate}>
          {t('page-cart')}
        </Link>
      </div>
    </section>
  );
}

interface Row {
  readonly itemIndex: number;
  readonly wish: string;
  readonly pick: BasketOptionView;
  readonly packs: number;
  /** Other products for this line, the picked one left out. */
  readonly choices: readonly BasketOptionView[];
  /** The line came from the uncertain list: the buyer chose it. */
  readonly chosen: boolean;
}

type RowState = Readonly<
  Record<
    number,
    { readonly pick?: BasketOptionView; readonly packs?: number; readonly off?: boolean }
  >
>;

const rowKey = (row: { pick: BasketOptionView; packs: number }) =>
  `${row.pick.offerId}:${row.pick.variantId ?? ''}:${row.packs}`;

/** The most packs of one line the planner ever proposes; the cart route has its own limit. */
const PACKS_MAX = 99;

/** The most packs of this product the buyer can set: the server's own ceiling, never above PACKS_MAX. */
const packsLimit = (option: BasketOptionView) =>
  Math.max(1, Math.min(PACKS_MAX, option.maxQuantity ?? PACKS_MAX));

/** A pick can go into the cart only with a sell unit and a ceiling above zero (0 = none to add). */
const addable = (option: BasketOptionView) => option.variantId !== null && option.maxQuantity !== 0;

/** A planned shopping list: edit packs, swap a product, drop a line, then add the whole list. */
export function BasketProposalCardView({
  card,
  onNavigate,
}: {
  readonly card: BasketProposalView;
  readonly onNavigate?: () => void;
}) {
  const t = useTranslations('assistant');
  const money = useMoney();
  const guard = useCartGuard();
  const [edits, setEdits] = useState<RowState>({});
  const [results, setResults] = useState<Readonly<Record<string, Outcome>>>({});
  const [step, setStep] = useState<'idle' | 'choose' | 'busy' | 'done'>('idle');
  const busy = useRef(false);

  const base = useMemo(() => {
    const rows: Row[] = card.stores.flatMap((store) =>
      store.lines.map((line: BasketLineView) => ({
        itemIndex: line.itemIndex,
        wish: line.wish,
        pick: line,
        packs: line.quantity ?? 1,
        choices: line.alternatives,
        chosen: false,
      })),
    );
    for (const line of card.uncertain)
      rows.push({
        itemIndex: line.itemIndex,
        wish: line.wish,
        pick: line.options[0]!,
        packs: line.options[0]?.quantity ?? 1,
        choices: line.options.slice(1),
        chosen: false,
      });
    return rows.filter((row) => row.pick !== undefined).sort((a, b) => a.itemIndex - b.itemIndex);
  }, [card]);

  // An uncertain line starts unselected: the planner was not sure, so the buyer picks it.
  const uncertainIndexes = useMemo(
    () => new Set(card.uncertain.map((line) => line.itemIndex)),
    [card],
  );
  const rows = base.map((row): Row & { readonly off: boolean } => {
    const edit = edits[row.itemIndex];
    const pick = edit?.pick ?? row.pick;
    const swapped = edit?.pick !== undefined;
    const choices = [row.pick, ...row.choices].filter((option) => option.offerId !== pick.offerId);
    return {
      ...row,
      pick,
      choices,
      // The planner's pack count (or the buyer's edit) never goes past what the product allows.
      packs: Math.min(
        edit?.packs ?? (swapped ? (pick.quantity ?? 1) : row.packs),
        packsLimit(pick),
      ),
      chosen: swapped,
      off: edit?.off ?? (uncertainIndexes.has(row.itemIndex) && !swapped),
    };
  });
  const active = rows.filter((row) => !row.off);
  const ready = active.filter((row) => addable(row.pick));
  const sellers = [...new Set(active.map((row) => row.pick.sellerId))];
  const oneStoreBroken = card.mode === 'single-store' && sellers.length > 1;
  const totals = useMemo(() => {
    if (ready.length === 0) return null;
    const currency = ready[0]!.pick.price.currency;
    if (ready.some((row) => row.pick.price.currency !== currency)) return null;
    const amount = ready.reduce((sum, row) => sum + row.pick.price.amount * row.packs, 0);
    if (!Number.isSafeInteger(amount)) return null;
    return { amount, currency, from: ready.some((row) => row.pick.priceFrom) };
  }, [ready]);

  const patch = (itemIndex: number, change: RowState[number]) =>
    setEdits((current) => ({ ...current, [itemIndex]: { ...current[itemIndex], ...change } }));

  const addAll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setStep('busy');
    const next: Record<string, Outcome> = {};
    try {
      for (const row of ready) {
        if (results[rowKey(row)] === 'ok') {
          next[rowKey(row)] = 'ok';
          continue;
        }
        const outcome = outcomeOf(
          await api.addCartItem(row.pick.offerId, row.pick.variantId!, row.packs),
        );
        next[rowKey(row)] = outcome;
        if (outcome === 'failed') break; // The cart is not reachable: do not hammer it.
      }
      setResults((current) => ({ ...current, ...next }));
      await guard.refreshCart();
    } finally {
      busy.current = false;
      setStep('done');
    }
  }, [ready, results, guard]);

  // The buyer is told why "+" is off: the product's own ceiling is reached.
  const uid = useId();
  const atCeiling = (row: { pick: BasketOptionView; packs: number }) =>
    row.pick.maxQuantity !== null && row.packs >= packsLimit(row.pick);

  const [moveFailed, setMoveFailed] = useState(false);
  const press = async () => {
    setMoveFailed(false);
    if (card.mode === 'single-store') {
      setStep('busy');
      await guard.settle();
      if (guard.holdsOtherStore(sellers[0] ?? null)) {
        setStep('choose');
        return;
      }
    }
    await addAll();
  };

  const chooseAway = async (how: 'save' | 'remove') => {
    setStep('busy');
    try {
      if (!(await guard.moveAway(how))) {
        setMoveFailed(true);
        setStep('idle');
        return;
      }
    } catch {
      setMoveFailed(true);
      setStep('idle');
      return;
    }
    await addAll();
  };

  // Only the lines still in the list count, and an edit (swap, packs) makes a new key, so an old
  // answer never stands for a different product or quantity.
  const failed = ready.filter((row) => (results[rowKey(row)] ?? 'ok') !== 'ok').length;
  const added = ready.filter((row) => results[rowKey(row)] === 'ok').length;
  const everyLineAdded = ready.length > 0 && ready.every((row) => results[rowKey(row)] === 'ok');
  const locked = step === 'busy';

  // Rows sit under the store of the product they now name, with that store's subtotal of the
  // lines in the list (the grand total below is the sum, so who is paid is never hidden).
  const groups = rows.reduce<{ sellerId: string; name: string | null; rows: typeof rows }[]>(
    (all, row) => {
      const at = all.find((group) => group.sellerId === row.pick.sellerId);
      if (at) at.rows = [...at.rows, row];
      else all.push({ sellerId: row.pick.sellerId, name: row.pick.sellerName, rows: [row] });
      return all;
    },
    [],
  );
  const subtotalOf = (list: typeof rows): CardMoney | null => {
    const on = list.filter((row) => !row.off);
    if (on.length === 0) return null;
    return {
      amount: on.reduce((sum, row) => sum + row.pick.price.amount * row.packs, 0),
      currency: on[0]!.pick.price.currency,
    };
  };
  const renderRow = (row: (typeof rows)[number]) => {
    const result = results[rowKey(row)];
    return (
      <li key={row.itemIndex} className={row.off ? 'ascb-off' : undefined}>
        <div className="ascb-main">
          <span className="ascb-wish">{row.wish}</span>
          <Link href={productHref(row.pick.productId, row.pick.name)} onClick={onNavigate}>
            {row.pick.name}
          </Link>
          <small>
            {row.pick.sellerName ?? t('cart-store-unknown')}
            {row.pick.sizeNote === 'larger' ? ` · ${t('basket-larger')}` : ''}
          </small>
          <span className="num ascb-price">
            {row.pick.priceFrom
              ? t('price-from', { price: money(row.pick.price) })
              : money(row.pick.price)}
            {row.pick.taxInclusive === true ? <small> · {t('including-gst')}</small> : null}
          </span>
        </div>
        {row.off ? (
          <>
            <small className="ascb-why">
              {uncertainIndexes.has(row.itemIndex) && edits[row.itemIndex]?.off === undefined
                ? t('basket-unsure')
                : t('basket-removed')}
            </small>
            <button
              type="button"
              className="aslk"
              disabled={locked}
              aria-label={`${t('basket-pick-this')}: ${row.pick.name}`}
              onClick={() => patch(row.itemIndex, { off: false })}
            >
              {t('basket-pick-this')}
            </button>
          </>
        ) : (
          <div className="ascb-edit">
            <div className="ascc-qty">
              <div
                role="group"
                aria-label={t('cart-quantity')}
                aria-describedby={atCeiling(row) ? `${uid}-max-${row.itemIndex}` : undefined}
              >
                <button
                  type="button"
                  aria-label={t('cart-less')}
                  disabled={locked || row.packs <= 1}
                  onClick={() => patch(row.itemIndex, { packs: row.packs - 1 })}
                >
                  −
                </button>
                <output className="num" aria-live="polite">
                  {row.packs}
                </output>
                <button
                  type="button"
                  aria-label={t('cart-more')}
                  disabled={locked || row.packs >= packsLimit(row.pick)}
                  onClick={() => patch(row.itemIndex, { packs: row.packs + 1 })}
                >
                  +
                </button>
              </div>
              {atCeiling(row) ? (
                <small id={`${uid}-max-${row.itemIndex}`} className="ascb-why">
                  {t('basket-max-packs', { count: packsLimit(row.pick) })}
                </small>
              ) : null}
            </div>
            <button
              type="button"
              className="aslk"
              disabled={locked}
              aria-label={`${t('basket-remove')}: ${row.pick.name}`}
              onClick={() => patch(row.itemIndex, { off: true })}
            >
              {t('basket-remove')}
            </button>
          </div>
        )}
        {!row.off && !addable(row.pick) ? (
          <small className="ascb-why">{t('basket-cannot-add')}</small>
        ) : null}
        {row.choices.length > 0 ? (
          <details className="ascb-swap">
            <summary>{t('basket-swap', { count: row.choices.length })}</summary>
            <ul>
              {row.choices.map((option) => (
                <li key={option.offerId}>
                  <span>
                    {option.name}
                    <small> · {option.sellerName ?? t('cart-store-unknown')}</small>
                  </span>
                  <span className="num">{money(option.price)}</span>
                  <button
                    type="button"
                    className="aslk"
                    disabled={locked}
                    aria-label={`${t('basket-use')}: ${option.name}`}
                    onClick={() =>
                      // A swap starts from the new product's own packs, not the old edit.
                      setEdits((current) => ({
                        ...current,
                        [row.itemIndex]: { pick: option },
                      }))
                    }
                  >
                    {t('basket-use')}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {result === 'ok' ? (
          <small className="ascc-ok">{t('basket-line-added')}</small>
        ) : result ? (
          <small className="ascc-err">{t(outcomeKey(result))}</small>
        ) : null}
      </li>
    );
  };

  return (
    <section className="ascc ascb" aria-label={t('basket-title', { count: card.itemCount })}>
      <p className="ascc-t">{t('basket-title', { count: card.itemCount })}</p>
      {groups.map((group) => {
        const subtotal = subtotalOf(group.rows);
        return (
          <div className="ascc-group" key={group.sellerId}>
            <div className="ascc-gh">
              <b>{group.name ?? t('cart-store-unknown')}</b>
              {subtotal === null ? null : <span className="num">{money(subtotal)}</span>}
            </div>
            <ul className="ascc-lines">{group.rows.map(renderRow)}</ul>
          </div>
        );
      })}

      {card.notFound.length > 0 ? (
        <div className="ascb-nf">
          <b>{t('basket-not-found')}</b>
          <ul>
            {card.notFound.map((line) => (
              <li key={line.itemIndex}>
                {line.wish}
                {line.reason === 'not-in-store' ? (
                  <small> · {t('basket-not-in-store')}</small>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {card.alternativeStores.length > 0 ? (
        <div className="ascb-nf">
          <b>{t('basket-other-stores')}</b>
          <ul>
            {card.alternativeStores.map((store) => (
              <li key={store.sellerId}>
                {store.sellerName ?? t('cart-store-unknown')}
                <small>
                  {' '}
                  · {t('basket-covers', { covered: store.covered, count: card.itemCount })} ·{' '}
                  {money(store.total)}
                </small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {totals === null ? null : (
        <div className="ascc-total">
          <span>{t('cart-total')}</span>
          <b className="num">
            {totals.from
              ? t('price-from', {
                  price: money({ amount: totals.amount, currency: totals.currency }),
                })
              : money({ amount: totals.amount, currency: totals.currency })}
          </b>
        </div>
      )}
      <small className="asnote">{t('cart-delivery-at-checkout')}</small>

      {step === 'choose' ? (
        <StoreChoice
          busy={false}
          onChoose={(how) => void chooseAway(how)}
          onCancel={() => setStep('idle')}
        />
      ) : (
        <>
          {oneStoreBroken ? <p className="asnote">{t('basket-one-store')}</p> : null}
          {step === 'done' && added > 0 ? (
            <p className="ascc-ok" role="status">
              {t('basket-added', { count: added })}{' '}
              <Link href="/cart" onClick={onNavigate}>
                {t('page-cart')}
              </Link>
            </p>
          ) : null}
          {moveFailed ? (
            <p className="ascc-err" role="alert">
              {t('cart-failed')}
            </p>
          ) : null}
          {failed > 0 ? (
            <p className="ascc-err" role="alert">
              {t('basket-some-failed', { count: failed })}
            </p>
          ) : null}
          {!guard.live ? (
            <p className="asnote">{t('cart-unavailable')}</p>
          ) : (
            <div className="ascc-acts">
              <button
                type="button"
                className="btn small"
                disabled={locked || ready.length === 0 || oneStoreBroken || everyLineAdded}
                onClick={() => void press()}
              >
                {locked
                  ? t('cart-working')
                  : failed > 0
                    ? t('basket-retry')
                    : t('basket-add-all', { count: ready.length, total: card.itemCount })}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
