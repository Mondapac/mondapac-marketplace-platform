'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { lineLimit } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { useStore } from '../shell/store-context.tsx';
import type { CartItem } from '../storefront/types.ts';
import { AccountFrame, LineThumb } from './account-area.tsx';
import { useAccount } from './account-state.tsx';
import { AcField } from './fields.tsx';

/**
 * Saved lists: "Saved for later" (from the cart: Move to cart, Remove) and the buyer's named lists
 * (Add to cart, Add all to cart), then Create a list. On a phone the buttons sit under the item.
 */
export function AccountLists() {
  const t = useTranslations('account.lists');
  const title = useTranslations('account.titles')('lists');
  const { saved, moveToCart, removeSaved, cartSource, add } = useStore();
  const { lists, createList } = useAccount();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const createButton = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (!creating && back.current) createButton.current?.focus({ preventScroll: true });
    back.current = creating;
  }, [creating]);
  const addOne = (id: string) => {
    const item = cartSource.items[id];
    if (item) add(id, item.price, lineLimit(item.lowStock));
  };

  return (
    <AccountFrame title={title}>
      <section className="ac-card" aria-labelledby="list-saved">
        <h2 id="list-saved">{t('saved', { count: saved.length })}</h2>
        {saved.length === 0 ? (
          <p>{t('saved-empty')}</p>
        ) : (
          <div>
            {saved.map((id) => (
              <ListRow key={id} item={cartSource.items[id]}>
                {(itemName) => (
                  <>
                    <button
                      className="btn ghost"
                      type="button"
                      aria-label={t('move-label', { name: itemName })}
                      onClick={() => moveToCart(id)}
                    >
                      {t('move')}
                    </button>
                    <button
                      className="lnk"
                      type="button"
                      aria-label={t('remove-label', { name: itemName })}
                      onClick={() => removeSaved(id)}
                    >
                      {t('remove')}
                    </button>
                  </>
                )}
              </ListRow>
            ))}
          </div>
        )}
      </section>
      {lists.map((list) => (
        <section className="ac-card" key={list.id} aria-labelledby={`list-${list.id}`}>
          <div className="ac-row">
            <h2 id={`list-${list.id}`}>
              {t('list', { name: list.name, count: list.offerIds.length })}
            </h2>
            {list.offerIds.length > 0 ? (
              <DoneButton
                label={t('add-all')}
                done={t('added-all')}
                onClick={() => list.offerIds.forEach(addOne)}
              />
            ) : null}
          </div>
          {list.offerIds.length === 0 ? (
            <p>{t('list-empty')}</p>
          ) : (
            <div>
              {list.offerIds.map((id) => (
                <ListRow key={id} item={cartSource.items[id]}>
                  {(itemName) => (
                    <DoneButton
                      label={t('add')}
                      done={t('added')}
                      aria={t('add-label', { name: itemName })}
                      onClick={() => addOne(id)}
                    />
                  )}
                </ListRow>
              ))}
            </div>
          )}
        </section>
      ))}
      {creating ? (
        <section className="ac-card" aria-labelledby="list-new">
          <h2 id="list-new">{t('new')}</h2>
          <form
            className="ac-f"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) createList(name.trim());
              setName('');
              setCreating(false);
            }}
          >
            <AcField
              label={t('name')}
              placeholder={t('name-hint')}
              value={name}
              onText={setName}
              maxLength={60}
              autoFocus
            />
            <div className="ac-acts">
              <button className="btn" type="submit">
                {t('create-save')}
              </button>
              <button className="btn ghost" type="button" onClick={() => setCreating(false)}>
                {t('cancel')}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <div>
          <button
            ref={createButton}
            className="btn ghost"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t('create')}
          </button>
        </div>
      )}
    </AccountFrame>
  );
}

function ListRow({
  item,
  children,
}: {
  readonly item: CartItem | undefined;
  readonly children: (name: string) => ReactNode;
}) {
  const t = useTranslations('account.lists');
  const locale = useLocale();
  const { cartSource } = useStore();
  if (!item)
    return (
      <div className="ac-li">
        <LineThumb category="grid" />
        <div>
          <b>{t('unavailable')}</b>
        </div>
      </div>
    );
  return (
    <div className="ac-li">
      <LineThumb imageUrl={item.imageUrl} category={item.category} />
      <div>
        <b>{item.name}</b>
        <small>{cartSource.sellers[item.sellerId]?.name}</small>
        <small className="num">{formatMoney(item.price, locale)}</small>
      </div>
      <div className="ac-acts">{children(item.name)}</div>
    </div>
  );
}

/** A button that says it is done after one press (Add to cart, Add all to cart). */
function DoneButton({
  label,
  done,
  aria,
  onClick,
}: {
  readonly label: string;
  readonly done: string;
  readonly aria?: string;
  readonly onClick: () => void;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      className="btn ghost"
      type="button"
      aria-label={pressed ? undefined : aria}
      disabled={pressed}
      onClick={() => {
        onClick();
        setPressed(true);
      }}
    >
      <span aria-live="polite">{pressed ? done : label}</span>
    </button>
  );
}
